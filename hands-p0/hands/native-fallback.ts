/**
 * ZhiYi Hands P0 — native fallback process provider (Hands-owned code, no DSH).
 *
 * A deliberately independent second implementation of `HandsProcessProvider` that
 * proves the provider seam: same protocol, same receipts, different execution
 * mechanics. It runs commands through Windows PowerShell 5.1 (`powershell.exe`,
 * always present on Windows) via plain `node:child_process`, collects capped
 * output, and kills the tree with `taskkill /PID <pid> /T /F` — the best-effort
 * fallback documented in DSH's own spawn path. This is the shape a future
 * non-DSH (or remote) provider plugs in through.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type {
  HandsCapturedStream,
  HandsExecutionIdentity,
  HandsProcessHandle,
  HandsProcessProvider,
  HandsProcessResult,
  HandsProcessSpec,
} from './providers.ts'

const WINDOWS_POWERSHELL = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

/** Identity of the executable this provider actually spawns (Windows PowerShell 5.1). */
function fallbackIdentity(): HandsExecutionIdentity {
  const stat = statSync(WINDOWS_POWERSHELL)
  const sha256 = createHash('sha256').update(readFileSync(WINDOWS_POWERSHELL)).digest('hex')
  return {
    executable: { path: WINDOWS_POWERSHELL, sha256, sizeBytes: stat.size, source: 'native-windows-powershell' },
    confinement: 'none',
    jobContainment: 'native-fallback',
  }
}

export class NativeFallbackProcessProvider implements HandsProcessProvider {
  readonly name = 'native-fallback-powershell'
  readonly identity: HandsExecutionIdentity = fallbackIdentity()
  readonly #live = new Set<ChildProcess>()
  #disposed = false

  async run(spec: HandsProcessSpec): Promise<HandsProcessResult> {
    return (await this.start(spec)).wait()
  }

  async start(spec: HandsProcessSpec): Promise<HandsProcessHandle> {
    if (this.#disposed) throw new Error('provider disposed')
    let firstCause: 'timeout' | 'abort' | undefined
    if (spec.signal) {
      if (spec.signal.aborted) firstCause = 'abort'
      else spec.signal.addEventListener('abort', () => finish('abort'), { once: true })
    }
    const timeoutMs = spec.timeoutMs ?? 120_000
    const timer = setTimeout(() => finish('timeout'), timeoutMs)

    const child = spawn(
      WINDOWS_POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ${spec.command}`],
      {
        cwd: spec.workdir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spec.env === undefined ? undefined : { ...process.env, ...spec.env },
      },
    )
    this.#live.add(child)

    const stdout = new StreamSink(spec.stdoutMaxBytes ?? 64_000)
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    const stderr = new StreamSink(64_000)
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

    const exited = waitForExit(child)
    let settled = false
    const exit = { code: null as number | null, signal: null as string | null }

    function finish(cause: 'timeout' | 'abort') {
      if (firstCause === undefined) firstCause = cause
      killTree(child)
    }

    const handle: HandsProcessHandle = {
      pid: child.pid ?? null,
      kill: () => {
        if (settled || child.exitCode !== null || child.signalCode !== null) return false
        killTree(child)
        return true
      },
      wait: async () => {
        const status = await exited
        if (!settled) {
          settled = true
          exit.code = status.exitCode
          exit.signal = status.signal
        }
        clearTimeout(timer)
        this.#live.delete(child)
        return {
          exitCode: exit.code,
          signal: exit.signal,
          timedOut: firstCause === 'timeout',
          aborted: firstCause === 'abort',
          stdout: stdout.snapshot(),
          stderr: stderr.snapshot(),
        }
      },
    }
    return handle
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    for (const child of this.#live) killTree(child)
    await Promise.allSettled([...this.#live].map((child) => waitForExit(child)))
  }
}

/** Best-effort whole-tree termination; outcome unchecked (DSH fallback semantics). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.pid === null) {
    child.kill()
    return
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      child.kill()
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
}

interface ExitStatus {
  exitCode: number | null
  signal: string | null
}

function waitForExit(child: ChildProcess): Promise<ExitStatus> {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit({ exitCode: child.exitCode, signal: child.signalCode })
      return
    }
    child.once('exit', (code, signal) => resolveExit({ exitCode: code, signal }))
    child.once('error', () => resolveExit({ exitCode: null, signal: null }))
  })
}

/** Capped tail sink: keeps the last `maxBytes` bytes, flags truncation. */
class StreamSink {
  #chunks: Buffer[] = []
  #bytes = 0
  truncated = false

  constructor(readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.#chunks.push(chunk)
    this.#bytes += chunk.byteLength
    if (this.#bytes > this.maxBytes) {
      this.truncated = true
      while (this.#bytes - this.#chunks[0]!.byteLength >= this.maxBytes && this.#chunks.length > 1) {
        this.#bytes -= this.#chunks.shift()!.byteLength
      }
      const overflow = this.#bytes - this.maxBytes
      if (overflow > 0 && this.#chunks.length > 0) {
        this.#chunks[0] = this.#chunks[0]!.subarray(overflow)
        this.#bytes -= overflow
      }
    }
  }

  snapshot(): HandsCapturedStream {
    return { text: Buffer.concat(this.#chunks).toString('utf8'), truncated: this.truncated }
  }
}
