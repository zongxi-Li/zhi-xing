import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStandaloneHands } from '../hands/index.ts'

const ws = mkdtempSync(join(tmpdir(), 'hands-tree-diag-'))
const hands = await createStandaloneHands({ workspaceRoot: ws, graceMs: 500 })
try {
  const grant = hands.grants.issue({ workspaceId: 'w', canonicalRoot: ws, allowedCapabilities: ['shell.exec'] })
  const r = await hands.engine.execute({
    protocolVersion: '1', requestId: 'r1', invocationId: 'i1', capabilityId: 'shell.exec',
    authorization: { grantId: grant.grantId, workspaceId: 'w' },
    input: { command: '$p = Start-Process -FilePath "ping.exe" -ArgumentList "-n","300","127.0.0.1" -PassThru -WindowStyle Hidden; Write-Output "GRANDCHILD=$($p.Id)"; Start-Sleep -Seconds 60' },
    limits: { timeoutSeconds: 1 }, idempotencyKey: 'k1',
  })
  console.log('status:', r.status)
  const out = r.output as any
  console.log('exitCode:', out?.exitCode, 'timedOut:', out?.timedOut, 'aborted:', out?.aborted)
  const stdout = out?.stdout?.text ?? ''
  console.log('stdout:', JSON.stringify(stdout.slice(0, 200)))
  const pid = /GRANDCHILD=(\d+)/.exec(stdout)?.[1]
  if (pid) {
    const probe1 = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    console.log('probe@0ms:', JSON.stringify(probe1.stdout.trim()))
    // wait 2s and re-probe in case of kill propagation latency
    await new Promise((res) => setTimeout(res, 2000))
    const probe2 = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    console.log('probe@2s:', JSON.stringify(probe2.stdout.trim()))
  }
} finally {
  await hands.dispose()
  rmSync(ws, { recursive: true, force: true })
}
