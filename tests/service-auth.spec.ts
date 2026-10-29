/**
 * HANDS-02A — trusted execution entry tests.
 *
 * Real service instances (in-process handle()), real PowerShell executions,
 * isolated workspaces and isolated ledger data dirs. Verifies the transport
 * contract end to end against the ZhiYi resource-HMAC mirror: signatures,
 * timestamps, nonces, idempotency binding, trusted admission, inline-authority
 * rejection, loopback policy, and the no-secrets-anywhere invariant.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HandsService } from '../hands/service.ts'
import { HandsCredentialStore } from '../hands/keys.ts'
import { TrustedGrantStore, issueTestGrant } from '../hands/grant-store.ts'
import { callHandle, executionEnvelope, signRequest, type SignedRequest } from './service-client.ts'

// Real-looking secrets; the leak-scan asserts they appear NOWHERE outside.
const SECRET_A = 'hands-e2e-secret-alpha-4f9c2b7d'
const SECRET_B = 'hands-e2e-secret-beta-88aa11ee'

const CRED_A = 'cred-alpha'
const CRED_B = 'cred-beta'
const WS_ID = 'ws-hands-02a'

let workspace: string
let dataDir: string
let outsideRoot: string
let service: HandsService
let grants: TrustedGrantStore
const bodies: unknown[] = []

const GRANT_ALL = 'grant_all'
const GRANT_FS_ONLY = 'grant_fs_only'
const GRANT_REVOKED = 'grant_revoked'
const GRANT_EXPIRED = 'grant_expired'
const GRANT_FOR_B = 'grant_for_b'
const GRANT_WRONG_ROOT = 'grant_wrong_root'

function signedPost(body: string | Buffer, idempotencyKey: string, overrides?: Partial<Parameters<typeof signRequest>[0]>): SignedRequest {
  return signRequest({
    credentialId: CRED_A,
    secret: SECRET_A,
    method: 'POST',
    path: '/v1/executions',
    body,
    idempotencyKey,
    ...overrides,
  })
}

function post(body: string | Buffer, idempotencyKey: string, overrides?: Partial<Parameters<typeof signRequest>[0]>) {
  const response = callHandle(service, signedPost(body, idempotencyKey, overrides))
  bodies.push(response.body)
  return response
}

function getExecution(executionId: string) {
  const response = callHandle(service, signRequest({ credentialId: CRED_A, secret: SECRET_A, method: 'GET', path: `/v1/executions/${executionId}`, body: '', idempotencyKey: `poll-${executionId}` }))
  bodies.push(response.body)
  return response
}

async function pollTerminal(executionId: string, timeoutMs = 60_000): Promise<ReturnType<typeof getExecution>> {
  const deadline = Date.now() + timeoutMs
  let last: ReturnType<typeof getExecution> | undefined
  while (Date.now() < deadline) {
    last = getExecution(executionId)
    const state = (last.body as { state?: string })?.state
    if (state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED' || state === 'UNKNOWN') return last
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error(`execution ${executionId} never reached a terminal state: ${JSON.stringify(last?.body)}`)
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'hands-02a-ws-'))
  dataDir = mkdtempSync(join(tmpdir(), 'hands-02a-ledger-'))
  outsideRoot = mkdtempSync(join(tmpdir(), 'hands-02a-other-'))
  const credentials = new HandsCredentialStore([
    { credentialId: CRED_A, secret: SECRET_A },
    { credentialId: CRED_B, secret: SECRET_B },
  ])
  grants = new TrustedGrantStore([
    issueTestGrant({ grantId: GRANT_ALL, workspaceId: WS_ID, canonicalRoot: workspace, capabilities: ['fs.read', 'fs.list', 'fs.write', 'fs.patch', 'shell.exec'], allowedCallers: [CRED_A] }),
    issueTestGrant({ grantId: GRANT_FS_ONLY, workspaceId: WS_ID, canonicalRoot: workspace, capabilities: ['fs.read', 'fs.write'], allowedCallers: [CRED_A] }),
    issueTestGrant({ grantId: GRANT_REVOKED, workspaceId: WS_ID, canonicalRoot: workspace, capabilities: ['shell.exec'], allowedCallers: [CRED_A], revoked: true }),
    issueTestGrant({ grantId: GRANT_EXPIRED, workspaceId: WS_ID, canonicalRoot: workspace, capabilities: ['shell.exec'], allowedCallers: [CRED_A], ttlMs: -60_000 }),
    issueTestGrant({ grantId: GRANT_FOR_B, workspaceId: WS_ID, canonicalRoot: workspace, capabilities: ['shell.exec'], allowedCallers: [CRED_B] }),
    issueTestGrant({ grantId: GRANT_WRONG_ROOT, workspaceId: WS_ID, canonicalRoot: outsideRoot, capabilities: ['shell.exec'], allowedCallers: [CRED_A] }),
  ])
  service = new HandsService({ workspaceRoot: workspace, grants, credentials, dataDir })
  await service.start()
})

afterAll(async () => {
  await service.stop()
  for (const dir of [workspace, dataDir, outsideRoot]) rmSync(dir, { recursive: true, force: true })
})

describe('HANDS-02A transport: health and happy path', () => {
  it('GET /v1/health answers unauthenticated with service facts', () => {
    const response = callHandle(service, { method: 'GET', path: '/v1/health', headers: {}, body: Buffer.alloc(0) })
    bodies.push(response.body)
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ ok: true, service: 'zhiyi-hands', protocolVersion: '1' })
  })

  it('a correctly signed execution runs to COMPLETED with a sealed receipt (real process)', async () => {
    const body = executionEnvelope({ grantId: GRANT_ALL, workspaceId: WS_ID, idempotencyKey: 'auth-ok-1', command: 'Write-Output hello-hands' })
    const response = post(body, 'auth-ok-1')
    expect(response.status).toBe(202)
    const executionId = (response.body as { executionId: string }).executionId
    const terminal = await pollTerminal(executionId)
    expect((terminal.body as { state: string }).state).toBe('COMPLETED')
    const receipt = (terminal.body as { receipt?: { status: string; output?: { exitCode?: number; stdout?: { text?: string } } } }).receipt
    expect(receipt?.status).toBe('completed')
    expect(receipt?.output?.exitCode).toBe(0)
    expect(receipt?.output?.stdout?.text).toContain('hello-hands')
    expect(receipt?.output).toHaveProperty('executedBy')
  })
})

describe('HANDS-02A transport: authentication failures', () => {
  const bodyFor = (key: string): string => executionEnvelope({ grantId: GRANT_ALL, workspaceId: WS_ID, idempotencyKey: key, command: 'Write-Output x' })

  it('rejects unsigned requests with 401 AUTHENTICATION_FAILED', () => {
    const response = callHandle(service, { method: 'POST', path: '/v1/executions', headers: { 'content-type': 'application/json' }, body: Buffer.from(bodyFor('unsigned'), 'utf8') })
    expect(response.status).toBe(401)
    expect((response.body as { error: { code: string } }).error.code).toBe('AUTHENTICATION_FAILED')
  })

  it('rejects a signature made with the wrong secret (401)', () => {
    const response = post(bodyFor('wrong-secret'), 'wrong-secret', { secret: 'not-the-secret' })
    expect(response.status).toBe(401)
  })

  it('rejects an unknown credential id (401)', () => {
    const response = post(bodyFor('unknown-cred'), 'unknown-cred', { credentialId: 'cred-nobody' })
    expect(response.status).toBe(401)
  })

  it('rejects a body tampered after signing (digest mismatch, 401)', () => {
    const signed = signedPost(bodyFor('tampered-body'), 'tampered-body')
    const response = callHandle(service, { ...signed, body: Buffer.from(bodyFor('tampered-body-CHANGED'), 'utf8') })
    bodies.push(response.body)
    expect(response.status).toBe(401)
  })

  it('rejects a path tampered after signing (signature covers the path, 401)', () => {
    const signed = signedPost(bodyFor('tampered-path'), 'tampered-path')
    const response = callHandle(service, { ...signed, path: '/v1/executions/x/cancel' })
    bodies.push(response.body)
    expect(response.status).toBe(401)
  })

  it('rejects an expired timestamp (outside the ±300s window)', () => {
    const response = post(bodyFor('expired-ts'), 'expired-ts', { timestamp: Date.now() - 400_000 })
    expect(response.status).toBe(401)
  })

  it('rejects a future timestamp beyond the window', () => {
    const response = post(bodyFor('future-ts'), 'future-ts', { timestamp: Date.now() + 400_000 })
    expect(response.status).toBe(401)
  })

  it('rejects a REPLAYED nonce with 409 REPLAY_REJECTED', () => {
    const signed = signedPost(bodyFor('replay'), 'replay')
    const first = callHandle(service, signed)
    bodies.push(first.body)
    const second = callHandle(service, signed)
    bodies.push(second.body)
    expect(first.status).toBe(202)
    expect(second.status).toBe(409)
    expect((second.body as { error: { code: string } }).error.code).toBe('REPLAY_REJECTED')
  })

  it('a NEW nonce retrying the SAME idempotency key returns the existing execution — side effect runs ONCE', async () => {
    const body = executionEnvelope({
      grantId: GRANT_ALL,
      workspaceId: WS_ID,
      idempotencyKey: 'nonce-vs-idem',
      command: "'tick' | Add-Content -Path side-effect-02a.txt",
    })
    const first = post(body, 'nonce-vs-idem')
    expect(first.status).toBe(202)
    const executionId = (first.body as { executionId: string }).executionId
    await pollTerminal(executionId)

    // Same idempotency key + same body bytes, but a fresh nonce and timestamp.
    const retry = post(body, 'nonce-vs-idem')
    expect(retry.status).toBe(200) // existing record, NOT a new 202
    expect((retry.body as { executionId: string }).executionId).toBe(executionId)
    expect((retry.body as { state: string }).state).toBe('COMPLETED')

    const sideEffectFile = join(workspace, 'side-effect-02a.txt')
    expect(existsSync(sideEffectFile)).toBe(true)
    const ticks = readFileSync(sideEffectFile, 'utf8').split('\n').filter((line) => line.trim() === 'tick')
    expect(ticks).toHaveLength(1) // exactly-once at the idempotency-key level
  })

  it('rejects an Idempotency-Key header that disagrees with the envelope (400)', () => {
    const response = post(bodyFor('header-envelope-mismatch'), 'a-different-key')
    expect(response.status).toBe(400)
    expect((response.body as { error: { code: string } }).error.code).toBe('PROTOCOL_MISMATCH')
  })
})

describe('HANDS-02A admission: the server decides, never the client', () => {
  const postWith = (key: string, grantId: string, opts?: { capabilityId?: string; workspaceId?: string; credential?: string; secret?: string }) =>
    post(
      executionEnvelope({ grantId, workspaceId: opts?.workspaceId ?? WS_ID, idempotencyKey: key, capabilityId: opts?.capabilityId, command: 'Write-Output x' }),
      key,
      { credentialId: opts?.credential ?? CRED_A, secret: opts?.secret ?? SECRET_A },
    )

  it('GRANT_NOT_FOUND for an unknown grant id', () => {
    expect(postWith('adm-1', 'grant-does-not-exist')).toMatchObject({ status: 403, body: { error: { code: 'GRANT_NOT_FOUND' } } })
  })

  it('CALLER_NOT_AUTHORIZED when the signing credential is not the grantee', () => {
    expect(postWith('adm-2', GRANT_FOR_B)).toMatchObject({ status: 403, body: { error: { code: 'CALLER_NOT_AUTHORIZED' } } })
  })

  it('WORKSPACE_MISMATCH when the envelope workspace differs from the grant', () => {
    expect(postWith('adm-3', GRANT_ALL, { workspaceId: 'ws-someone-else' })).toMatchObject({ status: 403, body: { error: { code: 'WORKSPACE_MISMATCH' } } })
  })

  it('GRANT_REVOKED for a revoked grant', () => {
    expect(postWith('adm-4', GRANT_REVOKED)).toMatchObject({ status: 403, body: { error: { code: 'GRANT_REVOKED' } } })
  })

  it('GRANT_EXPIRED for an expired grant', () => {
    expect(postWith('adm-5', GRANT_EXPIRED)).toMatchObject({ status: 403, body: { error: { code: 'GRANT_EXPIRED' } } })
  })

  it('GRANT_ROOT_MISMATCH when the grant names a different workspace root', () => {
    expect(postWith('adm-6', GRANT_WRONG_ROOT)).toMatchObject({ status: 403, body: { error: { code: 'GRANT_ROOT_MISMATCH' } } })
  })

  it('CAPABILITY_DENIED when the capability is not in the grant', () => {
    expect(postWith('adm-7', GRANT_FS_ONLY, { capabilityId: 'shell.exec' })).toMatchObject({ status: 403, body: { error: { code: 'CAPABILITY_DENIED' } } })
  })
})

describe('HANDS-02A protocol: envelope and inline-authority rejection', () => {
  it('rejects an unsupported protocolVersion', () => {
    const raw = JSON.parse(executionEnvelope({ grantId: GRANT_ALL, workspaceId: WS_ID, idempotencyKey: 'proto-1' })) as Record<string, unknown>
    raw.protocolVersion = '9'
    const response = post(JSON.stringify(raw), 'proto-1')
    expect(response.status).toBe(400)
    expect((response.body as { error: { code: string } }).error.code).toBe('HANDS_PROTOCOL_UNSUPPORTED')
  })

  it('rejects an unknown capabilityId', () => {
    const raw = JSON.parse(executionEnvelope({ grantId: GRANT_ALL, workspaceId: WS_ID, idempotencyKey: 'proto-2' })) as Record<string, unknown>
    raw.capabilityId = 'kernel.execute'
    const response = post(JSON.stringify(raw), 'proto-2')
    expect(response.status).toBe(400)
    expect((response.body as { error: { code: string } }).error.code).toBe('HANDS_INVALID_REQUEST')
  })

  it('rejects inline authority inside input (client-declared workspaceRoot)', () => {
    const raw = JSON.parse(executionEnvelope({ grantId: GRANT_ALL, workspaceId: WS_ID, idempotencyKey: 'inline-1', command: 'Write-Output x' })) as { input: Record<string, unknown> }
    raw.input.workspaceroot = 'C:\\Windows'
    const response = post(JSON.stringify(raw), 'inline-1')
    expect(response.status).toBe(400)
    expect((response.body as { error: { code: string } }).error.code).toBe('HANDS_INLINE_AUTHORITY')
  })

  it('rejects an inline sandbox downgrade attempt (sandbox / sandboxPolicy keys)', () => {
    const sandbox = JSON.parse(executionEnvelope({ grantId: GRANT_ALL, workspaceId: WS_ID, idempotencyKey: 'inline-2', command: 'Write-Output x' })) as { input: Record<string, unknown> }
    sandbox.input.sandbox = 'danger-full-access'
    expect(post(JSON.stringify(sandbox), 'inline-2').status).toBe(400)

    const policy = JSON.parse(executionEnvelope({ grantId: GRANT_ALL, workspaceId: WS_ID, idempotencyKey: 'inline-3', command: 'Write-Output x' })) as { input: Record<string, unknown> }
    policy.input.sandboxPolicy = { mode: 'danger-full-access' }
    const response = post(JSON.stringify(policy), 'inline-3')
    expect(response.status).toBe(400)
    expect((response.body as { error: { code: string } }).error.code).toBe('HANDS_INLINE_AUTHORITY')
  })

  it('rejects a shell workdir OUTSIDE the workspace (engine boundary, failed receipt)', async () => {
    const raw = JSON.parse(executionEnvelope({ grantId: GRANT_ALL, workspaceId: WS_ID, idempotencyKey: 'workdir-1', command: 'Write-Output x' })) as { input: Record<string, unknown> }
    raw.input.workdir = 'C:/Windows'
    const response = post(JSON.stringify(raw), 'workdir-1')
    expect(response.status).toBe(202)
    const executionId = (response.body as { executionId: string }).executionId
    const terminal = await pollTerminal(executionId)
    expect((terminal.body as { state: string }).state).toBe('FAILED')
    const receipt = (terminal.body as { receipt?: { status: string; error?: { code: string } } }).receipt
    expect(receipt?.status).toBe('failed')
    expect(receipt?.error?.code).toBe('HANDS_WORKDIR_OUT_OF_WORKSPACE')
  })
})

describe('HANDS-02A transport policy', () => {
  it('refuses to start on a non-loopback bind host', async () => {
    const workspace2 = mkdtempSync(join(tmpdir(), 'hands-02a-ws2-'))
    const dataDir2 = mkdtempSync(join(tmpdir(), 'hands-02a-ledger2-'))
    const rogue = new HandsService({
      workspaceRoot: workspace2,
      grants: new TrustedGrantStore([]),
      credentials: new HandsCredentialStore([{ credentialId: 'c', secret: 's' }]),
      dataDir: dataDir2,
      host: '0.0.0.0',
    })
    await expect(rogue.start()).rejects.toThrow(/non-loopback/)
    await rogue.stop()
    rmSync(workspace2, { recursive: true, force: true })
    rmSync(dataDir2, { recursive: true, force: true })
  })
})

describe('HANDS-02A secrets never surface anywhere', () => {
  it('the credential secrets appear in no response body, no log line, no ledger byte', async () => {
    // Drive a few more error paths so the scan covers rejections too.
    post(executionEnvelope({ grantId: 'nope', workspaceId: WS_ID, idempotencyKey: 'leak-1' }), 'leak-1')
    post(executionEnvelope({ grantId: GRANT_ALL, workspaceId: WS_ID, idempotencyKey: 'leak-2', command: 'exit 3' }), 'leak-2')

    const haystacks: string[] = [JSON.stringify(bodies), JSON.stringify(service.recentLogLines), readFileSync(join(dataDir, 'ledger.jsonl'), 'utf8')]
    for (const haystack of haystacks) {
      expect(haystack).not.toContain(SECRET_A)
      expect(haystack).not.toContain(SECRET_B)
    }
  })
})
