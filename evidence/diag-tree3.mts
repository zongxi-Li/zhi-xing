import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStandaloneHands } from '../hands/index.ts'

const variant = process.argv[2] ?? 'store'
const pwshPath = variant === 'ps51' ? 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : undefined
const ws = mkdtempSync(join(tmpdir(), `hands-tree-${variant}-`))
const hands = await createStandaloneHands({ workspaceRoot: ws, graceMs: 500, ...(pwshPath === undefined ? {} : { shellExecutablePath: pwshPath }) })
try {
  // introspect the resolved pwsh path via a trivial run
  const pidFile = join(ws, 'grandchild.pid')
  const controller = new AbortController()
  const pending = await hands.world.process.start({
    command: 'Start-Process -FilePath "ping.exe" -ArgumentList "-n","300","127.0.0.1" -PassThru -WindowStyle Hidden | ForEach-Object { Set-Content -LiteralPath $env:HANDS_PID_FILE -Value $_.Id }; $PSVersionTable.PSVersion.ToString(); Start-Sleep -Seconds 120',
    env: { HANDS_PID_FILE: pidFile },
    signal: controller.signal,
  })
  let pid: string | undefined
  for (let i = 0; i < 150 && !pid; i++) {
    await new Promise((res) => setTimeout(res, 100))
    if (existsSync(pidFile)) pid = readFileSync(pidFile, 'utf8').trim()
  }
  console.log(`[${variant}] grandchild pid:`, pid)
  if (!pid) {
    controller.abort()
    const failed = await pending.wait()
    console.log(`[${variant}] stdout:`, JSON.stringify((failed.stdout.text ?? '').slice(0, 400)))
    console.log(`[${variant}] stderr:`, JSON.stringify((failed.stderr.text ?? '').slice(0, 400)))
  }
  if (pid) {
    const alive = () => spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout.includes(pid)
    console.log(`[${variant}] before kill:`, alive() ? 'ALIVE' : 'dead')
    controller.abort()
    const result = await pending.wait()
    console.log(`[${variant}] shell exitCode:`, result.exitCode, 'aborted:', result.aborted)
    console.log(`[${variant}] grandchild after kill:`, alive() ? 'ALIVE (ESCAPED THE JOB)' : 'dead (tree killed)')
  }
} finally {
  await hands.dispose()
  rmSync(ws, { recursive: true, force: true })
}
