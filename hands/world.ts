/**
 * ZhiYi Hands — DSH-backed World adapter.
 *
 * Composes the vendored DeepSeek Harness execution substrate (MIT) behind the
 * Hands provider interfaces. This file is the ONLY place that knows about cordis
 * and `@deepseek-ai/*` types; the engine and protocol layer see only
 * `HandsWorld` from providers.ts.
 *
 * Composition (all vendored sources are verbatim DSH under vendor/, run from
 * source via tsx + tsconfig paths, over the minimal `@deepseek-ai/cordis`
 * container):
 *
 *   JobGuardedSubprocessRuntime     → Windows Job-Object trees, FAIL-CLOSED
 *                                     (refuses to spawn if the Job path is
 *                                     unavailable — no silent taskkill fallback)
 *   HandsSandboxPolicyService       → ~20-line stand-in for dsh-sandbox-policy,
 *                                     carries a stable sessionId so the ACL
 *                                     backend materializes per-workspace grants
 *   SandboxedFileSystem | LocalFileSystem → fs seam (the swap IS the provider swap)
 *   PwshLocalExecutor | LocalBashExecutor | SandboxPwshExecutor → shell seam
 *   LocalSandboxProvider            → confinement: 'acl' mode wraps every shell
 *                                     argv in the Windows restricted-token runner
 *
 * Two clearly separated execution paths (PR-HANDS-01):
 *   confinement: 'none' — fenced fs + confined-less shell (P0 path, unchanged)
 *   confinement: 'acl'  — fs fence + OS-level restricted-token shell confinement
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
// probeWindowsJob is not re-exported from the package index; import the module
// directly (same vendored tree the runtime itself uses for its decision).
import { probeWindowsJob } from '../vendor/packages/subprocess/subprocess-local-src/src/windows-job.ts'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsEditRequest, FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import type { CollectedOutput, ShellExecRequest, ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import { resolveShellExecutable, type ShellExecutableIdentity } from './shell-policy.ts'
import type {
  HandsCapturedStream,
  HandsDirEntry,
  HandsEditOutcome,
  HandsEditRequest,
  HandsExecutionIdentity,
  HandsFilesystemProvider,
  HandsProcessHandle,
  HandsProcessProvider,
  HandsProcessResult,
  HandsProcessSpec,
  HandsResourceProvider,
  HandsResolvedLimits,
  HandsSandboxFacts,
  HandsSandboxMode,
  HandsWorld,
  HandsWriteGuard,
  HandsWriteOutcome,
} from './providers.ts'

/** Default process limits — the DSH executor defaults, restated as Hands resource policy. */
export const HANDS_DEFAULT_LIMITS = {
  timeoutSeconds: 120,
  maxTimeoutSeconds: 600,
  maxOutputBytes: 64_000,
  maxOutputBytesHardCap: 64 * 1024 * 1024,
} as const

/**
 * LocalSubprocessRuntime that REFUSES the uncontrolled fallback. Upstream's
 * `selectContainmentMode` silently degrades to plain `child_process.spawn` +
 * `taskkill /T` when `probeWindowsJob()` fails; this guard runs the SAME probe
 * (vendored `probeWindowsJob`) before delegating and fails the spawn instead.
 * The probe is mirrored, not bypassed: if upstream changes its selection
 * criteria, this guard must be revisited (tracked in PR-HANDS-01 report).
 */
export class JobGuardedSubprocessRuntime extends LocalSubprocessRuntime {
  constructor(ctx: Context, private readonly jobProbe: () => boolean = probeWindowsJob) {
    super(ctx)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    let available: boolean
    try {
      available = this.jobProbe()
    } catch (error) {
      throw new Error(`hands: Windows Job containment probe threw — failing closed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!available) {
      throw new Error(
        'hands: Windows Job containment unavailable — failing closed; the uncontrolled child_process+taskkill fallback is refused by Hands policy',
      )
    }
    return super.spawn(spec)
  }
}

/** Minimal stand-in for `dsh-sandbox-policy`: deployment-static mode + workspace root + stable session. */
class HandsSandboxPolicyService extends Service {
  readonly defaultMode: SandboxMode
  // Ordinary fields (not ES #private): cordis may serve services through
  // proxies, and private-field brand checks fail across proxy boundaries.
  private readonly root: string
  private readonly session: string

  constructor(ctx: Context, config: { mode: SandboxMode; workspaceRoot: string; sessionId: string }) {
    super(ctx, 'sandboxPolicy')
    this.defaultMode = config.mode
    this.root = config.workspaceRoot
    this.session = config.sessionId
  }

  resolve(): SandboxExecutionPolicy {
    return { mode: this.defaultMode, workspaceRoot: this.root, sessionId: this.session }
  }
}

/** Adapter: the DSH fs seam (Local or Sandboxed) behind `HandsFilesystemProvider`. */
class DshFilesystemProvider implements HandsFilesystemProvider {
  constructor(
    private readonly ctx: Context,
    private readonly policy: HandsSandboxPolicyService,
    readonly name: string,
    readonly sandboxMode: HandsSandboxMode,
    readonly workspaceRoot: string,
  ) {}

  async #resolve(path: string, signal?: AbortSignal): Promise<FsTarget> {
    return signal === undefined ? this.ctx.fs.resolve(path) : this.ctx.fs.resolve(path, { signal })
  }

  async readText(path: string, signal?: AbortSignal): Promise<string> {
    return this.ctx.fs.readText(await this.#resolve(path, signal), signal)
  }

  async listDir(path: string, signal?: AbortSignal): Promise<HandsDirEntry[]> {
    const target = await this.#resolve(path, signal)
    const entries = await this.ctx.fs.listDir(target, signal)
    return entries.map((entry) => {
      const mapped: HandsDirEntry = { name: entry.name, type: entry.type }
      if (entry.size !== undefined) mapped.size = entry.size
      return mapped
    })
  }

  async writeText(path: string, content: string, guard: HandsWriteGuard | undefined, signal?: AbortSignal): Promise<HandsWriteOutcome> {
    const target = await this.#resolve(path, signal)
    const outcome = await this.ctx.fs.writeText(
      target,
      content,
      guardToIntent(guard),
      signal,
      this.policy.resolve(),
    )
    return outcomeToHands(outcome, content)
  }

  async editText(path: string, edit: HandsEditRequest, guard: HandsWriteGuard | undefined, signal?: AbortSignal): Promise<HandsEditOutcome> {
    const target = await this.#resolve(path, signal)
    const request: FsEditRequest = { oldString: edit.oldText, newString: edit.newText, replaceAll: edit.replaceAll }
    const outcome = await this.ctx.fs.editText(
      target,
      request,
      guard?.expectedVersion === undefined ? undefined : { version: FsVersion(guard.expectedVersion) },
      signal,
      this.policy.resolve(),
    )
    return {
      version: outcome.version,
      bytesBefore: Buffer.byteLength(outcome.before, 'utf8'),
      bytesAfter: Buffer.byteLength(outcome.after, 'utf8'),
    }
  }
}

function guardToIntent(guard: HandsWriteGuard | undefined): FsWriteIntent | undefined {
  if (guard?.createIfAbsent === true) return { kind: 'createIfAbsent' }
  if (guard?.expectedVersion !== undefined) return { kind: 'replaceIfVersion', version: FsVersion(guard.expectedVersion) }
  return undefined
}

function outcomeToHands(outcome: FsWriteOutcome, content: string): HandsWriteOutcome {
  return {
    operation: outcome.operation,
    version: outcome.version,
    bytesWritten: Buffer.byteLength(content, 'utf8'),
  }
}

/**
 * The ACL runner invocation pinned by Hands: the upstream source-form shape
 * (`windowsAclRunnerInvocation()`'s source branch, vendored
 * sandbox-local/src/index.ts:574-583) with paths resolved HERE. Upstream derives
 * it via `import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/...')`,
 * which is environment-dependent under tsx/vitest aliasing; Hands pins the same
 * invocation deterministically through the provider's public `internals` hook.
 */
function aclRunnerInvocation(): string[] {
  const sourceEntry = fileURLToPath(new URL('../vendor/packages/sandbox/sandbox-windows-acl-src/src/runner.ts', import.meta.url))
  const sourceConfig = fileURLToPath(new URL('../vendor/tsconfig.base.json', import.meta.url))
  const registration = `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register({ tsconfig: ${JSON.stringify(sourceConfig)} });`
  return [process.execPath, '--import', `data:text/javascript,${encodeURIComponent(registration)}`, sourceEntry]
}

/** Adapter: the DSH shell seam (pwsh / bash / sandboxed pwsh) behind `HandsProcessProvider`. */
class DshShellProcessProvider implements HandsProcessProvider {
  readonly name: string
  readonly identity: HandsExecutionIdentity | undefined

  constructor(
    private readonly executor: ShellExecutor,
    shellKind: 'pwsh' | 'bash',
    identity: HandsExecutionIdentity | undefined,
  ) {
    this.name = `dsh-shell-${shellKind}`
    this.identity = identity
  }

  async run(spec: HandsProcessSpec): Promise<HandsProcessResult> {
    const execution = await this.executor.execute(this.#resolveSpec(spec, false))
    return toHandsResult(await execution.result())
  }

  async start(spec: HandsProcessSpec): Promise<HandsProcessHandle> {
    const execution = await this.executor.execute(this.#resolveSpec(spec, true))
    return {
      pid: null,
      kill: () => execution.kill(),
      wait: async () => toHandsResult(await execution.result()),
    }
  }

  async dispose(): Promise<void> {
    /* process teardown is owned by the composition's context disposal */
  }

  #resolveSpec(spec: HandsProcessSpec, background: boolean) {
    const request: ShellExecRequest = {
      command: spec.command,
      workdir: spec.workdir,
      timeoutMs: spec.timeoutMs,
      stdoutMaxBytes: spec.stdoutMaxBytes,
      signal: spec.signal,
      stdin: spec.stdin,
      env: spec.env,
      onExpiry: background ? 'none' : undefined,
    }
    return this.executor.resolve(request)
  }
}

function toHandsResult(result: ShellRunResult): HandsProcessResult {
  const sandbox: HandsSandboxFacts | undefined = result.sandbox === undefined
    ? undefined
    : {
        mode: result.sandbox.mode,
        denied: result.sandbox.denied,
        ...(result.sandbox.enforcement === undefined ? {} : { enforcement: result.sandbox.enforcement }),
        ...(result.sandbox.runnerFailed === undefined ? {} : { runnerFailed: result.sandbox.runnerFailed }),
      }
  const handsResult: HandsProcessResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    stdout: toHandsStream(result.stdout),
    stderr: toHandsStream(result.stderr),
  }
  if (sandbox !== undefined) handsResult.sandbox = sandbox
  return handsResult
}

function toHandsStream(output: CollectedOutput): HandsCapturedStream {
  const stream: HandsCapturedStream = { text: output.text, truncated: output.truncated }
  if (output.spillPath !== undefined) stream.spillPath = output.spillPath
  return stream
}

/** Resource policy: DSH executor defaults, restated as Hands-side enforcement. */
class DefaultResourceProvider implements HandsResourceProvider {
  readonly name = 'hands-default-resource'

  resolve(limits: { timeoutSeconds?: number; maxStdoutBytes?: number; maxStderrBytes?: number }): HandsResolvedLimits {
    const timeoutSeconds = clamp(limits.timeoutSeconds ?? HANDS_DEFAULT_LIMITS.timeoutSeconds, 1, HANDS_DEFAULT_LIMITS.maxTimeoutSeconds)
    return {
      timeoutMs: timeoutSeconds * 1000,
      stdoutMaxBytes: Math.round(clamp(limits.maxStdoutBytes ?? HANDS_DEFAULT_LIMITS.maxOutputBytes, 1, HANDS_DEFAULT_LIMITS.maxOutputBytesHardCap)),
      stderrMaxBytes: Math.round(clamp(limits.maxStderrBytes ?? HANDS_DEFAULT_LIMITS.maxOutputBytes, 1, HANDS_DEFAULT_LIMITS.maxOutputBytesHardCap)),
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export interface DshWorldOptions {
  /** Absolute canonical workspace root for fs resolution and the write fence. */
  workspaceRoot: string
  /** Deployment sandbox default. Default 'workspace-write'. */
  sandboxMode?: HandsSandboxMode
  /** Shell executor kind. Default 'pwsh'. Bash has no ACL confinement path. */
  shell?: 'pwsh' | 'bash'
  /**
   * Explicit shell executable — verified by the shell policy (MSIX aliases and
   * non-PowerShell binaries rejected). Default: native Windows PowerShell 5.1,
   * else an installed pwsh 7; PATH is never consulted.
   */
  shellExecutablePath?: string
  /**
   * Set false to skip shell-policy verification (TESTS ONLY — never in the
   * normal or isolated execution paths).
   */
  enforceShellPolicy?: boolean
  /** Mount SandboxedFileSystem (write fence) instead of bare LocalFileSystem. Default true. */
  fencedFilesystem?: boolean
  /** Process-tree kill grace in ms. Default 3000. */
  graceMs?: number
  /**
   * Refuse uncontrolled process spawns when Windows Job containment is
   * unavailable (default true). The probe is injectable for fail-closed tests.
   */
  requireJobContainment?: boolean
  /** Test/ops seam over the Job availability probe. */
  jobProbe?: () => boolean
  /**
   * Execution path selection:
   * - 'none' (default): shell runs unconfined behind the fs fence (P0 path)
   * - 'acl': shell argv is wrapped in the Windows restricted-token runner
   *   (OS-level workspace-write enforcement; pwsh only)
   */
  confinement?: 'none' | 'acl'
  /** Stable sandbox session identity (ACL grants are cached per session×workspace). */
  sessionId?: string
}

/**
 * Build a `HandsWorld` over the vendored DSH execution substrate.
 */
export async function createDshWorld(options: DshWorldOptions): Promise<HandsWorld & { readonly context: Context }> {
  const sandboxMode: SandboxMode = options.sandboxMode ?? 'workspace-write'
  const confinement = options.confinement ?? 'none'
  if (confinement === 'acl' && sandboxMode === 'danger-full-access') {
    throw new Error('hands: confinement "acl" refuses sandboxMode "danger-full-access" — that combination bypasses confinement entirely')
  }
  if (confinement === 'acl' && options.shell === 'bash') {
    throw new Error('hands: ACL confinement is wired for the pwsh executor only in this round')
  }

  // Shell identity FIRST: fail composition on any unverified executable.
  let shellIdentity: ShellExecutableIdentity | undefined
  if ((options.shell ?? 'pwsh') === 'pwsh' && (options.enforceShellPolicy ?? true)) {
    shellIdentity = resolveShellExecutable(options.shellExecutablePath)
  } else if (options.shellExecutablePath !== undefined) {
    // enforceShellPolicy=false: pass through verbatim (adversarial-path tests only).
    shellIdentity = undefined
  }

  const jobProbe = options.jobProbe ?? probeWindowsJob
  if ((options.requireJobContainment ?? true) && process.platform === 'win32' && !jobProbe()) {
    throw new Error('hands: Windows Job containment unavailable at composition — refusing to create a world with an uncontrolled spawn path')
  }

  const ctx = new Context()
  if (options.requireJobContainment ?? true) {
    // Direct construction (P0 pattern): the cordis Service constructor
    // self-registers as ctx.subprocess; plugin() has no extra-arg channel.
    new JobGuardedSubprocessRuntime(ctx, jobProbe)
  } else {
    await ctx.plugin(LocalSubprocessRuntime)
  }
  // Service subclasses self-register in the constructor (super(ctx, name)).
  const policy = new HandsSandboxPolicyService(ctx, {
    mode: sandboxMode,
    workspaceRoot: options.workspaceRoot,
    sessionId: options.sessionId ?? 'hands:default',
  })
  if (options.fencedFilesystem ?? true) {
    await ctx.plugin(SandboxedFileSystem, { cwd: options.workspaceRoot })
  } else {
    await ctx.plugin(LocalFileSystem, { cwd: options.workspaceRoot })
  }

  let identity: HandsExecutionIdentity | undefined
  const jobContainment: HandsExecutionIdentity['jobContainment'] = (options.requireJobContainment ?? true) ? 'windows-job' : 'native-fallback'
  if (confinement === 'acl') {
    await ctx.plugin(LocalSandboxProvider, {})
    // Pin the source-form runner invocation deterministically (see aclRunnerInvocation).
    ;(ctx.sandbox as LocalSandboxProvider).internals.windowsAclRunnerArgs = aclRunnerInvocation()
    await ctx.plugin(SandboxPwshExecutor, {
      cwd: options.workspaceRoot,
      graceMs: options.graceMs ?? 3000,
      ...(shellIdentity === undefined && options.shellExecutablePath !== undefined
        ? { pwshPath: options.shellExecutablePath }
        : shellIdentity === undefined
          ? {}
          : { pwshPath: shellIdentity.path }),
    })
    identity = {
      executable: shellIdentity === undefined
        ? { path: options.shellExecutablePath ?? 'unverified', sha256: '', sizeBytes: 0, source: 'policy-disabled' }
        : { path: shellIdentity.path, sha256: shellIdentity.sha256, sizeBytes: shellIdentity.sizeBytes, source: shellIdentity.source },
      confinement: 'acl',
      jobContainment,
    }
  } else if ((options.shell ?? 'pwsh') === 'pwsh') {
    await ctx.plugin(PwshLocalExecutor, {
      cwd: options.workspaceRoot,
      graceMs: options.graceMs ?? 3000,
      ...(shellIdentity === undefined && options.shellExecutablePath !== undefined
        ? { pwshPath: options.shellExecutablePath }
        : shellIdentity === undefined
          ? {}
          : { pwshPath: shellIdentity.path }),
    })
    identity = shellIdentity === undefined
      ? undefined
      : {
          executable: { path: shellIdentity.path, sha256: shellIdentity.sha256, sizeBytes: shellIdentity.sizeBytes, source: shellIdentity.source },
          confinement: 'none',
          jobContainment,
        }
  } else {
    await ctx.plugin(LocalBashExecutor, { cwd: options.workspaceRoot, graceMs: options.graceMs ?? 3000 })
  }

  const filesystem = new DshFilesystemProvider(
    ctx,
    policy,
    (options.fencedFilesystem ?? true) ? 'dsh-sandboxed-fs' : 'dsh-local-fs',
    sandboxMode,
    options.workspaceRoot,
  )
  const processProvider = new DshShellProcessProvider(ctx.shell, options.shell ?? 'pwsh', identity)

  return {
    filesystem,
    process: processProvider,
    resource: new DefaultResourceProvider(),
    context: ctx,
    dispose: () => ctx.fiber.dispose(),
  }
}
