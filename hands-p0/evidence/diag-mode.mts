import { probeWindowsJob } from '../vendor/packages/subprocess/subprocess-local-src/src/windows-job.ts'
import { spawnRunnerInvocation, runnerInvocationAvailable } from '../vendor/packages/subprocess/subprocess-local-src/src/runner-launch.ts'
import { loadWin32ProcessBindings, probeCurrentTokenJobSupport } from '../vendor/packages/subprocess/win32-process-src/src/index.ts'

const invocation = spawnRunnerInvocation()
console.log('runner invocation ok:', runnerInvocationAvailable(invocation), JSON.stringify(invocation.slice(0, 2)))
try {
  const api = loadWin32ProcessBindings()
  probeCurrentTokenJobSupport(api)
  console.log('probeCurrentTokenJobSupport: OK')
} catch (error) {
  console.log('probeCurrentTokenJobSupport FAILED:', error instanceof Error ? error.message : error)
}
console.log('probeWindowsJob:', probeWindowsJob())
