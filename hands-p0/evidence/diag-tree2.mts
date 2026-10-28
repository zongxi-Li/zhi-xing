import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStandaloneHands } from '../hands/index.ts'

const ws = mkdtempSync(join(tmpdir(), 'hands-tree-diag2-'))
const hands = await createStandaloneHands({ workspaceRoot: ws, graceMs: 500 })
try {
  const pidFile = join(ws, 'grandchild.pid')
  const controller = new AbortController()
  const pending = await hands.world.process.start({
    command: 'Start-Process -FilePath "ping.exe" -ArgumentList "-n","300","127.0.0.1" -PassThru -WindowStyle Hidden | ForEach-Object { Set-Content -LiteralPath $env:HANDS_PID_FILE -Value $_.Id }; Start-Sleep -Seconds 120',
    env: { HANDS_PID_FILE: pidFile },
    signal: controller.signal,
  })
  // poll for the pid file
  let pid: string | undefined
  for (let i = 0; i < 100 && !pid; i++) {
    await new Promise((res) => setTimeout(res, 100))
    if (existsSync(pidFile)) pid = readFileSync(pidFile, 'utf8').trim()
  }
  console.log('grandchild pid:', pid)
  if (pid) {
    const alive = (t: string) => {
      const probe = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
      return probe.stdout.includes(pid) ? `ALIVE@${t}` : `dead@${t}`
    }
    console.log('before kill:', alive('pre'))
    const killed = controller.abort()
    const result = await pending.wait()
    console.log('result: timedOut=', result.timedOut, 'aborted=', result.aborted, 'exitCode=', result.exitCode)
    console.log('after wait():', alive('post0'))
    await new Promise((res) => setTimeout(res, 2000))
    console.log('after 2s:', alive('post2'))
    await new Promise((res) => setTimeout(res, 3000))
    console.log('after 5s:', alive('post5'))
  }
} finally {
  await hands.dispose()
  rmSync(ws, { recursive: true, force: true })
}
