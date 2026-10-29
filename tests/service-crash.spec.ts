/**
 * HANDS-02B — REAL out-of-process crash tests.
 *
 * The service runs as an actual child process (tsx hands/service-main.ts),
 * loaded from real config files, crashed at deterministic points (config fault
 * cut-ins) or killed outright (SIGKILL) mid-execution, then REVIVED as a fresh
 * process over the same ledger. This is the durability story no in-process
 * mock can tell: what is on disk is what survives.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { issueTestGrant, writeGrantsFileShape } from '../hands/grant-store.ts'
import { ABANDONED_BY_RESTART, RESTARTED_DURING_EXECUTION } from '../hands/ledger.ts'
import { executionEnvelope, httpFetch, signRequest } from './service-client.ts'

const SECRET = 'hands-02c-secret-crash-5e21aa'
const CRED = 'cred-crash'
const WS_ID = 'ws-hands-02c'
const GRANT = 'grant_02c'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const TSX_CLI = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const SERVICE_MAIN = join(PROJECT_ROOT, 'hands', 'service-main.ts')

interface ServiceHandle {
  child: ChildProcess
  baseUrl: string
}

const children: ChildProcess[] = []
const dirs: string[] = []

afterAll(() => {
  for (const child of children) {
    if (child.exitCode === null) child.kill()
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** Write config + key/grant files and spawn the real service process. */
async function startServiceProcess(setup: { workspace: string; dataDir: string; faults?: { afterClaim?: boolean; afterStarted?: boolean } }): Promise<ServiceHandle> {
  const configDir = mkdtempSync(join(tmpdir(), 'hands-02c-cfg-'))
  dirs.push(configDir)
  writeFileSync(join(configDir, 'keys.json'), JSON.stringify({ credentials: [{ credentialId: CRED, secret: SECRET }] }))
  writeFileSync(join(configDir, 'grants.json'), JSON.stringify(writeGrantsFileShape([
    issueTestGrant({ grantId: GRANT, workspaceId: WS_ID, canonicalRoot: setup.workspace, capabilities: ['shell.exec'], allowedCallers: [CRED] }),
  ])))
  writeFileSync(join(configDir, 'service.config.json'), JSON.stringify({
    workspaceRoot: setup.workspace,
    credentialsFile: 'keys.json',
    grantsFile: 'grants.json',
    dataDir: setup.dataDir,
    host: '127.0.0.1',
    port: 0,
    ...(setup.faults === undefined ? {} : { faults: setup.faults }),
  }))

  const child = spawn(process.execPath, [TSX_CLI, SERVICE_MAIN, '--config', join(configDir, 'service.config.json')], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })

  const address = await new Promise<{ host: string; port: number }>((resolveAddress, rejectAddress) => {
    let stdout = ''
    const timer = setTimeout(() => rejectAddress(new Error(`service did not become ready. stderr: ${stderr}`)), 45_000)
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      const line = stdout.split('\n').find((candidate) => candidate.startsWith('READY '))
      if (line !== undefined) {
        clearTimeout(timer)
        resolveAddress(JSON.parse(line.slice('READY '.length)) as { host: string; port: number })
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectAddress(new Error(`service exited early (code ${code}). stderr: ${stderr}`))
    })
  })
  return { child, baseUrl: `http://${address.host}:${address.port}` }
}

async function waitExit(child: ChildProcess, timeoutMs = 20_000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error('service did not exit after the injected fault')), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolveExit(code)
    })
  })
}

function postExec(baseUrl: string, body: string, idempotencyKey: string) {
  return httpFetch(baseUrl, signRequest({ credentialId: CRED, secret: SECRET, method: 'POST', path: '/v1/executions', body, idempotencyKey }))
}

function getExec(baseUrl: string, executionId: string) {
  return httpFetch(baseUrl, signRequest({ credentialId: CRED, secret: SECRET, method: 'GET', path: `/v1/executions/${executionId}`, body: '', idempotencyKey: `get-${executionId}` }))
}

async function pollTerminalHttp(baseUrl: string, executionId: string, timeoutMs = 60_000): Promise<{ status: number; body: any }> {
  const deadline = Date.now() + timeoutMs
  let last: { status: number; body: any } | undefined
  while (Date.now() < deadline) {
    last = await getExec(baseUrl, executionId)
    const state = last.body?.state
    if (state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED' || state === 'UNKNOWN') return last
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  throw new Error(`execution ${executionId} not terminal after revival: ${JSON.stringify(last?.body)}`)
}

function tickCount(workspace: string, file: string): number {
  const path = join(workspace, file)
  if (!existsSync(path)) return 0
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() === 'tick').length
}

describe('HANDS-02B out-of-process crash reconciliation', () => {
  it('fault AFTER CLAIM: process dies before dispatching; revival maps it to retryable FAILED/HANDS_ABANDONED_BY_RESTART', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'hands-02c-ws1-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'hands-02c-data1-'))
    dirs.push(workspace, dataDir)
    const victim = await startServiceProcess({ workspace, dataDir, faults: { afterClaim: true } })

    // The response never arrives — the connection dies with the process.
    const body = executionEnvelope({ grantId: GRANT, workspaceId: WS_ID, idempotencyKey: 'crash-after-claim', command: "'tick' | Add-Content -Path ticks-1.txt" })
    await expect(postExec(victim.baseUrl, body, 'crash-after-claim')).rejects.toThrow()
    expect(await waitExit(victim.child)).toBe(1)
    expect(tickCount(workspace, 'ticks-1.txt')).toBe(0) // never dispatched

    // Revive over the same ledger; the SAME request maps to the abandoned record.
    const revived = await startServiceProcess({ workspace, dataDir })
    const replay = await postExec(revived.baseUrl, body, 'crash-after-claim')
    expect(replay.status).toBe(200) // existing record, not a new 202
    expect(replay.body.state).toBe('FAILED')
    expect(replay.body.receipt.error.code).toBe(ABANDONED_BY_RESTART)
    expect(replay.body.receipt.error.retryable).toBe(true)
    expect(tickCount(workspace, 'ticks-1.txt')).toBe(0) // revival never re-ran it
    revived.child.kill()
  })

  it('fault AFTER STARTED: process dies mid-execution; revival maps it to UNKNOWN — never auto-retried, no receipt', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'hands-02c-ws2-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'hands-02c-data2-'))
    dirs.push(workspace, dataDir)
    const victim = await startServiceProcess({ workspace, dataDir, faults: { afterStarted: true } })

    // Dispatch is detached: the 202 comes back, THEN the process dies.
    const body = executionEnvelope({ grantId: GRANT, workspaceId: WS_ID, idempotencyKey: 'crash-after-started', command: 'Start-Sleep -Seconds 20; \'tick\' | Add-Content -Path ticks-2.txt' })
    const accepted = await postExec(victim.baseUrl, body, 'crash-after-started')
    expect(accepted.status).toBe(202)
    const executionId = accepted.body.executionId
    expect(await waitExit(victim.child)).toBe(1)

    const revived = await startServiceProcess({ workspace, dataDir })
    const record = await pollTerminalHttp(revived.baseUrl, executionId)
    expect(record.body.state).toBe('UNKNOWN')
    expect(record.body.reconciliation.reason).toBe(RESTARTED_DURING_EXECUTION)
    expect(record.body.receipt).toBeUndefined()

    // Same key + same digest → the UNKNOWN record itself; NO re-execution.
    const retry = await postExec(revived.baseUrl, body, 'crash-after-started')
    expect(retry.status).toBe(200)
    expect(retry.body.executionId).toBe(executionId)
    expect(retry.body.state).toBe('UNKNOWN')
    revived.child.kill()
  })

  it('REAL SIGKILL mid-execution reconciles to UNKNOWN exactly like the injected fault', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'hands-02c-ws3-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'hands-02c-data3-'))
    dirs.push(workspace, dataDir)
    const victim = await startServiceProcess({ workspace, dataDir })

    const accepted = await postExec(victim.baseUrl, executionEnvelope({
      grantId: GRANT,
      workspaceId: WS_ID,
      idempotencyKey: 'crash-sigkill',
      command: 'Start-Sleep -Seconds 25; \'tick\' | Add-Content -Path ticks-3.txt',
    }), 'crash-sigkill')
    expect(accepted.status).toBe(202)
    const executionId = accepted.body.executionId as string
    // Give the dispatch a moment to reach STARTED, then hard-kill the process.
    await new Promise((resolveWait) => setTimeout(resolveWait, 800))
    victim.child.kill('SIGKILL')
    await waitExit(victim.child)

    const revived = await startServiceProcess({ workspace, dataDir })
    const record = await pollTerminalHttp(revived.baseUrl, executionId)
    expect(record.body.state).toBe('UNKNOWN')
    expect(record.body.reconciliation.reason).toBe(RESTARTED_DURING_EXECUTION)
    revived.child.kill()
  })

  it('a nonce store reset by restart does NOT re-run a settled execution — idempotency is the durable line', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'hands-02c-ws4-'))
    const dataDir = mkdtempSync(join(tmpdir(), 'hands-02c-data4-'))
    dirs.push(workspace, dataDir)
    const first = await startServiceProcess({ workspace, dataDir })

    const body = executionEnvelope({ grantId: GRANT, workspaceId: WS_ID, idempotencyKey: 'restart-replay', command: "'tick' | Add-Content -Path ticks-4.txt" })
    const signed = signRequest({ credentialId: CRED, secret: SECRET, method: 'POST', path: '/v1/executions', body, idempotencyKey: 'restart-replay' })
    const accepted = await httpFetch(first.baseUrl, signed)
    expect(accepted.status).toBe(202)
    const executionId = accepted.body.executionId as string
    await pollTerminalHttp(first.baseUrl, executionId)
    expect(tickCount(workspace, 'ticks-4.txt')).toBe(1)
    first.child.kill()
    await waitExit(first.child)

    // REPLAY the exact signed bytes (same nonce — the fresh process has no
    // memory of it) after restart: no 409, and crucially no second execution.
    const revived = await startServiceProcess({ workspace, dataDir })
    const replay = await httpFetch(revived.baseUrl, signed)
    expect(replay.status).toBe(200)
    expect(replay.body.executionId).toBe(executionId)
    expect(replay.body.state).toBe('COMPLETED')
    expect(tickCount(workspace, 'ticks-4.txt')).toBe(1)
    revived.child.kill()
  })
})
