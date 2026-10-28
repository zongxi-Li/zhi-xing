/**
 * ZhiYi Hands P0 — the Execution World boundary.
 *
 * These interfaces are the replaceable seam between the Hands protocol/engine and
 * any system-execution implementation (local processes today; Windows ACL sandbox,
 * remote executor, or a Linux/QEMU teaching kernel tomorrow). The engine and the
 * protocol layer depend ONLY on these types — never on DSH/cordis types, which are
 * confined to the world adapters. This is the "Execution World" required by the
 * Hands constraints: system APIs on one side, tool implementations on the other.
 */

/** Sandbox mode vocabulary aligned with the ZhiYi `ExecutionSecurityProfile` tiers. */
export type HandsSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface HandsDirEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  size?: number
}

export interface HandsWriteGuard {
  /** Reject (instead of create-or-overwrite) when the target already exists. */
  createIfAbsent?: boolean
  /** Opaque freshness token from a previous stat/write — write only if unchanged. */
  expectedVersion?: string
}

export interface HandsWriteOutcome {
  operation: 'create' | 'update'
  version: string
  bytesWritten: number
}

export interface HandsEditRequest {
  oldText: string
  newText: string
  replaceAll: boolean
}

export interface HandsEditOutcome {
  version: string
  bytesBefore: number
  bytesAfter: number
}

/**
 * Filesystem execution surface. Implementations MUST enforce the sandbox policy on
 * every mutation (reads are always permitted); `sandboxMode` reports the configured
 * default for receipts and policy introspection.
 */
export interface HandsFilesystemProvider {
  readonly name: string
  readonly sandboxMode: HandsSandboxMode
  readonly workspaceRoot: string
  readText(path: string, signal?: AbortSignal): Promise<string>
  listDir(path: string, signal?: AbortSignal): Promise<HandsDirEntry[]>
  writeText(path: string, content: string, guard: HandsWriteGuard | undefined, signal?: AbortSignal): Promise<HandsWriteOutcome>
  editText(path: string, edit: HandsEditRequest, guard: HandsWriteGuard | undefined, signal?: AbortSignal): Promise<HandsEditOutcome>
}

export interface HandsCapturedStream {
  text: string
  truncated: boolean
  spillPath?: string
}

export interface HandsProcessSpec {
  command: string
  workdir?: string
  timeoutMs?: number
  stdoutMaxBytes?: number
  stdin?: string
  env?: Record<string, string>
  signal?: AbortSignal
}

export interface HandsProcessResult {
  exitCode: number | null
  signal: string | null
  /** True when the provider's own timeout was the first cause to kill the command. */
  timedOut: boolean
  /** True when the caller's abort signal was the first cause to kill the command. */
  aborted: boolean
  stdout: HandsCapturedStream
  stderr: HandsCapturedStream
  /** OS-level confinement facts, present iff the provider ran the command confined. */
  sandbox?: HandsSandboxFacts
}

/** OS-level confinement facts for one execution (mirrors DSH ShellSandboxInfo). */
export interface HandsSandboxFacts {
  /** The mode the command actually ran under. */
  mode: HandsSandboxMode
  /** Whether the sandbox denied a file operation (classified from output). */
  denied: boolean
  /** How completely the backend enforced the mode ('partial' for the Windows ACL backend). */
  enforcement?: 'full' | 'partial'
  /** Whether the confinement runner failed before the command could run. */
  runnerFailed?: boolean
}

/** Verified identity of what actually executed — recorded into receipts. */
export interface HandsExecutionIdentity {
  /** The pinned shell executable the command ran through. */
  executable: {
    path: string
    sha256: string
    sizeBytes: number
    source: string
  }
  /** Confinement chain in front of the shell. */
  confinement: 'none' | 'acl'
  /** Process-tree containment mechanism behind the shell. */
  jobContainment: 'windows-job' | 'native-fallback'
}

export interface HandsProcessHandle {
  /** OS pid of the direct child when known. */
  pid: number | null
  /** Kill the whole managed process tree. Idempotent; false when already finished. */
  kill(): boolean
  /** Settles with the full result; never rejects. */
  wait(): Promise<HandsProcessResult>
}

/**
 * Process execution surface. Implementations MUST own deadline and cancellation:
 * a `timeoutMs` expiry or `signal` abort kills the whole process tree, and the
 * result classifies exactly one first cause (`timedOut` xor `aborted`).
 */
export interface HandsProcessProvider {
  readonly name: string
  /** Verified execution identity for receipts; absent when the provider does not pin one. */
  readonly identity?: HandsExecutionIdentity
  run(spec: HandsProcessSpec): Promise<HandsProcessResult>
  start(spec: HandsProcessSpec): Promise<HandsProcessHandle>
  dispose(): Promise<void>
}

export interface HandsResolvedLimits {
  timeoutMs: number
  stdoutMaxBytes: number
  stderrMaxBytes: number
}

/**
 * Resource policy surface: turns protocol limits into concrete execution bounds.
 * P0 enforces timeouts and output budgets; quotas/costs are future work.
 */
export interface HandsResourceProvider {
  readonly name: string
  resolve(limits: { timeoutSeconds?: number; maxStdoutBytes?: number; maxStderrBytes?: number }): HandsResolvedLimits
}

/** The whole replaceable execution world handed to the engine. */
export interface HandsWorld {
  filesystem: HandsFilesystemProvider
  process: HandsProcessProvider
  resource: HandsResourceProvider
  dispose(): Promise<void>
}
