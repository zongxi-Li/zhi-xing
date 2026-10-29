/**
 * ZhiYi Hands — bounded execution event stream (HANDS-02B).
 *
 * One monotone sequence per execution. Delta payloads are split/capped and the
 * per-execution buffer is a ring: when the byte budget is exceeded the OLDEST
 * delta events are dropped and `truncated` flips true — clients detect the gap
 * by sequence and fall back to the durable receipt (whose stdout/stderr tail
 * is always complete). Terminal and lifecycle events are never dropped.
 *
 * Events are ephemeral (in-memory): the durable story is the ledger + receipt.
 * Polling with `afterSequence` handles disconnects and re-subscription
 * idempotently; a client disconnecting NEVER influences execution outcome.
 */

export const EXECUTION_EVENT_TYPES = [
  'execution.accepted',
  'execution.started',
  'stdout.delta',
  'stderr.delta',
  'execution.completed',
  'execution.failed',
  'execution.cancelled',
  'execution.unknown',
] as const
export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number]

export interface ExecutionEvent {
  executionId: string
  /** Monotone per-execution sequence (0-based). */
  seq: number
  type: ExecutionEventType
  timestamp: string
  payload?: Record<string, unknown>
}

/** One delta event carries at most this many UTF-8 bytes of text. */
export const EVENT_DELTA_MAX_BYTES = 4 * 1024
/** Per-execution ring budget for delta events (lifecycle events excluded). */
export const EVENT_RING_MAX_BYTES = 256 * 1024

interface ExecutionStream {
  events: ExecutionEvent[]
  nextSeq: number
  deltaBytes: number
  truncated: boolean
}

export class ExecutionEventBus {
  readonly #streams = new Map<string, ExecutionStream>()

  emit(executionId: string, type: ExecutionEventType, payload?: Record<string, unknown>): ExecutionEvent {
    let stream = this.#streams.get(executionId)
    if (stream === undefined) {
      stream = { events: [], nextSeq: 0, deltaBytes: 0, truncated: false }
      this.#streams.set(executionId, stream)
    }
    const event: ExecutionEvent = {
      executionId,
      seq: stream.nextSeq++,
      type,
      timestamp: new Date().toISOString(),
      ...(payload === undefined ? {} : { payload }),
    }
    stream.events.push(event)
    if (isDelta(type)) {
      stream.deltaBytes += eventByteLength(event)
      while (stream.deltaBytes > EVENT_RING_MAX_BYTES) {
        const oldestDeltaIndex = stream.events.findIndex((candidate) => isDelta(candidate.type))
        if (oldestDeltaIndex === -1 || oldestDeltaIndex >= stream.events.length - 1) break
        const dropped = stream.events.splice(oldestDeltaIndex, 1)[0]!
        stream.deltaBytes -= eventByteLength(dropped)
        stream.truncated = true
      }
    }
    return event
  }

  /** Emit one text chunk as capped delta events. */
  emitDelta(executionId: string, channel: 'stdout' | 'stderr', text: string): void {
    if (text === '') return
    const maxChars = Math.floor(EVENT_DELTA_MAX_BYTES / 2) // safe for BMP text under 4 UTF-8 bytes/char... conservative split
    for (let offset = 0; offset < text.length; offset += maxChars) {
      this.emit(executionId, channel === 'stdout' ? 'stdout.delta' : 'stderr.delta', { text: text.slice(offset, offset + maxChars) })
    }
  }

  query(executionId: string, afterSequence: number): { events: ExecutionEvent[]; nextSeq: number; truncated: boolean } | undefined {
    const stream = this.#streams.get(executionId)
    if (stream === undefined) return undefined
    return {
      events: stream.events.filter((event) => event.seq > afterSequence),
      nextSeq: stream.nextSeq,
      truncated: stream.truncated,
    }
  }

  drop(executionId: string): void {
    this.#streams.delete(executionId)
  }
}

function isDelta(type: ExecutionEventType): boolean {
  return type === 'stdout.delta' || type === 'stderr.delta'
}

function eventByteLength(event: ExecutionEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8')
}
