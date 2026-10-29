/**
 * ZhiYi Hands — standalone execution service (HANDS-02A/02B).
 *
 * A loopback-only HTTP service that exposes the Hands engine behind the ZhiYi
 * resource-HMAC protocol. Transport-agnostic core (handle()) mirrors ZhiYi's
 * LocalRuntimeHttpApplication shape so tests can drive it in-process; the
 * node:http wrapper binds 127.0.0.1 by default and refuses wider binds unless
 * explicitly overridden.
 *
 * Pipeline per POST /v1/executions:
 *   HMAC auth (raw body digest, fixed-time compare, ±skew window, nonce
 *   anti-replay) → protocol validation (version, closed capability set,
 *   inline-authority rejection) → Idempotency-Key header binding → trusted
 *   grant admission (server-side store, caller binding, root binding,
 *   revocation/expiry) → durable ledger claim → dispatch (async) with
 *   event-stream hooks → durable terminal receipt.
 *
 * Client disconnects never change execution outcomes. Fail-closed everywhere;
 * no automatic security-tier downgrade on failure.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { HandsAuthError, ResourceAuthenticator } from './auth.ts'
import { createStandaloneHands, type StandaloneHands } from './index.ts'
import { ExecutionEventBus, type ExecutionEvent } from './events.ts'
import { ExecutionLedger, type ExecutionRecord } from './ledger.ts'
import { HandsAdmissionError, TrustedGrantStore } from './grant-store.ts'
import { HandsCredentialStore } from './keys.ts'
import { HANDS_ERROR_CODES, HandsProtocolError, canonicalChecksum, validateExecutionRequest, HANDS_PROTOCOL_VERSION, type HandsExecutionReceipt, type HandsExecutionRequest } from './protocol.ts'

export const SERVICE_PROTOCOL_VERSION = '1'
const EXECUTION_PATH = '/v1/executions'
const HEALTH_PATH = '/v1/health'
const MAX_BODY_BYTES = 8 * 1024 * 1024

export interface HandsServiceOptions {
  workspaceRoot: string
  /** Trusted grants: a live store (tests) or a grants JSON file path. */
  grants: TrustedGrantStore | { file: string }
  /** Credentials: a live store (tests) or a keys JSON file path. */
  credentials: HandsCredentialStore | { file: string }
  /** Ledger data directory (created if absent; ledger.jsonl inside). */
  dataDir: string
  /** Loopback bind host (default 127.0.0.1). */
  host?: string
  /** Bind port (0 = ephemeral). */
  port?: number
  confinement?: 'none' | 'acl'
  clockSkewMs?: number
  now?: () => number
  /**
   * TEST-ONLY crash injection: named points where the process exits(1).
   * Deterministic fault cut-ins for out-of-process crash suites.
   */
  faults?: { afterClaim?: boolean; afterStarted?: boolean }
}

interface JsonResponse {
  status: number
  body: unknown
}

export class HandsService {
  readonly #grants: TrustedGrantStore
  readonly #authenticator: ResourceAuthenticator
  readonly #ledger: ExecutionLedger
  readonly #events = new ExecutionEventBus()
  readonly #controllers = new Map<string, AbortController>()
  readonly #startedAt = Date.now()
  readonly #faults: HandsServiceOptions['faults']
  readonly #workspaceRoot: string
  #server: Server | undefined
  #logBuffer: string[] = []

  constructor(readonly options: HandsServiceOptions) {
    this.#faults = options.faults
    this.#workspaceRoot = options.workspaceRoot
    this.#grants = options.grants instanceof TrustedGrantStore ? options.grants : TrustedGrantStore.fromFile(options.grants.file)
    const credentials = options.credentials instanceof HandsCredentialStore ? options.credentials : loadCredentialFile(options.credentials.file)
    this.#authenticator = new ResourceAuthenticator({
      resolveSecret: (id) => credentials.secretFor(id),
      ...(options.clockSkewMs === undefined ? {} : { clockSkewMs: options.clockSkewMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    this.#ledger = new ExecutionLedger(options.dataDir)
    // The engine world builds asynchronously; reconcile happens in start(),
    // before any traffic is accepted.
    this.#pendingHands = createStandaloneHands({
      workspaceRoot: options.workspaceRoot,
      ...(options.confinement === undefined ? {} : { confinement: options.confinement }),
    })
  }

  readonly #pendingHands: Promise<StandaloneHands>

  /** Internal log capture (asserted by leak tests; never carries secrets). */
  get recentLogLines(): readonly string[] {
    return this.#logBuffer
  }

  #log(line: string): void {
    this.#logBuffer.push(line)
    if (this.#logBuffer.length > 500) this.#logBuffer.shift()
  }

  async start(): Promise<{ host: string; port: number }> {
    // Refuse unsafe binds BEFORE doing any work (fail fast on operator error).
    const host = this.options.host ?? '127.0.0.1'
    if (!isLoopback(host)) {
      throw new Error(`refusing to bind non-loopback host "${host}" without explicit operator action (service.exec host check)`)
    }
    // Surface world-creation failures here, before binding.
    await this.#pendingHands
    // Reconcile unfinished executions BEFORE accepting traffic.
    this.#ledger.reconcile((record) => {
      this.#log(`reconciled ${record.executionId} -> ${record.state}`)
    })
    const server = createServer((req, res) => {
      void this.#serve(req, res)
    })
    this.#server = server
    await new Promise<void>((resolveListen) => {
      server.listen(this.options.port ?? 0, host, resolveListen)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('unexpected listen address')
    return { host: address.address, port: address.port }
  }

  async stop(): Promise<void> {
    // Abort everything still running — the service is going away.
    for (const controller of this.#controllers.values()) controller.abort()
    if (this.#server !== undefined) {
      await new Promise<void>((resolveClose) => this.#server!.close(() => resolveClose()))
      this.#server = undefined
    }
    this.#ledger.close()
    await (await this.#pendingHands).dispose()
  }

  async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0)
      const response = this.handle({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: flattenHeaders(req),
        body,
      })
      // NOTE: a client disconnect after this point cannot change the outcome —
      // executions run detached from the response lifecycle.
      const payload = Buffer.from(JSON.stringify(response.body), 'utf8')
      res.statusCode = response.status
      res.setHeader('content-type', 'application/json')
      res.setHeader('content-length', String(payload.length))
      res.end(payload)
    } catch (error) {
      this.#log(`request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(errorBody('HANDS_INTERNAL_ERROR', 'internal error', true)))
      } else {
        res.end()
      }
    }
  }

  /** Transport-agnostic request handler (in-process tests drive this directly). */
  handle(request: { method: string; path: string; headers: Record<string, string | undefined>; body: Buffer }): JsonResponse {
    const { method, path, headers, body } = request
    const url = new URL(path, 'http://hands.local')
    const pathname = url.pathname

    if (method === 'GET' && pathname === HEALTH_PATH) {
      return json(200, {
        ok: true,
        protocolVersion: SERVICE_PROTOCOL_VERSION,
        service: 'zhiyi-hands',
        uptimeMs: Date.now() - this.#startedAt,
        workspaceRoot: this.#workspaceRoot,
      })
    }

    // ---- authenticated surface -------------------------------------------------
    const execMatch = matchExecutionPath(pathname)
    try {
      if (method === 'POST' && pathname === EXECUTION_PATH) {
        if (body.length > MAX_BODY_BYTES) return error(413, 'REQUEST_TOO_LARGE', 'request body is too large')
        const caller = this.#authenticate(method, path, headers, body)
        return this.#postExecution(caller.credentialId, body, headers)
      }
      if (method === 'GET' && execMatch?.endpoint === 'events') {
        this.#authenticate(method, path, headers, body)
        return this.#getEvents(execMatch.executionId, url.searchParams)
      }
      if (method === 'GET' && execMatch !== undefined) {
        this.#authenticate(method, path, headers, body)
        return this.#getExecution(execMatch.executionId)
      }
      if (method === 'POST' && execMatch?.endpoint === 'cancel') {
        if (body.length > MAX_BODY_BYTES) return error(413, 'REQUEST_TOO_LARGE', 'request body is too large')
        this.#authenticate(method, path, headers, body)
        return this.#postCancel(execMatch.executionId, body)
      }
      return error(404, 'NOT_FOUND', 'hands endpoint not found')
    } catch (authOrAdmission) {
      if (authOrAdmission instanceof HandsAuthError) {
        return error(authOrAdmission.status, authOrAdmission.code, authOrAdmission.message)
      }
      if (authOrAdmission instanceof HandsAdmissionError) {
        return error(authOrAdmission.status, authOrAdmission.code, authOrAdmission.message)
      }
      throw authOrAdmission
    }
  }

  #authenticate(method: string, path: string, headers: Record<string, string | undefined>, body: Buffer): { credentialId: string } {
    return this.#authenticator.authenticate({ method, path, headers, body })
  }

  #postExecution(callerId: string, body: Buffer, headers: Record<string, string | undefined>): JsonResponse {
    let request: HandsExecutionRequest
    try {
      request = validateExecutionRequest(JSON.parse(body.toString('utf8')))
    } catch (parseError) {
      if (parseError instanceof HandsProtocolError) {
        return error(400, parseError.code, parseError.message)
      }
      return error(400, HANDS_ERROR_CODES.INVALID_REQUEST, 'request envelope is invalid')
    }
    const headerIdempotency = headerValue(headers, 'idempotency-key')
    if (headerIdempotency !== request.idempotencyKey) {
      return error(400, 'PROTOCOL_MISMATCH', 'idempotency key does not match request envelope')
    }
    // Trusted admission — never client-asserted.
    const admitted = this.#grants.authorize({
      grantId: request.authorization.grantId,
      workspaceId: request.authorization.workspaceId,
      capabilityId: request.capabilityId,
      callerId,
      serviceWorkspaceRoot: this.#workspaceRoot,
      now: new Date(),
    })
    const requestDigest = createHash('sha256').update(body).digest('hex')
    const claim = this.#ledger.claim({
      callerId,
      idempotencyKey: request.idempotencyKey,
      requestDigest,
      summary: {
        capabilityId: request.capabilityId,
        requestId: request.requestId,
        invocationId: request.invocationId,
        workspaceId: request.authorization.workspaceId,
        callerId,
      },
    })
    if (!claim.claimed) {
      if (claim.conflict) {
        return error(409, 'IDEMPOTENCY_KEY_CONFLICT', 'idempotency key was used with a different request digest')
      }
      return json(200, executionPayload(claim.existing!))
    }
    const record = claim.record
    if (this.#faults?.afterClaim === true) {
      this.#ledger.close()
      process.exit(1)
    }
    this.#events.emit(record.executionId, 'execution.accepted', { requestId: request.requestId, capabilityId: request.capabilityId })
    // Dispatch detached from the response lifecycle.
    void this.#dispatch(record, request, admitted)
    return json(202, executionPayload(this.#ledger.get(record.executionId)!))
  }

  async #dispatch(record: ExecutionRecord, request: HandsExecutionRequest, admitted: import('./grant-store.ts').TrustedGrantRecord): Promise<void> {
    const hands = await this.#pendingHands
    // Mirror the admission-time grant into the engine's in-process registry
    // (defense-in-depth re-check inside execute()). The id comes from the
    // trusted server-side store; a revocation DURING execution does not
    // retro-invalidate a running execution (capability-token semantics).
    hands.grants.install({
      grantId: admitted.grantId,
      workspaceId: admitted.workspaceId,
      canonicalRoot: admitted.canonicalRoot,
      allowedCapabilities: new Set(admitted.capabilities),
      createdAt: new Date().toISOString(),
      revoked: false,
      ...(admitted.expiresAt !== undefined ? { expiresAt: admitted.expiresAt } : {}),
    })
    try {
      this.#ledger.setState(record.executionId, 'AUTHORIZED')
      // A cancel that raced dispatch creation (before the controller existed)
      // is honored HERE: no side effects have happened yet.
      if (this.#ledger.get(record.executionId)?.cancelRequested === true) {
        const receipt: HandsExecutionReceipt = {
          protocolVersion: HANDS_PROTOCOL_VERSION,
          requestId: request.requestId,
          invocationId: request.invocationId,
          capabilityId: request.capabilityId,
          grantId: request.authorization.grantId,
          status: 'cancelled',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
          error: { code: HANDS_ERROR_CODES.CANCELLED, retryable: true, message: 'execution cancelled before it began' },
          checksum: '',
          idempotencyKey: request.idempotencyKey,
        }
        receipt.checksum = canonicalChecksum(receipt)
        this.#ledger.attachReceipt(record.executionId, receipt)
        this.#ledger.setState(record.executionId, 'CANCELLED')
        this.#events.emit(record.executionId, 'execution.cancelled', {})
        return
      }
      this.#ledger.setState(record.executionId, 'STARTED')
      this.#events.emit(record.executionId, 'execution.started', {})
      if (this.#faults?.afterStarted === true) {
        this.#ledger.close()
        process.exit(1)
      }
      const controller = new AbortController()
      this.#controllers.set(record.executionId, controller)
      const receipt = await hands.engine.execute(request, controller.signal, {
        onOutput: (channel, text) => this.#events.emitDelta(record.executionId, channel, text),
      })
      this.#controllers.delete(record.executionId)
      // Persist terminal BEFORE the client can observe it.
      this.#ledger.attachReceipt(record.executionId, receipt)
      this.#ledger.setState(record.executionId, receipt.status === 'completed' ? 'COMPLETED' : receipt.status === 'cancelled' ? 'CANCELLED' : 'FAILED')
      const terminalType = receipt.status === 'completed' ? 'execution.completed' : receipt.status === 'cancelled' ? 'execution.cancelled' : 'execution.failed'
      this.#events.emit(record.executionId, terminalType, { checksum: receipt.checksum })
      this.#log(`execution ${record.executionId} ${receipt.status}`)
    } catch (error) {
      this.#controllers.delete(record.executionId)
      this.#log(`dispatch failed for ${record.executionId}: ${error instanceof Error ? error.message : String(error)}`)
      // Infrastructure failure after STARTED: side effects unknown → UNKNOWN.
      // Best-effort: if the service is shutting down (ledger already closed),
      // the next boot's reconcile classifies this record from the last
      // persisted state — exactly the crash-recovery path.
      try {
        this.#ledger.markUnknown(record.executionId, `HANDS_DISPATCH_ERROR:${error instanceof Error ? error.message : String(error)}`)
        this.#events.emit(record.executionId, 'execution.unknown', {})
      } catch (ledgerError) {
        this.#log(`could not persist UNKNOWN for ${record.executionId} (ledger closed?): ${ledgerError instanceof Error ? ledgerError.message : String(ledgerError)}`)
      }
    }
  }

  #getExecution(executionId: string): JsonResponse {
    const record = this.#ledger.get(executionId)
    if (record === undefined) return error(404, 'EXECUTION_NOT_FOUND', 'execution was not found')
    return json(200, executionPayload(record))
  }

  #getEvents(executionId: string, query: URLSearchParams): JsonResponse {
    const record = this.#ledger.get(executionId)
    if (record === undefined) return error(404, 'EXECUTION_NOT_FOUND', 'execution was not found')
    const afterRaw = query.get('afterSequence')
    const after = afterRaw === null ? -1 : Number(afterRaw)
    if (!Number.isInteger(after) || after < -1) {
      return error(400, 'PROTOCOL_MISMATCH', 'event cursor is invalid')
    }
    const stream = this.#events.query(executionId, after)
    if (stream === undefined) {
      return json(200, { executionId, events: [], nextSeq: 0, truncated: false, state: record.state, terminal: isTerminal(record) })
    }
    return json(200, {
      executionId,
      events: stream.events.map(serializeEvent),
      nextSeq: stream.nextSeq,
      truncated: stream.truncated,
      state: record.state,
      terminal: isTerminal(record),
    })
  }

  #postCancel(executionId: string, body: Buffer): JsonResponse {
    let parsed: { executionId?: unknown }
    try {
      parsed = JSON.parse(body.toString('utf8')) as { executionId?: unknown }
    } catch {
      return error(400, 'PROTOCOL_MISMATCH', 'cancel envelope is invalid')
    }
    if (parsed.executionId !== executionId) {
      return error(400, 'PROTOCOL_MISMATCH', 'execution id does not match path')
    }
    const record = this.#ledger.get(executionId)
    if (record === undefined) return error(404, 'EXECUTION_NOT_FOUND', 'execution was not found')
    if (isTerminal(record)) {
      return error(409, 'EXECUTION_ALREADY_SETTLED', `execution already settled as ${record.state}`)
    }
    // Cancel REQUEST (distinct state marker) then real termination via the engine.
    this.#ledger.markCancelRequested(executionId)
    const controller = this.#controllers.get(executionId)
    controller?.abort()
    return json(200, { executionId, cancelRequested: true, state: this.#ledger.get(executionId)!.state })
  }
}

function isTerminal(record: ExecutionRecord): boolean {
  return record.state === 'COMPLETED' || record.state === 'FAILED' || record.state === 'CANCELLED' || record.state === 'UNKNOWN'
}

function executionPayload(record: ExecutionRecord): Record<string, unknown> {
  return {
    executionId: record.executionId,
    state: record.state,
    cancelRequested: record.cancelRequested,
    callerId: record.callerId,
    idempotencyKey: record.idempotencyKey,
    requestDigest: record.requestDigest,
    summary: record.summary,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.receipt === undefined ? {} : { receipt: record.receipt }),
    ...(record.reconciliation === undefined ? {} : { reconciliation: record.reconciliation }),
  }
}

function serializeEvent(event: ExecutionEvent): Record<string, unknown> {
  return { executionId: event.executionId, seq: event.seq, type: event.type, timestamp: event.timestamp, ...(event.payload === undefined ? {} : { payload: event.payload }) }
}

function matchExecutionPath(pathname: string): { executionId: string; endpoint?: 'events' | 'cancel' } | undefined {
  const prefix = `${EXECUTION_PATH}/`
  if (!pathname.startsWith(prefix)) return undefined
  const remainder = pathname.slice(prefix.length)
  const parts = remainder.split('/')
  if (parts.length === 1 && parts[0] !== '') return { executionId: parts[0]! }
  if (parts.length === 2 && (parts[1] === 'events' || parts[1] === 'cancel')) {
    return { executionId: parts[0]!, endpoint: parts[1] }
  }
  return undefined
}

function flattenHeaders(message: IncomingMessage): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(message.headers)) {
    flat[key] = Array.isArray(value) ? value.join(',') : value
  }
  return flat
}

function headerValue(headers: Record<string, string | undefined>, name: string): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return (value ?? '').trim()
  }
  return ''
}

async function readBody(message: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of message) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function loadCredentialFile(path: string): HandsCredentialStore {
  return HandsCredentialStore.fromParsedFile(JSON.parse(readFileSync(path, 'utf8')))
}

function json(status: number, body: unknown): JsonResponse {
  return { status, body }
}

function error(status: number, code: string, message: string): JsonResponse {
  return json(status, { error: errorBody(code, message, status >= 500) })
}

function errorBody(code: string, message: string, retryable: boolean): unknown {
  return { code, retryable, message }
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}
