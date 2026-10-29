/**
 * ZhiYi Hands — durable Execution Ledger (HANDS-02B).
 *
 * Append-only JSONL with fsync-per-record. Every admission is persisted
 * BEFORE dispatch; every terminal state (with its receipt) is persisted
 * BEFORE the client can observe it. On restart the file is replayed to
 * rebuild the in-memory index, and reconcile() classifies the unfinished:
 *
 *   RECEIVED / AUTHORIZED          → FAILED  HANDS_ABANDONED_BY_RESTART
 *                                     (dispatch never began: no side effects;
 *                                      retryable — the client may re-run under
 *                                      a NEW idempotency key)
 *   STARTED (running)              → UNKNOWN HANDS_RESTARTED_DURING_EXECUTION
 *                                     (side effects may exist; NEVER auto-
 *                                      retried; awaits operator reconciliation)
 *
 * Terminal states are COMPLETED / FAILED / CANCELLED / UNKNOWN — the first
 * three carry a receipt; UNKNOWN deliberately does not (nothing about the
 * outcome is confirmed, so no receipt may be minted).
 *
 * Idempotency: uniqueness of (callerId, idempotencyKey). Same key + same
 * request digest → the SAME execution record is returned (never re-executed).
 * Same key + different digest → explicit rejection. Nonce replay is a
 * separate transport-level mechanism (hands/auth.ts) and never substitutes
 * for this.
 */

import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalChecksum, HANDS_PROTOCOL_VERSION, type HandsCapabilityId, type HandsExecutionReceipt } from './protocol.ts'

export const LEDGER_STATES = ['RECEIVED', 'AUTHORIZED', 'STARTED', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN'] as const
export type LedgerState = (typeof LEDGER_STATES)[number]
export const TERMINAL_STATES: readonly LedgerState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN']
/** States in which execution had begun — side effects may exist. */
export const SIDE_EFFECT_STATES: readonly LedgerState[] = ['STARTED']

export const ABANDONED_BY_RESTART = 'HANDS_ABANDONED_BY_RESTART'
export const RESTARTED_DURING_EXECUTION = 'HANDS_RESTARTED_DURING_EXECUTION'

export interface LedgerRequestSummary {
  capabilityId: HandsCapabilityId
  requestId: string
  invocationId: string
  workspaceId: string
  /** Caller identity from the HMAC credential, NOT from the request body. */
  callerId: string
}

export interface ExecutionRecord {
  executionId: string
  callerId: string
  idempotencyKey: string
  /** sha256 over the RAW request body — binds the record to the exact bytes. */
  requestDigest: string
  summary: LedgerRequestSummary
  state: LedgerState
  cancelRequested: boolean
  createdAt: string
  updatedAt: string
  receipt?: HandsExecutionReceipt
  /** Populated for UNKNOWN (reconciliation hint). */
  reconciliation?: { reason: string }
}

type LedgerLine =
  | { t: 'claim'; executionId: string; callerId: string; idempotencyKey: string; requestDigest: string; summary: LedgerRequestSummary; ts: string }
  | { t: 'state'; executionId: string; state: LedgerState; ts: string }
  | { t: 'cancel-requested'; executionId: string; ts: string }
  | { t: 'receipt'; executionId: string; receipt: HandsExecutionReceipt; ts: string }
  | { t: 'unknown'; executionId: string; reason: string; ts: string }

export function newExecutionId(): string {
  return `xhexec_${randomBytes(12).toString('hex')}`
}

function idempotencySlot(callerId: string, key: string): string {
  return `${callerId}\u0000${key}`
}

function syntheticReceipt(record: ExecutionRecord, status: 'failed', error: { code: string; retryable: boolean; message: string }): HandsExecutionReceipt {
  const receipt: HandsExecutionReceipt = {
    protocolVersion: HANDS_PROTOCOL_VERSION,
    requestId: record.summary.requestId,
    invocationId: record.summary.invocationId,
    capabilityId: record.summary.capabilityId,
    grantId: 'server-side-reconciliation',
    status,
    startedAt: record.createdAt,
    completedAt: record.updatedAt,
    durationMs: 0,
    error,
    checksum: '',
    idempotencyKey: record.idempotencyKey,
  }
  receipt.checksum = canonicalChecksum(receipt)
  return receipt
}

export class ExecutionLedger {
  readonly #records = new Map<string, ExecutionRecord>()
  readonly #byIdempotency = new Map<string, string>()
  readonly #path: string
  #fd: number | undefined

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.#path = join(dataDir, 'ledger.jsonl')
    if (existsSync(this.#path)) this.#load()
    this.#fd = openSync(this.#path, 'a')
  }

  #append(line: LedgerLine): void {
    if (this.#fd === undefined) throw new Error('ledger closed')
    writeSync(this.#fd, `${JSON.stringify(line)}\n`)
    fsyncSync(this.#fd)
  }

  #load(): void {
    for (const raw of readFileSync(this.#path, 'utf8').split('\n')) {
      if (raw.trim() === '') continue
      let parsed: LedgerLine
      try {
        parsed = JSON.parse(raw) as LedgerLine
      } catch {
        continue // torn tail line from a crash mid-write: append-only replay, first-wins
      }
      switch (parsed.t) {
        case 'claim': {
          const slot = idempotencySlot(parsed.callerId, parsed.idempotencyKey)
          if (this.#byIdempotency.has(slot)) break // duplicate claim line: first wins
          this.#byIdempotency.set(slot, parsed.executionId)
          this.#records.set(parsed.executionId, {
            executionId: parsed.executionId,
            callerId: parsed.callerId,
            idempotencyKey: parsed.idempotencyKey,
            requestDigest: parsed.requestDigest,
            summary: parsed.summary,
            state: 'RECEIVED',
            cancelRequested: false,
            createdAt: parsed.ts,
            updatedAt: parsed.ts,
          })
          break
        }
        case 'state': {
          const record = this.#records.get(parsed.executionId)
          if (record !== undefined && !TERMINAL_STATES.includes(record.state)) {
            record.state = parsed.state
            record.updatedAt = parsed.ts
          }
          break
        }
        case 'cancel-requested': {
          const record = this.#records.get(parsed.executionId)
          if (record !== undefined) record.cancelRequested = true
          break
        }
        case 'receipt': {
          const record = this.#records.get(parsed.executionId)
          if (record !== undefined) record.receipt = parsed.receipt
          break
        }
        case 'unknown': {
          const record = this.#records.get(parsed.executionId)
          if (record !== undefined && !TERMINAL_STATES.includes(record.state)) {
            record.state = 'UNKNOWN'
            record.reconciliation = { reason: parsed.reason }
          }
          break
        }
      }
    }
  }

  /**
   * Claim the (callerId, idempotencyKey) slot for one execution.
   * Same digest → {claimed:false} with the existing record (replay: return it,
   * do NOT re-run). Different digest → {claimed:false, conflict:true}.
   */
  claim(input: { callerId: string; idempotencyKey: string; requestDigest: string; summary: LedgerRequestSummary }):
    { claimed: true; record: ExecutionRecord } | { claimed: false; conflict: boolean; existing?: ExecutionRecord } {
    const slot = idempotencySlot(input.callerId, input.idempotencyKey)
    const existingId = this.#byIdempotency.get(slot)
    if (existingId !== undefined) {
      const existing = this.#records.get(existingId)
      if (existing !== undefined && existing.requestDigest === input.requestDigest) {
        return { claimed: false, conflict: false, existing }
      }
      return { claimed: false, conflict: true, existing }
    }
    const ts = new Date().toISOString()
    const executionId = newExecutionId()
    this.#append({
      t: 'claim', executionId, callerId: input.callerId, idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest, summary: input.summary, ts,
    })
    const record: ExecutionRecord = {
      executionId,
      callerId: input.callerId,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      summary: input.summary,
      state: 'RECEIVED',
      cancelRequested: false,
      createdAt: ts,
      updatedAt: ts,
    }
    this.#byIdempotency.set(slot, executionId)
    this.#records.set(executionId, record)
    return { claimed: true, record }
  }

  /** Persist a state transition (transitions out of terminal states are ignored). */
  setState(executionId: string, state: LedgerState): void {
    const record = this.#records.get(executionId)
    if (record === undefined) throw new Error(`unknown execution ${executionId}`)
    if (TERMINAL_STATES.includes(record.state)) return
    const ts = new Date().toISOString()
    this.#append({ t: 'state', executionId, state, ts })
    record.state = state
    record.updatedAt = ts
  }

  /** Record a cancellation REQUEST (distinct from the terminal cancelled state). */
  markCancelRequested(executionId: string): void {
    const record = this.#records.get(executionId)
    if (record === undefined || record.cancelRequested) return
    const ts = new Date().toISOString()
    this.#append({ t: 'cancel-requested', executionId, ts })
    record.cancelRequested = true
    record.updatedAt = ts
  }

  /** Persist the terminal receipt — before the client observes the terminal state. */
  attachReceipt(executionId: string, receipt: HandsExecutionReceipt): void {
    const record = this.#records.get(executionId)
    if (record === undefined) throw new Error(`unknown execution ${executionId}`)
    const ts = new Date().toISOString()
    this.#append({ t: 'receipt', executionId, receipt, ts })
    record.receipt = receipt
    record.updatedAt = ts
  }

  /** Mark an unfinished execution UNKNOWN (crash recovery); never auto-retried. */
  markUnknown(executionId: string, reason: string): void {
    const record = this.#records.get(executionId)
    if (record === undefined || TERMINAL_STATES.includes(record.state)) return
    const ts = new Date().toISOString()
    this.#append({ t: 'unknown', executionId, reason, ts })
    record.state = 'UNKNOWN'
    record.reconciliation = { reason }
    record.updatedAt = ts
  }

  get(executionId: string): ExecutionRecord | undefined {
    return this.#records.get(executionId)
  }

  findIdempotent(callerId: string, idempotencyKey: string): ExecutionRecord | undefined {
    const id = this.#byIdempotency.get(idempotencySlot(callerId, idempotencyKey))
    return id === undefined ? undefined : this.#records.get(id)
  }

  /** All records still in a pre-terminal state (crash-recovery candidates). */
  unfinished(): ExecutionRecord[] {
    return [...this.#records.values()].filter((record) => !TERMINAL_STATES.includes(record.state))
  }

  /**
   * Crash recovery, run once at boot AFTER replay. Side-effect-free states get
   * an honest retryable failure; STARTED goes UNKNOWN (conservative — no
   * exactly-once claim about external side effects).
   */
  reconcile(onReconciled?: (record: ExecutionRecord) => void): void {
    for (const record of this.unfinished()) {
      if (SIDE_EFFECT_STATES.includes(record.state)) {
        this.markUnknown(record.executionId, RESTARTED_DURING_EXECUTION)
      } else {
        this.setState(record.executionId, 'FAILED')
        this.attachReceipt(record.executionId, syntheticReceipt(record, 'failed', {
          code: ABANDONED_BY_RESTART,
          retryable: true,
          message: 'server restarted before execution began; no side effects occurred; retry with a new idempotency key',
        }))
      }
      const final = this.get(record.executionId)
      if (final !== undefined) onReconciled?.(final)
    }
  }

  close(): void {
    if (this.#fd !== undefined) {
      closeSync(this.#fd)
      this.#fd = undefined
    }
  }
}
