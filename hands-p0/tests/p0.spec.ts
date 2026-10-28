/**
 * Hands-P0 acceptance tests — one suite per P0 goal:
 *  1. LLM-free file read/write          (fs.write / fs.read through the engine)
 *  2. PowerShell with full capture      (shell.exec: stdout, stderr, exit code)
 *  3. Timeout / cancel / process tree   (timedOut kill, abort-cancel, tree kill)
 *  4. Reject writes outside workspace   (FS_SANDBOX_DENIED)
 *  5. Execution identity + receipts     (echo, checksum verification, grants)
 *  6. Provider swap                     (SandboxedFS↔LocalFS, DSH shell↔native fallback)
 *
 * Everything runs REAL processes on the real Windows host. No LLM anywhere.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createStandaloneHands, HandsGrantRegistry, HandsEngine, NativeFallbackProcessProvider, type HandsExecutionReceipt, type StandaloneHands } from '../hands/index.ts'

const workspaces: string[] = []
const handsInstances: StandaloneHands[] = []

afterAll(async () => {
  await Promise.allSettled(handsInstances.splice(0).map((h) => h.dispose()))
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function makeHands(overrides?: {
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  shell?: 'pwsh' | 'bash'
  fencedFilesystem?: boolean
  shellExecutablePath?: string
}) {
  const workspace = mkdtempSync(join(tmpdir(), 'hands-p0-test-'))
  workspaces.push(workspace)
  const hands = await createStandaloneHands({ workspaceRoot: workspace, graceMs: 300, ...overrides })
  handsInstances.push(hands)
  return { hands, workspace }
}

let seq = 0

/** Build a protocol-valid request against a grant. */
function requestOf(
  hands: StandaloneHands,
  grant: ReturnType<HandsGrantRegistry['issue']>,
  capabilityId: 'fs.read' | 'fs.list' | 'fs.write' | 'fs.patch' | 'shell.exec',
  input: Record<string, unknown>,
  extra?: { limits?: { timeoutSeconds?: number; maxStdoutBytes?: number } },
) {
  seq += 1
  return {
    protocolVersion: '1' as const,
    requestId: `req_${seq}`,
    invocationId: `inv_${seq}`,
    capabilityId,
    authorization: { grantId: grant.grantId, workspaceId: 'ws-test' },
    input,
    limits: extra?.limits ?? { timeoutSeconds: 20 },
    idempotencyKey: `test-${seq}`,
    identity: { runId: 'run_test', stepId: `step_${seq}`, attemptId: 'atm_1', commitId: `cmt_${seq}` },
  }
}

function fullGrant(hands: StandaloneHands, workspace: string) {
  return hands.grants.issue({
    workspaceId: 'ws-test',
    canonicalRoot: workspace,
    allowedCapabilities: ['fs.read', 'fs.list', 'fs.write', 'fs.patch', 'shell.exec'],
  })
}

// --------------------------------------------------------------------------------
// Goal 1+4+5: filesystem capability with write fence, receipts and authorization
// --------------------------------------------------------------------------------
describe('P0-1/4/5 fs capabilities, workspace fence, receipts', () => {
  it('writes and reads a file with NO LLM in the loop, receipt sealed and verifiable', async () => {
    const { hands, workspace } = await makeHands()
    const grant = fullGrant(hands, workspace)

    const write = await hands.engine.execute(requestOf(hands, grant, 'fs.write', { path: 'notes/hello.txt', content: 'hello hands\n' }))
    expect(write.status).toBe('completed')
    expect(write.output?.operation).toBe('create')
    expect(write.output?.bytesWritten).toBe(12)

    const read = await hands.engine.execute(requestOf(hands, grant, 'fs.read', { path: 'notes/hello.txt' }))
    expect(read.status).toBe('completed')
    expect(read.output?.text).toBe('hello hands\n')

    // the file exists on the real host filesystem
    expect(readFileSync(join(workspace, 'notes', 'hello.txt'), 'utf8')).toBe('hello hands\n')

    // receipt integrity: checksum covers all fields and is deterministic
    expect(write.checksum).toMatch(/^[0-9a-f]{64}$/)
    const { checksum: _c, ...writeRest } = write
    expect(recomputeChecksum(writeRest)).toBe(write.checksum)

    // identity echo
    expect(write.identity).toEqual({ runId: 'run_test', stepId: expect.any(String), attemptId: 'atm_1', commitId: expect.any(String) })
    expect(write.protocolVersion).toBe('1')
  })

  it('patches (literal edit) and lists directories', async () => {
    const { hands, workspace } = await makeHands()
    const grant = fullGrant(hands, workspace)
    await hands.engine.execute(requestOf(hands, grant, 'fs.write', { path: 'a/b/c.txt', content: 'one two three' }))
    const patch = await hands.engine.execute(requestOf(hands, grant, 'fs.patch', { path: 'a/b/c.txt', oldText: 'two', newText: 'TWO' }))
    expect(patch.status).toBe('completed')
    const list = await hands.engine.execute(requestOf(hands, grant, 'fs.list', { path: 'a/b' }))
    expect(list.status).toBe('completed')
    expect(list.output?.entries).toEqual([{ name: 'c.txt', type: 'file', size: 13 }])
  })

  it('DENIES writes outside the workspace (the fence), with a failed receipt', async () => {
    const { hands, workspace } = await makeHands()
    const grant = fullGrant(hands, workspace)
    // Escape target OUTSIDE every writable root: not the workspace, not the OS temp
    // dir (which DSH's writableRoots deliberately always allows for command temp space).
    const outside = join(process.cwd(), `.hands-escape-probe-${Date.now()}.txt`)
    const denied = await hands.engine.execute(requestOf(hands, grant, 'fs.write', { path: outside, content: 'escape attempt' }))
    expect(denied.status).toBe('failed')
    expect(denied.error?.code).toBe('FS_SANDBOX_DENIED')
    expect(existsSync(outside)).toBe(false)
    // workspace writes still fine afterwards
    const ok = await hands.engine.execute(requestOf(hands, grant, 'fs.write', { path: 'ok.txt', content: 'still here' }))
    expect(ok.status).toBe('completed')
  })

  it('read-only mode denies ALL mutations', async () => {
    const { hands, workspace } = await makeHands({ sandboxMode: 'read-only' })
    const grant = hands.grants.issue({ workspaceId: 'ws-test', canonicalRoot: workspace, allowedCapabilities: ['fs.read', 'fs.write'] })
    const denied = await hands.engine.execute(requestOf(hands, grant, 'fs.write', { path: 'x.txt', content: 'no' }))
    expect(denied.status).toBe('failed')
    expect(denied.error?.code).toBe('FS_SANDBOX_DENIED')
  })

  it('inline authority in input is rejected before execution', async () => {
    const { hands, workspace } = await makeHands()
    const grant = fullGrant(hands, workspace)
    const rejected = await hands.engine.execute(
      requestOf(hands, grant, 'fs.write', { path: 'x.txt', content: 'x', allowedRoot: 'C:\\' }),
    )
    expect(rejected.status).toBe('failed')
    expect(rejected.error?.code).toBe('HANDS_INLINE_AUTHORITY')
  })

  it('grant authorization failures produce distinct receipt codes', async () => {
    const { hands, workspace } = await makeHands()
    const grant = fullGrant(hands, workspace)
    const shellOnlyGrant = hands.grants.issue({ workspaceId: 'ws-test', canonicalRoot: workspace, allowedCapabilities: ['shell.exec'] })
    const otherWsGrant = hands.grants.issue({ workspaceId: 'ws-other', canonicalRoot: workspace, allowedCapabilities: ['fs.write'] })
    const wrongRootGrant = hands.grants.issue({ workspaceId: 'ws-test', canonicalRoot: join(workspace, 'sub'), allowedCapabilities: ['fs.write'] })

    const denied = await hands.engine.execute(requestOf(hands, shellOnlyGrant, 'fs.write', { path: 'x.txt', content: 'x' }))
    expect(denied.error?.code).toBe('CAPABILITY_DENIED')

    const mismatch = await hands.engine.execute({ ...requestOf(hands, otherWsGrant, 'fs.write', { path: 'x.txt', content: 'x' }) })
    expect(mismatch.error?.code).toBe('WORKSPACE_MISMATCH')

    const rootMismatch = await hands.engine.execute(requestOf(hands, wrongRootGrant, 'fs.write', { path: 'x.txt', content: 'x' }))
    expect(rootMismatch.error?.code).toBe('GRANT_ROOT_MISMATCH')

    hands.grants.revoke(grant.grantId)
    const revoked = await hands.engine.execute(requestOf(hands, grant, 'fs.write', { path: 'x.txt', content: 'x' }))
    expect(revoked.error?.code).toBe('GRANT_REVOKED')

    const ghost = await hands.engine.execute(requestOf(hands, { ...grant, grantId: 'hgrant_ghost' } as never, 'fs.write', { path: 'x.txt', content: 'x' }))
    expect(ghost.error?.code).toBe('GRANT_NOT_FOUND')
  })

  it('stale-version guarded writes are rejected and retryable', async () => {
    const { hands, workspace } = await makeHands()
    const grant = fullGrant(hands, workspace)
    const write = await hands.engine.execute(requestOf(hands, grant, 'fs.write', { path: 'g.txt', content: 'v1' }))
    const stale = await hands.engine.execute(
      requestOf(hands, grant, 'fs.write', { path: 'g.txt', content: 'v2', expectedVersion: 'deadbeef' }),
    )
    expect(stale.status).toBe('failed')
    expect(stale.error?.code).toBe('FS_STALE_VERSION')
    expect(stale.error?.retryable).toBe(true)
    expect((await hands.engine.execute(requestOf(hands, grant, 'fs.read', { path: 'g.txt' }))).output?.text).toBe('v1')
  })
})

// --------------------------------------------------------------------------------
// Goal 2+3: PowerShell execution, full capture, timeout, cancel, process tree
// --------------------------------------------------------------------------------
describe('P0-2/3 shell.exec: capture, deadline, cancellation, process tree', () => {
  it('captures stdout, stderr and the exit code of a real PowerShell run', async () => {
    const { hands, workspace } = await makeHands()
    const grant = fullGrant(hands, workspace)
    const receipt = await hands.engine.execute(
      requestOf(hands, grant, 'shell.exec', {
        command: 'Write-Output "out-1"; Write-Output "out-2"; [Console]::Error.WriteLine("err-1"); exit 7',
      }),
    )
    expect(receipt.status).toBe('completed')
    const output = receipt.output as { exitCode: number; stdout: { text: string }; stderr: { text: string }; timedOut: boolean; aborted: boolean }
    expect(output.exitCode).toBe(7)
    expect(output.stdout.text).toContain('out-1')
    expect(output.stdout.text).toContain('out-2')
    expect(output.stderr.text).toContain('err-1')
    expect(output.timedOut).toBe(false)
    expect(output.aborted).toBe(false)
  })

  it('enforces the timeout: the command is killed and the receipt reports timedOut', async () => {
    const { hands, workspace } = await makeHands()
    const grant = fullGrant(hands, workspace)
    const started = Date.now()
    const receipt = await hands.engine.execute(
      requestOf(hands, grant, 'shell.exec', { command: 'Write-Output before; Start-Sleep -Seconds 60; Write-Output after' }, { limits: { timeoutSeconds: 1 } }),
    )
    const elapsed = Date.now() - started
    expect(receipt.status).toBe('completed') // timeout is a completed execution with a classification, not a crash
    const output = receipt.output as { timedOut: boolean; exitCode: number | null; stdout: { text: string } }
    expect(output.timedOut).toBe(true)
    expect(output.stdout.text).toContain('before')
    expect(output.stdout.text).not.toContain('after')
    expect(elapsed).toBeLessThan(20_000)
  })

  it('cancellation: an aborted caller signal yields a cancelled receipt and a dead process', async () => {
    const { hands, workspace } = await makeHands()
    const grant = fullGrant(hands, workspace)
    const controller = new AbortController()
    const pending = hands.engine.execute(
      requestOf(hands, grant, 'shell.exec', { command: 'Start-Sleep -Seconds 60' }),
      controller.signal,
    )
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500))
    controller.abort()
    const receipt = await pending
    expect(receipt.status).toBe('cancelled')
    expect(receipt.error?.code).toBe('HANDS_CANCELLED')
  })

  it('kills the WHOLE process tree: a grandchild started by the shell does not survive', async () => {
    // Pinned to the NATIVE Windows PowerShell 5.1: the Microsoft Store pwsh is an
    // MSIX app-execution alias whose grandchildren escape the Job (see
    // evidence/tree-kill-store-pwsh-escape.md). The Job-Object mechanism itself
    // is what this test verifies; shell resolution policy is P1 work.
    const { hands, workspace } = await makeHands({
      shellExecutablePath: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    })
    const grant = fullGrant(hands, workspace)
    // The shell starts a long-lived grandchild and prints its PID.
    const receipt = await hands.engine.execute(
      requestOf(
        hands,
        grant,
        'shell.exec',
        {
          command: [
            '$p = Start-Process -FilePath "ping.exe" -ArgumentList "-n","300","127.0.0.1" -PassThru -WindowStyle Hidden',
            "Write-Output \"GRANDCHILD=$($p.Id)\"",
            'Start-Sleep -Seconds 60',
          ].join('; '),
        },
        { limits: { timeoutSeconds: 1 } },
      ),
    )
    expect(receipt.status).toBe('completed')
    const stdout = (receipt.output as { stdout: { text: string } }).stdout.text
    const match = /GRANDCHILD=(\d+)/.exec(stdout)
    expect(match).not.toBeNull()
    const grandchildPid = match![1]!
    // DSH semantics: waitForExit resolves only when the JOB is empty, so by the
    // time the receipt settles the grandchild must already be terminated.
    const probe = spawnSync('tasklist', ['/FI', `PID eq ${grandchildPid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    expect(probe.stdout).not.toContain(grandchildPid)
  })

  it('background handle: start() returns a live handle that kills cleanly', async () => {
    const { hands, workspace } = await makeHands()
    const grant = fullGrant(hands, workspace)
    // direct provider use (engine surface covers run()); the Jobs seam is P1
    const handle = await hands.world.process.start({ command: '$counter=0; while($true) { $counter++; Start-Sleep -Milliseconds 100 }', timeoutMs: undefined })
    expect(handle.pid === null || typeof handle.pid === 'number').toBe(true)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 700))
    expect(handle.kill()).toBe(true)
    const result = await handle.wait()
    expect(result.aborted).toBe(false) // direct kill() is not a caller-abort classification
  })
})

// --------------------------------------------------------------------------------
// Goal 6: provider swap — filesystem backend, shell backend, resource policy
// --------------------------------------------------------------------------------
describe('P0-6 provider swap keeps the protocol identical', () => {
  it('unfenced LocalFileSystem allows the same write the sandboxed backend denies', async () => {
    const { hands, workspace } = await makeHands({ fencedFilesystem: false })
    expect(hands.world.filesystem.name).toBe('dsh-local-fs')
    const grant = fullGrant(hands, workspace)
    const outside = join(process.cwd(), `.hands-swap-probe-${Date.now()}.txt`)
    const allowed = await hands.engine.execute(requestOf(hands, grant, 'fs.write', { path: outside, content: 'unfenced world allows this' }))
    expect(allowed.status).toBe('completed')
    expect(existsSync(outside)).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('unfenced world allows this')
    rmSync(outside, { force: true })
  })

  it('bash executor runs the same shell.exec contract through a different shell', async () => {
    const bashPath = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' })
    if (bashPath.status !== 0) return // host without bash: skip this swap demo
    const { hands, workspace } = await makeHands({ shell: 'bash' })
    expect(hands.world.process.name).toBe('dsh-shell-bash')
    const grant = fullGrant(hands, workspace)
    const receipt = await hands.engine.execute(requestOf(hands, grant, 'shell.exec', { command: 'echo bash-says-$((40+2))' }))
    expect(receipt.status).toBe('completed')
    expect((receipt.output as { exitCode: number }).exitCode).toBe(0)
    expect((receipt.output as { stdout: { text: string } }).stdout.text).toContain('bash-says-42')
  })

  it('native fallback provider (Hands-owned, zero DSH) serves the same receipts', async () => {
    const { hands, workspace } = await makeHands()
    const grant = fullGrant(hands, workspace)
    const swappedWorld = {
      filesystem: hands.world.filesystem,
      process: new NativeFallbackProcessProvider(),
      resource: hands.world.resource,
      dispose: () => hands.world.dispose(),
    }
    const swappedEngine = new HandsEngine({ world: swappedWorld, grants: hands.grants })
    const receipt = await swappedEngine.execute(
      requestOf(hands, grant, 'shell.exec', { command: 'Write-Output "fallback-$((6*7))"' }, { limits: { timeoutSeconds: 15 } }),
    )
    expect(receipt.status).toBe('completed')
    expect((receipt.output as { stdout: { text: string } }).stdout.text).toContain('fallback-42')

    // and its timeout path classifies timedOut too
    const timeoutReceipt = await swappedEngine.execute(
      requestOf(hands, grant, 'shell.exec', { command: 'Start-Sleep -Seconds 60' }, { limits: { timeoutSeconds: 1 } }),
    )
    expect(timeoutReceipt.status).toBe('completed')
    expect((timeoutReceipt.output as { timedOut: boolean }).timedOut).toBe(true)
    await swappedWorld.process.dispose()
  })

  it('resource provider enforces stdout budgets via truncation + spill', async () => {
    const { hands, workspace } = await makeHands()
    const grant = fullGrant(hands, workspace)
    // The engine maps limits.maxStdoutBytes into the executor's capture budget:
    const small = await hands.engine.execute(
      { ...requestOf(hands, grant, 'shell.exec', { command: 'Write-Output ("y" * 40000)' }), limits: { timeoutSeconds: 15, maxStdoutBytes: 1000 } },
    )
    expect(small.status).toBe('completed')
    const stdout = (small.output as { stdout: { truncated: boolean; spillPath?: string; text: string } }).stdout
    expect(stdout.truncated).toBe(true)
    expect(stdout.spillPath).toBeDefined()
    expect(existsSync(stdout.spillPath!)).toBe(true)
    expect(stdout.text.length).toBeLessThanOrEqual(1100)
  })
})

// --------------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------------
import { receiptChecksum } from '../hands/engine.ts'
function recomputeChecksum(receipt: Omit<HandsExecutionReceipt, 'checksum'>): string {
  return receiptChecksum(receipt as HandsExecutionReceipt)
}
