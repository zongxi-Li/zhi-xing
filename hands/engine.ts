/**
 * ZhiYi Hands P0 — execution engine.
 *
 * The engine is deliberately thin: validate the protocol envelope, authorize the
 * grant, resolve limits through the resource provider, dispatch to exactly one
 * capability handler over the Execution World, and seal a self-contained receipt.
 * It never sees cordis/DSH types, holds no execution state beyond idempotency
 * bookkeeping, and can be driven headless (no LLM, no planner).
 */

import { createHash } from 'node:crypto'
import {
  canonicalChecksum,
  HANDS_ERROR_CODES,
  HANDS_PROTOCOL_VERSION,
  HandsProtocolError,
  rejectInlineAuthority,
  type HandsCapabilityId,
  type HandsErrorBody,
  type HandsExecutionReceipt,
  type HandsExecutionRequest,
  type HandsIdentityRef,
  type HandsReceiptStatus,
} from './protocol.ts'
import { authorizeGrant, HandsAuthorizationError, type HandsGrantRegistry } from './grants.ts'
import type { HandsWorld } from './providers.ts'

export interface HandsEngineOptions {
  world: HandsWorld
  grants: HandsGrantRegistry
  now?: () => Date
}

interface FsReadInput {
  path: string
}
interface FsListInput {
  path: string
}
interface FsWriteInput {
  path: string
  content: string
  createIfAbsent?: boolean
  expectedVersion?: string
}
interface FsPatchInput {
  path: string
  oldText: string
  newText: string
  replaceAll?: boolean
  expectedVersion?: string
}
interface ShellExecInput {
  command: string
  workdir?: string
}

export class HandsEngine {
  readonly #world: HandsWorld
  readonly #grants: HandsGrantRegistry
  readonly #now: () => Date

  constructor(options: HandsEngineOptions) {
    this.#world = options.world
    this.#grants = options.grants
    this.#now = options.now ?? (() => new Date())
  }

  async execute(request: HandsExecutionRequest, callerSignal?: AbortSignal): Promise<HandsExecutionReceipt> {
    const startedAt = this.#now().toISOString()
    const base: {
      protocolVersion: string
      requestId: string
      invocationId: string
      capabilityId: HandsCapabilityId
      grantId: string
      identity?: HandsIdentityRef
      idempotencyKey: string
    } = {
      protocolVersion: HANDS_PROTOCOL_VERSION,
      requestId: request.requestId,
      invocationId: request.invocationId,
      capabilityId: request.capabilityId,
      grantId: request.authorization.grantId,
      idempotencyKey: request.idempotencyKey,
    }
    if (request.identity !== undefined) base.identity = request.identity

    // Contract enforcement at the boundary: execution scope is system-issued via
    // authorization references, never declared by the caller, regardless of how
    // the typed request was constructed.
    try {
      rejectInlineAuthority(request.input)
    } catch (error) {
      if (error instanceof HandsProtocolError) {
        return this.#seal(base, startedAt, 'failed', undefined, { code: error.code, retryable: false, message: error.message })
      }
      throw error
    }

    try {
      const grant = this.#grants.get(request.authorization.grantId)
      authorizeGrant(grant, {
        workspaceId: request.authorization.workspaceId,
        capabilityId: request.capabilityId,
        worldRoot: this.#world.filesystem.workspaceRoot,
        now: this.#now(),
      })
    } catch (error) {
      if (error instanceof HandsAuthorizationError) {
        return this.#seal(base, startedAt, 'failed', undefined, { code: error.code, retryable: error.retryable, message: error.message })
      }
      throw error
    }

    const limits = this.#world.resource.resolve(request.limits)
    const controller = new AbortController()
    const onCallerAbort = () => controller.abort()
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort()
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
    }

    try {
      const output = await this.#dispatch(request.capabilityId, request.input, limits, controller.signal)
      const aborted = (output as { __aborted?: boolean }).__aborted === true
      delete (output as { __aborted?: boolean }).__aborted
      if (aborted) {
        return this.#seal(base, startedAt, 'cancelled', output, {
          code: HANDS_ERROR_CODES.CANCELLED,
          retryable: true,
          message: 'execution cancelled by the caller',
        })
      }
      return this.#seal(base, startedAt, 'completed', output)
    } catch (error) {
      if (controller.signal.aborted && !isFsAborted(error)) {
        return this.#seal(base, startedAt, 'cancelled', undefined, {
          code: HANDS_ERROR_CODES.CANCELLED,
          retryable: true,
          message: 'execution cancelled by the caller before completion',
        })
      }
      const body = mapExecutionError(error)
      return this.#seal(base, startedAt, 'failed', undefined, body)
    } finally {
      callerSignal?.removeEventListener('abort', onCallerAbort)
    }
  }

  async #dispatch(
    capabilityId: HandsCapabilityId,
    input: Record<string, unknown>,
    limits: { timeoutMs: number; stdoutMaxBytes: number; stderrMaxBytes: number },
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    switch (capabilityId) {
      case 'fs.read':
      case 'fs.list':
      case 'fs.write':
      case 'fs.patch':
        return this.#dispatchFs(capabilityId, input, signal)
      case 'shell.exec':
        return this.#dispatchShell(input, limits, signal)
    }
  }

  async #dispatchFs(capabilityId: HandsCapabilityId, input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const fs = this.#world.filesystem
    switch (capabilityId) {
      case 'fs.read': {
        const { path } = requireInput<FsReadInput>(input, ['path'])
        const text = await fs.readText(path, signal)
        return { path, text, bytes: Buffer.byteLength(text, 'utf8') }
      }
      case 'fs.list': {
        const { path } = requireInput<FsListInput>(input, ['path'])
        const entries = await fs.listDir(path, signal)
        return { path, entries }
      }
      case 'fs.write': {
        const { path, content, createIfAbsent, expectedVersion } = requireInput<FsWriteInput>(input, ['path', 'content'])
        if (typeof content !== 'string') throw new HandsProtocolError(HANDS_ERROR_CODES.INVALID_REQUEST, 'input.content must be a string')
        const guard: { createIfAbsent?: boolean; expectedVersion?: string } = {}
        if (createIfAbsent !== undefined) guard.createIfAbsent = createIfAbsent
        if (expectedVersion !== undefined) guard.expectedVersion = expectedVersion
        const outcome = await fs.writeText(path, content, guard, signal)
        return { path, ...outcome }
      }
      case 'fs.patch': {
        const { path, oldText, newText, replaceAll, expectedVersion } = requireInput<FsPatchInput>(input, ['path', 'oldText', 'newText'])
        const guard: { expectedVersion?: string } = {}
        if (expectedVersion !== undefined) guard.expectedVersion = expectedVersion
        const outcome = await fs.editText(path, { oldText, newText, replaceAll: replaceAll ?? false }, guard, signal)
        return { path, ...outcome }
      }
      default:
        throw new HandsProtocolError(HANDS_ERROR_CODES.INVALID_REQUEST, `capability ${capabilityId} is not a filesystem capability`)
    }
  }

  async #dispatchShell(
    input: Record<string, unknown>,
    limits: { timeoutMs: number; stdoutMaxBytes: number; stderrMaxBytes: number },
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const { command, workdir } = requireInput<ShellExecInput>(input, ['command'])
    const spec: Parameters<HandsWorld['process']['run']>[0] = {
      command,
      timeoutMs: limits.timeoutMs,
      stdoutMaxBytes: limits.stdoutMaxBytes,
      signal,
    }
    if (workdir !== undefined) spec.workdir = workdir
    const result = await this.#world.process.run(spec)
    const identity = this.#world.process.identity
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aborted: result.aborted,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.sandbox === undefined ? {} : { sandbox: result.sandbox }),
      // Verified execution identity — what actually ran the command (receipt-grade).
      ...(identity === undefined ? {} : { executedBy: identity }),
      // Sentinel consumed by execute(): a caller-aborted kill is a CANCELLED receipt.
      __aborted: result.aborted,
    }
  }

  #seal(
    base: {
      protocolVersion: string
      requestId: string
      invocationId: string
      capabilityId: string
      grantId: string
      identity?: HandsIdentityRef
      idempotencyKey: string
    },
    startedAt: string,
    status: HandsReceiptStatus,
    output?: Record<string, unknown>,
    error?: HandsErrorBody,
  ): HandsExecutionReceipt {
    const completedAt = this.#now().toISOString()
    const receipt: HandsExecutionReceipt = {
      protocolVersion: base.protocolVersion,
      requestId: base.requestId,
      invocationId: base.invocationId,
      capabilityId: base.capabilityId as HandsCapabilityId,
      grantId: base.grantId,
      status,
      startedAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      ...(output === undefined ? {} : { output }),
      ...(error === undefined ? {} : { error }),
      checksum: '',
      ...(base.identity === undefined ? {} : { identity: base.identity }),
      idempotencyKey: base.idempotencyKey,
    }
    receipt.checksum = receiptChecksum(receipt)
    return receipt
  }
}

/** Checksum covers every meaningful receipt field except the checksum itself. */
export function receiptChecksum(receipt: Omit<HandsExecutionReceipt, 'checksum'> & { checksum?: string }): string {
  const { checksum: _ignored, ...rest } = receipt
  return canonicalChecksum(rest)
}

function requireInput<T>(input: Record<string, unknown>, required: readonly string[]): T {
  for (const field of required) {
    if (input[field] === undefined) {
      throw new HandsProtocolError(HANDS_ERROR_CODES.INVALID_REQUEST, `input.${field} is required`)
    }
  }
  return input as T
}

/** Map an execution failure onto the receipt's sanitized error body. */
function mapExecutionError(error: unknown): HandsErrorBody {
  if (error instanceof HandsProtocolError) {
    return { code: error.code, retryable: false, message: error.message }
  }
  if (isDshError(error)) {
    const retryable = error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_OBSERVED' || error.code === 'FS_ABORTED'
    return { code: error.code, retryable, message: error.message }
  }
  if (error instanceof Error) {
    return { code: HANDS_ERROR_CODES.EXECUTION_FAILED, retryable: false, message: `${error.name}: ${error.message}` }
  }
  return { code: HANDS_ERROR_CODES.EXECUTION_FAILED, retryable: false, message: String(error) }
}

function isDshError(error: unknown): error is { code: string; message: string } {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string'
}

function isFsAborted(error: unknown): boolean {
  return isDshError(error) && error.code === 'FS_ABORTED'
}

/** sha256 helper re-exported so tests can verify receipts without importing protocol directly. */
export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
