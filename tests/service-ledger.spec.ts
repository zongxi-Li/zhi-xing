/**
 * HANDS-02B — execution ledger, idempotency, fault reconciliation, cancel
 * semantics, disconnect immunity (in-process service instances; the REAL
 * out-of-process crash tests live in service-crash.spec.ts).
 *
 * Every suite uses an isolated workspace + isolated ledger data dir. Real
 * PowerShell processes produce real side effects; assertions count them on
 * disk. The reconciliation cases restart a NEW service over the SAME dataDir —
 * ledger replay + classify — without re-running anything.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HandsService } from '../hands/service.ts'
import { HandsCredentialStore } from '../hands/keys.ts'
import { issueTestGrant, TrustedGrantStore, writeGrantsFileShape } from '../hands/grant-store.ts'
import { ExecutionLedger, ABANDONED_BY_RESTART, RESTARTED_DURING_EXECUTION } from '../hands/ledger.ts'
import { callHandle, executionEnvelope, pollTerminal, signRequest } from './service-client.ts'

const SECRET = 'hands-02b-secret-ledger-77c1'
const CRED = 'cred-ledger'
const WS_ID = 'ws-hands-02b'
const GRANT = 'grant_02b'

const credentials = new HandsCredentialStore([{ credentialId: CRED, secret: SECRET }])
const CRED_POLL = { credentialId: CRED, secret: SECRET } as const

let workspace: string
let dataDir: string
let service: HandsService
let serviceAddress: { host: string; port: number }
const cleaner: Array<() => void | Promise<void>> = []

function post(body: string, idempotencyKey: string) {
  return callHandle(service, signRequest({ credentialId: CRED, secret: SECRET, method: 'POST', path: '/v1/executions', body, idempotencyKey }))
}

function envelope(key: string, command: string): string {
  return executionEnvelope({ grantId: GRANT, workspaceId: WS_ID, idempotencyKey: key, command })
}

function tickCommand(file: string): string {
  return `'tick' | Add-Content -Path ${file}`
}

function tickCount(file: string): number {
  const path = join(workspace, file)
  if (!existsSync(path)) return 0
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() === 'tick').length
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'hands-02b-ws-'))
  dataDir = mkdtempSync(join(tmpdir(), 'hands-02b-ledger-'))
  service = new HandsService({
    workspaceRoot: workspace,
    grants: new TrustedGrantStore([issueTestGrant({ grantId: GRANT, workspaceId: WS_ID, canonicalRoot: workspace, capabilities: ['fs.read', 'fs.list', 'fs.write', 'fs.patch', 'shell.exec'], allowedCallers: [CRED] })]),
    credentials,
    dataDir,
  })
  serviceAddress = await service.start()
  cleaner.push(async () => {
    await service.stop()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })
})

afterAll(async () => {
  for (const cleanup of cleaner.reverse()) await cleanup()
})

describe('HANDS-02B idempotency: one side effect per (caller, key)', () => {
  it('replaying the SAME idempotency key+digest returns the existing record; the command ran ONCE', async () => {
    const body = envelope('idem-once', tickCommand('ticks-once.txt'))
    const first = post(body, 'idem-once')
    expect(first.status).toBe(202)
    await pollTerminal(service, (first.body as { executionId: string }).executionId, CRED_POLL)
    expect(tickCount('ticks-once.txt')).toBe(1)

    const replay = post(body, 'idem-once')
    expect(replay.status).toBe(200)
    expect((replay.body as { executionId: string }).executionId).toBe((first.body as { executionId: string }).executionId)
    expect((replay.body as { state: string }).state).toBe('COMPLETED')
    expect(tickCount('ticks-once.txt')).toBe(1) // never re-executed
  })

  it('same idempotency key with a DIFFERENT digest is an explicit conflict (409)', () => {
    const first = post(envelope('idem-conflict', 'Write-Output a'), 'idem-conflict')
    expect(first.status).toBe(202)
    const conflict = post(envelope('idem-conflict', 'Write-Output DIFFERENT'), 'idem-conflict')
    expect(conflict.status).toBe(409)
    expect((conflict.body as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_KEY_CONFLICT')
  })

  it('10 CONCURRENT claims of the same key: exactly one 202, nine replays, one side effect', async () => {
    const body = envelope('idem-concurrent', tickCommand('ticks-conc.txt'))
    const responses = await Promise.all(Array.from({ length: 10 }, () => post(body, 'idem-concurrent')))
    const accepted = responses.filter((r) => r.status === 202)
    const replayed = responses.filter((r) => r.status === 200)
    expect(accepted).toHaveLength(1)
    expect(replayed).toHaveLength(9)
    const executionId = (accepted[0]!.body as { executionId: string }).executionId
    for (const replay of replayed) {
      expect((replay.body as { executionId: string }).executionId).toBe(executionId)
    }
    await pollTerminal(service, executionId, CRED_POLL)
    expect(tickCount('ticks-conc.txt')).toBe(1)
  })
})

describe('HANDS-02B crash reconciliation (new service over the same ledger)', () => {
  it('a crash BEFORE dispatch (claim persisted, execution never began) reconciles to retryable FAILED/HANDS_ABANDONED_BY_RESTART', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hands-02b-crash1-'))
    cleaner.push(() => rmSync(dir, { recursive: true, force: true }))
    // Crash-after-claim without touching the service: write the claim directly,
    // exactly what #postExecution persisted before the process died.
    const victim = new ExecutionLedger(dir)
    const claimed = victim.claim({
      callerId: CRED,
      idempotencyKey: 'crash-pre-dispatch',
      requestDigest: 'a'.repeat(64),
      summary: { capabilityId: 'shell.exec', requestId: 'req-c1', invocationId: 'inv-c1', workspaceId: WS_ID, callerId: CRED },
    })
    if (!claimed.claimed) throw new Error('claim unexpectedly lost the slot')
    victim.close()

    const revived = new HandsService({
      workspaceRoot: workspace,
      grants: new TrustedGrantStore([issueTestGrant({ grantId: GRANT, workspaceId: WS_ID, canonicalRoot: workspace, capabilities: ['shell.exec'], allowedCallers: [CRED] })]),
      credentials,
      dataDir: dir,
    })
    await revived.start()
    cleaner.push(async () => revived.stop())
    const record = (callHandle(revived, signRequest({ credentialId: CRED, secret: SECRET, method: 'GET', path: `/v1/executions/${claimed.record.executionId}`, body: '', idempotencyKey: 'get-c1' })).body) as {
      state: string
      receipt?: { error?: { code: string; retryable: boolean } }
    }
    expect(record.state).toBe('FAILED')
    expect(record.receipt?.error?.code).toBe(ABANDONED_BY_RESTART)
    expect(record.receipt?.error?.retryable).toBe(true)
  })

  it('a crash DURING execution (STARTED persisted) reconciles to UNKNOWN — no receipt minted, NEVER auto-retried', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hands-02b-crash2-'))
    cleaner.push(() => rmSync(dir, { recursive: true, force: true }))
    const victim = new ExecutionLedger(dir)
    const claimed = victim.claim({
      callerId: CRED,
      idempotencyKey: 'crash-mid-exec',
      requestDigest: 'b'.repeat(64),
      summary: { capabilityId: 'shell.exec', requestId: 'req-c2', invocationId: 'inv-c2', workspaceId: WS_ID, callerId: CRED },
    })
    if (!claimed.claimed) throw new Error('claim unexpectedly lost the slot')
    victim.setState(claimed.record.executionId, 'STARTED')
    victim.close()

    const revived = new HandsService({
      workspaceRoot: workspace,
      grants: new TrustedGrantStore([issueTestGrant({ grantId: GRANT, workspaceId: WS_ID, canonicalRoot: workspace, capabilities: ['shell.exec'], allowedCallers: [CRED] })]),
      credentials,
      dataDir: dir,
    })
    await revived.start()
    cleaner.push(async () => revived.stop())
    const executionId = claimed.record.executionId
    const view = callHandle(revived, signRequest({ credentialId: CRED, secret: SECRET, method: 'GET', path: `/v1/executions/${executionId}`, body: '', idempotencyKey: 'get-c2' })).body as {
      state: string
      receipt?: unknown
      reconciliation?: { reason: string }
    }
    expect(view.state).toBe('UNKNOWN')
    expect(view.reconciliation?.reason).toBe(RESTARTED_DURING_EXECUTION)
    expect(view.receipt).toBeUndefined() // nothing confirmed — no receipt may exist

    // A retry under the same key is refused (digest differs from the persisted
    // claim), and NOTHING re-runs: no new side effects appear anywhere.
    const body = executionEnvelope({ grantId: GRANT, workspaceId: WS_ID, idempotencyKey: 'crash-mid-exec', command: tickCommand('ticks-crash.txt') })
    const retry = callHandle(revived, signRequest({ credentialId: CRED, secret: SECRET, method: 'POST', path: '/v1/executions', body, idempotencyKey: 'crash-mid-exec' }))
    expect(retry.status).toBe(409)
    expect(tickCount('ticks-crash.txt')).toBe(0)
  })

  it('receipts survive a restart: GET after revival returns the identical sealed receipt', async () => {
    const body = envelope('durable-receipt', 'Write-Output durable')
    const first = post(body, 'durable-receipt')
    const executionId = (first.body as { executionId: string }).executionId
    await pollTerminal(service, executionId, CRED_POLL)
    const before = (callHandle(service, signRequest({ credentialId: CRED, secret: SECRET, method: 'GET', path: `/v1/executions/${executionId}`, body: '', idempotencyKey: 'get-d1' })).body as { receipt: unknown }).receipt

    const revived = new HandsService({
      workspaceRoot: workspace,
      grants: new TrustedGrantStore([issueTestGrant({ grantId: GRANT, workspaceId: WS_ID, canonicalRoot: workspace, capabilities: ['shell.exec'], allowedCallers: [CRED] })]),
      credentials,
      dataDir,
    })
    await revived.start()
    cleaner.push(async () => revived.stop())
    const after = (callHandle(revived, signRequest({ credentialId: CRED, secret: SECRET, method: 'GET', path: `/v1/executions/${executionId}`, body: '', idempotencyKey: 'get-d2' })).body as { receipt: unknown }).receipt
    expect(after).toEqual(before)
  })

  it('a torn (half-written) ledger tail line is ignored and replay still works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hands-02b-torn-'))
    cleaner.push(() => rmSync(dir, { recursive: true, force: true }))
    const victim = new ExecutionLedger(dir)
    const claimed = victim.claim({ callerId: CRED, idempotencyKey: 'torn', requestDigest: 'c'.repeat(64), summary: { capabilityId: 'shell.exec', requestId: 'r', invocationId: 'i', workspaceId: WS_ID, callerId: CRED } })
    if (!claimed.claimed) throw new Error('claim unexpectedly lost the slot')
    victim.close()
    // Simulate a crash mid-write: append garbage that is NOT valid JSON.
    writeFileSync(join(dir, 'ledger.jsonl'), '{"t":"claim","executionId":"tor', { flag: 'a' })

    const replayed = new ExecutionLedger(dir)
    expect(replayed.get(claimed.record.executionId)).toBeDefined()
    replayed.close()
  })
})

describe('HANDS-02B cancellation: request vs terminal state', () => {
  it('cancel REQUEST marks the record, aborts the engine, and ends CANCELLED with a cancelled receipt', async () => {
    const first = post(envelope('cancel-1', 'Write-Output begin; Start-Sleep -Seconds 60'), 'cancel-1')
    expect(first.status).toBe(202)
    const executionId = (first.body as { executionId: string }).executionId

    const cancel = callHandle(service, signRequest({ credentialId: CRED, secret: SECRET, method: 'POST', path: `/v1/executions/${executionId}/cancel`, body: JSON.stringify({ executionId }), idempotencyKey: 'cancel-1' }))
    expect(cancel.status).toBe(200)
    expect((cancel.body as { cancelRequested: boolean }).cancelRequested).toBe(true)

    const terminal = await pollTerminal(service, executionId, { credentialId: CRED, secret: SECRET, timeoutMs: 45_000 })
    expect((terminal.body as { state: string }).state).toBe('CANCELLED')
    expect((terminal.body as { receipt: { status: string } }).receipt.status).toBe('cancelled')
    expect((terminal.body as { cancelRequested: boolean }).cancelRequested).toBe(true)
  })

  it('cancelling an already-settled execution is 409 EXECUTION_ALREADY_SETTLED', async () => {
    const first = post(envelope('cancel-2', 'Write-Output quick'), 'cancel-2')
    const executionId = (first.body as { executionId: string }).executionId
    await pollTerminal(service, executionId, CRED_POLL)

    const cancel = callHandle(service, signRequest({ credentialId: CRED, secret: SECRET, method: 'POST', path: `/v1/executions/${executionId}/cancel`, body: JSON.stringify({ executionId }), idempotencyKey: 'cancel-2' }))
    expect(cancel.status).toBe(409)
    expect((cancel.body as { error: { code: string } }).error.code).toBe('EXECUTION_ALREADY_SETTLED')
  })

  it('cancel body must echo the path executionId (400 on mismatch) and unknown ids are 404', () => {
    const mismatch = callHandle(service, signRequest({ credentialId: CRED, secret: SECRET, method: 'POST', path: '/v1/executions/xhexec_ffffffffffffffffffffffff/cancel', body: JSON.stringify({ executionId: 'xhexec_000000000000000000000000' }), idempotencyKey: 'cancel-3' }))
    expect(mismatch.status).toBe(400)
    const unknown = callHandle(service, signRequest({ credentialId: CRED, secret: SECRET, method: 'POST', path: '/v1/executions/xhexec_ffffffffffffffffffffffff/cancel', body: JSON.stringify({ executionId: 'xhexec_ffffffffffffffffffffffff' }), idempotencyKey: 'cancel-4' }))
    expect(unknown.status).toBe(404)
  })
})

describe('HANDS-02B client disconnects never change outcomes', () => {
  it('aborting the HTTP request mid-execution does NOT cancel: the run completes and the side effect lands once', async () => {
    const base = `http://${serviceAddress.host}:${serviceAddress.port}`
    const body = envelope('disconnect-1', `Start-Sleep -Seconds 2; ${tickCommand('ticks-disc.txt')}`)
    const signed = signRequest({ credentialId: CRED, secret: SECRET, method: 'POST', path: '/v1/executions', body, idempotencyKey: 'disconnect-1' })
    const controller = new AbortController()
    const fetchOutcome = fetch(`${base}/v1/executions`, {
      method: 'POST',
      headers: signed.headers,
      body: new Uint8Array(signed.body),
      signal: controller.signal,
    })
      .then((response) => `http-${response.status}`)
      .catch(() => 'client-aborted')

    // Wait until the claim is durably visible, THEN rip the connection away.
    const deadline = Date.now() + 15_000
    let executionId: string | undefined
    while (Date.now() < deadline && executionId === undefined) {
      const probe = post(body, 'disconnect-1')
      if (probe.status === 200 || probe.status === 202) executionId = probe.body.executionId
      else await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(executionId).toBeDefined()
    controller.abort()
    void (await fetchOutcome) // aborted or already answered — either is fine

    const terminal = await pollTerminal(service, executionId!, { credentialId: CRED, secret: SECRET, timeoutMs: 60_000 })
    expect((terminal.body as { state: string }).state).toBe('COMPLETED') // NOT cancelled
    expect(tickCount('ticks-disc.txt')).toBe(1)
  })
})

describe('HANDS-02B grant hot-reload (mtime)', () => {
  it('revoking the grant FILE takes effect at the next admission — no service restart', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'hands-02b-grant-ws-'))
    const dir = mkdtempSync(join(tmpdir(), 'hands-02b-grant-data-'))
    cleaner.push(() => {
      rmSync(ws, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    })
    const grantsFile = join(dir, 'grants.json')
    const grant = issueTestGrant({ grantId: 'grant_hot', workspaceId: WS_ID, canonicalRoot: ws, capabilities: ['shell.exec'], allowedCallers: [CRED] })
    writeFileSync(grantsFile, JSON.stringify(writeGrantsFileShape([grant])))

    const svc = new HandsService({ workspaceRoot: ws, grants: { file: grantsFile }, credentials, dataDir: dir })
    await svc.start()
    cleaner.push(async () => svc.stop())

    const body = executionEnvelope({ grantId: 'grant_hot', workspaceId: WS_ID, idempotencyKey: 'hot-1', command: 'Write-Output ok' })
    const before = callHandle(svc, signRequest({ credentialId: CRED, secret: SECRET, method: 'POST', path: '/v1/executions', body, idempotencyKey: 'hot-1' }))
    expect(before.status).toBe(202)

    // Operator flips the trusted file (mtime changes → hot reload).
    writeFileSync(grantsFile, JSON.stringify(writeGrantsFileShape([{ ...grant, revoked: true }])))
    const after = callHandle(svc, signRequest({ credentialId: CRED, secret: SECRET, method: 'POST', path: '/v1/executions', body: executionEnvelope({ grantId: 'grant_hot', workspaceId: WS_ID, idempotencyKey: 'hot-2', command: 'Write-Output ok' }), idempotencyKey: 'hot-2' }))
    expect(after.status).toBe(403)
    expect((after.body as { error: { code: string } }).error.code).toBe('GRANT_REVOKED')
  })
})
