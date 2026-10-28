import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWindowsJob } from '../vendor/packages/subprocess/subprocess-local-src/windows-job.ts'
import { runnerEnvironment } from '../vendor/packages/subprocess/subprocess-local-src/runner-launch.ts'
import { WINDOWS_RUNNER_SELECTION } from '../vendor/packages/subprocess/subprocess-local-src/runner-launch.ts'
import { spawnRunnerInvocation } from '../vendor/packages/subprocess/subprocess-local-src/runner-launch.ts'

const ws = mkdtempSync(join(tmpdir(), 'hands-runner-diag-'))
const invocation = spawnRunnerInvocation()
console.log('runner invocation:', invocation)
const child = launchWindowsJob(
  {
    argv: ['C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output runner-hi'],
    cwd: ws,
    env: {},
    graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  },
  {},
) as any

child.stderr?.setEncoding('utf8')
child.stderr?.on('data', (c: string) => console.log('[runner.stderr]', c.trim()))
child.stdout?.setEncoding('utf8')
child.stdout?.on('data', (c: string) => console.log('[runner.stdout]', c.trim()))

try {
  const outcome = await child.direct
  console.log('direct outcome:', outcome)
  await child.owner.waitForExit()
  console.log('range settled OK')
} catch (error) {
  console.log('INFRASTRUCTURE ERROR:', String(error))
  await new Promise((r) => setTimeout(r, 500))
} finally {
  rmSync(ws, { recursive: true, force: true })
}
