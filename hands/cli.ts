/**
 * ZhiYi Hands P0 — headless demo CLI.
 *
 * Runs the full P0 showcase with NO LLM in the loop: grant issuance, file
 * read/write/patch/list inside the workspace, PowerShell execution with full
 * result capture, the workspace-write fence rejecting an out-of-workspace write,
 * authorization failures, and a provider swap (native fallback PowerShell
 * provider vs the DSH shell provider).
 *
 * Usage:
 *   pnpm demo                     # showcase into a temp workspace
 *   tsx hands/cli.ts exec "Write-Output hi"   # one shell.exec through Hands
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStandaloneHands, HandsEngine, HandsGrantRegistry, NativeFallbackProcessProvider, type HandsExecutionReceipt, type HandsWorld } from './index.ts'

async function main(): Promise<number> {
  const [, , mode, ...rest] = process.argv
  if (mode === 'exec') {
    return runOne(rest.join(' ') || 'Write-Output "Hands-P0"')
  }
  if (mode === 'demo' || mode === undefined) {
    return showcase()
  }
  console.error('usage: tsx hands/cli.ts [demo] | [exec "<powershell command>"]')
  return 2
}

async function runOne(command: string): Promise<number> {
  const workspace = mkdtempSync(join(tmpdir(), 'hands-p0-exec-'))
  const hands = await createStandaloneHands({ workspaceRoot: workspace })
  try {
    const grant = hands.grants.issue({
      workspaceId: 'ws-local',
      canonicalRoot: workspace,
      allowedCapabilities: ['fs.read', 'fs.list', 'fs.write', 'fs.patch', 'shell.exec'],
    })
    const receipt = await hands.engine.execute({
      protocolVersion: '1',
      requestId: `req_${Date.now()}`,
      invocationId: `inv_${Date.now()}`,
      capabilityId: 'shell.exec',
      authorization: { grantId: grant.grantId, workspaceId: 'ws-local' },
      input: { command },
      limits: { timeoutSeconds: 30 },
      idempotencyKey: `cli-${Date.now()}`,
      identity: { runId: 'run_cli_demo' },
    })
    printReceipt(receipt)
    return receipt.status === 'completed' ? 0 : 1
  } finally {
    await hands.dispose()
    rmSync(workspace, { recursive: true, force: true })
  }
}

async function showcase(): Promise<number> {
  const workspace = mkdtempSync(join(tmpdir(), 'hands-p0-demo-'))
  console.log(`# workspace: ${workspace}`)
  const hands = await createStandaloneHands({ workspaceRoot: workspace })
  let exit = 0
  try {
    const grant = hands.grants.issue({
      workspaceId: 'ws-demo',
      canonicalRoot: workspace,
      allowedCapabilities: ['fs.read', 'fs.list', 'fs.write', 'fs.patch', 'shell.exec'],
    })
    const readonlyGrant = hands.grants.issue({
      workspaceId: 'ws-demo',
      canonicalRoot: workspace,
      allowedCapabilities: ['fs.read', 'fs.list'],
    })
    let seq = 0
    const call = async (capabilityId: 'fs.read' | 'fs.list' | 'fs.write' | 'fs.patch' | 'shell.exec', input: Record<string, unknown>, useGrant = grant) =>
      hands.engine.execute({
        protocolVersion: '1',
        requestId: `req_${++seq}`,
        invocationId: `inv_${seq}`,
        capabilityId,
        authorization: { grantId: useGrant.grantId, workspaceId: 'ws-demo' },
        input,
        limits: { timeoutSeconds: 15 },
        idempotencyKey: `demo-${seq}`,
        identity: { runId: 'run_demo', stepId: `step_${seq}`, attemptId: 'atm_1', commitId: `cmt_${seq}` },
      })

    // 1. fs.write inside the workspace (no LLM anywhere)
    printReceipt(await call('fs.write', { path: 'notes/hello.txt', content: 'hello from ZhiYi Hands\n' }))
    // 2. fs.read
    printReceipt(await call('fs.read', { path: 'notes/hello.txt' }))
    // 3. fs.patch (literal edit)
    printReceipt(await call('fs.patch', { path: 'notes/hello.txt', oldText: 'hello', newText: 'HELLO' }))
    // 4. shell.exec: PowerShell with stdout+stderr capture and exit code
    printReceipt(await call('shell.exec', { command: 'Write-Output "stdout-line"; Write-Error "stderr-line" -ErrorAction Continue; exit 3' }))
    // 5. shell.exec: timeout control (command sleeps 30s, budget is 1s)
    printReceipt(await call('shell.exec', { command: 'Start-Sleep -Seconds 30; Write-Output never' }, grant))
    // 6. THE FENCE: write outside the workspace must be denied
    printReceipt(await call('fs.write', { path: outsideWorkspace(workspace), content: 'should be denied' }))
    // 7. Authorization: readonly grant cannot execute shell
    printReceipt(await call('shell.exec', { command: 'Write-Output nope' }, readonlyGrant))
    // 8. Inline authority is rejected by protocol validation at the engine boundary
    printReceipt(
      await hands.engine.execute({
        protocolVersion: '1',
        requestId: 'req_inline',
        invocationId: 'inv_inline',
        capabilityId: 'fs.write',
        authorization: { grantId: grant.grantId, workspaceId: 'ws-demo' },
        input: { path: 'ok.txt', content: 'x', allowedRoot: 'C:\\' },
        limits: {},
        idempotencyKey: 'demo-inline',
      }),
    )

    // 9. Provider swap: same protocol over the native fallback process provider.
    console.log('\n# provider swap: HandsWorld.process -> NativeFallbackProcessProvider')
    const swapped = swapProcessProvider(hands)
    const swappedReceipt = await swapped.execute({
      protocolVersion: '1',
      requestId: 'req_swap',
      invocationId: 'inv_swap',
      capabilityId: 'shell.exec',
      authorization: { grantId: grant.grantId, workspaceId: 'ws-demo' },
      input: { command: 'Write-Output "from the fallback provider"' },
      limits: { timeoutSeconds: 15 },
      idempotencyKey: 'demo-swap',
    })
    printReceipt(swappedReceipt)
  } catch (error) {
    console.error('demo failed:', error)
    exit = 1
  } finally {
    await hands.dispose()
    rmSync(workspace, { recursive: true, force: true })
  }
  return exit
}

function swapProcessProvider(hands: Awaited<ReturnType<typeof createStandaloneHands>>): HandsEngine {
  const swappedWorld: HandsWorld = {
    filesystem: hands.world.filesystem,
    process: new NativeFallbackProcessProvider(),
    resource: hands.world.resource,
    dispose: () => hands.world.dispose(),
  }
  return new HandsEngine({ world: swappedWorld, grants: hands.grants as HandsGrantRegistry })
}

function outsideWorkspace(_workspace: string): string {
  // Outside every writable root: not the workspace, not the OS temp dir (which
  // DSH's writableRoots always allows for command temp space).
  return join(process.cwd(), `.hands-p0-outside-denied-${Date.now()}.txt`)
}

function printReceipt(receipt: HandsExecutionReceipt): void {
  const summary = {
    capabilityId: receipt.capabilityId,
    status: receipt.status,
    errorCode: receipt.error?.code,
    exitCode: (receipt.output as { exitCode?: number } | undefined)?.exitCode,
    timedOut: (receipt.output as { timedOut?: boolean } | undefined)?.timedOut,
    stdout: clip((receipt.output as { stdout?: { text: string } } | undefined)?.stdout?.text),
    text: clip((receipt.output as { text?: string } | undefined)?.text),
    durationMs: receipt.durationMs,
    checksum: `${receipt.checksum.slice(0, 12)}…`,
    identity: receipt.identity,
  }
  console.log(JSON.stringify(summary))
}

function clip(text: string | undefined, max = 80): string | undefined {
  if (text === undefined) return undefined
  const oneLine = text.replace(/\r?\n/g, '\\n').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

main()
  .then((code) => process.exitCode = code)
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
