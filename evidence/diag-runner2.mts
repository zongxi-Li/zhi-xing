import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { launchWindowsJob } from '../vendor/packages/subprocess/subprocess-local-src/windows-job.ts'

const ws = mkdtempSync(join(tmpdir(), 'hands-runner-diag2-'))
const child = launchWindowsJob(
  {
    argv: ['C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output runner-hi'],
    cwd: ws,
    env: {},
    graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  },
  {},
  {
    spawn: (command: any, args: any, options: any) => {
      const patched = { ...options, stdio: [...options.stdio] }
      patched.stdio[2] = 'inherit' // runner's own stderr (fd2 was 'ignore')
      console.log('[diag] runner stdio layout:', JSON.stringify(options.stdio))
      return spawn(command, args, patched)
    },
  },
) as any

try {
  const outcome = await child.direct
  console.log('direct outcome:', outcome)
  await child.owner.waitForExit()
  console.log('range settled OK')
} catch (error) {
  console.log('INFRASTRUCTURE ERROR:', String(error))
  await new Promise((r) => setTimeout(r, 800))
} finally {
  rmSync(ws, { recursive: true, force: true })
}
