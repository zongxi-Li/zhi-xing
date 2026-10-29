/**
 * HANDS-02B — bounded execution event stream.
 *
 * One service, real executions: lifecycle ordering, monotone sequences, delta
 * caps, ring truncation (lifecycle events never dropped), afterSequence
 * paging, and idempotent re-subscription.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HandsService } from '../hands/service.ts'
import { HandsCredentialStore } from '../hands/keys.ts'
import { issueTestGrant, TrustedGrantStore } from '../hands/grant-store.ts'
import { EVENT_DELTA_MAX_BYTES } from '../hands/events.ts'
import { callHandle, executionEnvelope, pollTerminal, signRequest } from './service-client.ts'

const SECRET = 'hands-02e-secret-events-3ab9'
const CRED = 'cred-events'
const WS_ID = 'ws-hands-02e'
const GRANT = 'grant_02e'

let workspace: string
let dataDir: string
let service: HandsService

function post(key: string, command: string) {
  return callHandle(service, signRequest({ credentialId: CRED, secret: SECRET, method: 'POST', path: '/v1/executions', body: executionEnvelope({ grantId: GRANT, workspaceId: WS_ID, idempotencyKey: key, command }), idempotencyKey: key }))
}

function getEvents(executionId: string, afterSequence = -1) {
  return callHandle(service, signRequest({ credentialId: CRED, secret: SECRET, method: 'GET', path: `/v1/executions/${executionId}/events?afterSequence=${afterSequence}`, body: '', idempotencyKey: `evt-${executionId}-${afterSequence}` }))
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'hands-02e-ws-'))
  dataDir = mkdtempSync(join(tmpdir(), 'hands-02e-ledger-'))
  service = new HandsService({
    workspaceRoot: workspace,
    grants: new TrustedGrantStore([issueTestGrant({ grantId: GRANT, workspaceId: WS_ID, canonicalRoot: workspace, capabilities: ['shell.exec', 'fs.write'], allowedCallers: [CRED] })]),
    credentials: new HandsCredentialStore([{ credentialId: CRED, secret: SECRET }]),
    dataDir,
  })
  await service.start()
})

afterAll(async () => {
  await service.stop()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

describe('HANDS-02B events: ordering, sequences, deltas', () => {
  it('accepted → started → deltas → completed, with strictly monotone per-execution sequences', async () => {
    const first = post('evt-1', 'Write-Output line-one; [Console]::Error.WriteLine(\'line-err\'); Write-Output line-two')
    expect(first.status).toBe(202)
    const executionId = (first.body as { executionId: string }).executionId
    await pollTerminal(service, executionId, { credentialId: CRED, secret: SECRET })

    const stream = getEvents(executionId).body as { events: Array<{ seq: number; type: string }>; state: string; terminal: boolean }
    expect(stream.state).toBe('COMPLETED')
    expect(stream.terminal).toBe(true)

    const types = stream.events.map((event) => event.type)
    expect(types[0]).toBe('execution.accepted')
    expect(types[1]).toBe('execution.started')
    expect(types.at(-1)).toBe('execution.completed')
    expect(types).toContain('stdout.delta')
    expect(types).toContain('stderr.delta')

    const sequences = stream.events.map((event) => event.seq)
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index]).toBe(sequences[index - 1]! + 1) // strictly monotone, no gaps
    }

    const stdout = stream.events
      .filter((event) => event.type === 'stdout.delta')
      .map((event) => ((event as { payload?: { text?: string } }).payload?.text ?? ''))
      .join('')
    expect(stdout).toContain('line-one')
    expect(stdout).toContain('line-two')
  })

  it('caps each delta payload well under EVENT_DELTA_MAX_BYTES', async () => {
    // 9000 chars of stdout → several capped deltas whose concatenation is complete.
    const command = "$pad='x'*1000; 1..9 | ForEach-Object { Write-Output $pad }"
    const first = post('evt-2', command)
    const executionId = (first.body as { executionId: string }).executionId
    await pollTerminal(service, executionId, { credentialId: CRED, secret: SECRET })

    const stream = getEvents(executionId).body as { events: Array<{ type: string; payload?: { text?: string } }> }
    const deltas = stream.events.filter((event) => event.type === 'stdout.delta')
    expect(deltas.length).toBeGreaterThan(1)
    for (const delta of deltas) {
      expect(Buffer.byteLength(delta.payload?.text ?? '', 'utf8')).toBeLessThanOrEqual(EVENT_DELTA_MAX_BYTES)
    }
    const joined = deltas.map((delta) => delta.payload?.text ?? '').join('')
    expect(joined.replace(/[^x]/g, '')).toHaveLength(9000) // nothing lost
  })

  it('truncates the ring under heavy output but NEVER drops lifecycle events', async () => {
    // ~400KB of stdout → ring budget (256KB) exceeded → oldest deltas evicted.
    const command = "$pad=('y'*250); 1..1600 | ForEach-Object { Write-Output $pad }"
    const first = post('evt-3', command)
    const executionId = (first.body as { executionId: string }).executionId
    await pollTerminal(service, executionId, { credentialId: CRED, secret: SECRET, timeoutMs: 90_000 })

    const stream = getEvents(executionId).body as { events: Array<{ type: string }>; truncated: boolean; nextSeq: number }
    expect(stream.truncated).toBe(true)
    const types = stream.events.map((event) => event.type)
    expect(types).toContain('execution.accepted')   // lifecycle events survive
    expect(types).toContain('execution.started')
    expect(types.at(-1)).toBe('execution.completed')
  })

  it('pages with afterSequence and supports idempotent re-subscription', async () => {
    const first = post('evt-4', 'Write-Output paging-probe')
    const executionId = (first.body as { executionId: string }).executionId
    await pollTerminal(service, executionId, { credentialId: CRED, secret: SECRET })

    const all = getEvents(executionId).body as { events: Array<{ seq: number }>; nextSeq: number }
    const midpoint = all.events[Math.floor(all.events.length / 2)]!.seq
    const tail = getEvents(executionId, midpoint).body as { events: Array<{ seq: number }>; nextSeq: number }
    expect(tail.events[0]!.seq).toBe(midpoint + 1)
    expect(tail.nextSeq).toBe(all.nextSeq)

    // afterSequence is STRICTLY-greater: nextSeq-2 yields exactly the last
    // event; nextSeq-1 and nextSeq yield nothing new.
    const end = getEvents(executionId, all.nextSeq - 2).body as { events: unknown[]; nextSeq: number }
    expect(end.events).toHaveLength(1)
    const last = getEvents(executionId, all.nextSeq - 1).body as { events: unknown[] }
    expect(last.events).toHaveLength(0)
    const beyond = getEvents(executionId, all.nextSeq).body as { events: unknown[] }
    expect(beyond.events).toHaveLength(0)

    // Invalid cursor is a protocol error.
    expect(getEvents(executionId, -5).status).toBe(400)
  })

  it('a policy-failed execution emits execution.failed; an unknown execution is 404', async () => {
    // Nonzero exits are COMPLETED receipts (the exit code is evidence, not
    // failure); a POLICY denial is a genuine failed execution.
    const raw = JSON.parse(executionEnvelope({ grantId: GRANT, workspaceId: WS_ID, idempotencyKey: 'evt-5', capabilityId: 'fs.write' })) as Record<string, unknown>
    raw.input = { path: 'C:/Windows/hands-evt-nope.txt', content: 'denied' }
    const first = callHandle(service, signRequest({ credentialId: CRED, secret: SECRET, method: 'POST', path: '/v1/executions', body: JSON.stringify(raw), idempotencyKey: 'evt-5' }))
    expect(first.status).toBe(202)
    const executionId = (first.body as { executionId: string }).executionId
    const terminal = await pollTerminal(service, executionId, { credentialId: CRED, secret: SECRET })
    expect((terminal.body as { state: string }).state).toBe('FAILED')
    const stream = getEvents(executionId).body as { events: Array<{ type: string }> }
    expect(stream.events.at(-1)!.type).toBe('execution.failed')

    expect(getEvents('xhexec_ffffffffffffffffffffffff').status).toBe(404)
  })
})
