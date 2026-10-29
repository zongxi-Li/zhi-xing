/**
 * Signed-request test client for the Hands service (HANDS-02 test suites).
 *
 * Mirrors ZhiYi's verified signer (resource_signing.py + http_server.py): the
 * exact same canonical string, headers, and Idempotency-Key binding a real
 * ZhiYi caller would send. In-process tests drive `service.handle()` directly;
 * out-of-process tests go through `httpFetch`.
 */

import { buildResourceSignature, IDEMPOTENCY_KEY_HEADER, RESOURCE_CREDENTIAL_HEADER, RESOURCE_NONCE_HEADER, RESOURCE_SIGNATURE_HEADER, RESOURCE_TIMESTAMP_HEADER } from '../hands/auth.ts'

export interface SignedRequestInit {
  credentialId: string
  secret: string
  method: string
  path: string
  /** Raw request body (sign over exactly these bytes). */
  body: string | Buffer
  idempotencyKey: string
  /** Override the timestamp (expired/future window tests). */
  timestamp?: number
  /** Force a different nonce without re-signing correctly (replay tests use the same helper twice). */
  nonce?: string
  /** Tamper hook: mutate headers AFTER signing (wrong-signature tests). */
  tamper?: (headers: Record<string, string>) => void
}

export interface SignedRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: Buffer
}

let nonceCounter = 0

export function signRequest(init: SignedRequestInit): SignedRequest {
  const body = typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : init.body
  const timestamp = init.timestamp ?? Date.now()
  const nonce = init.nonce ?? `test-nonce-${Date.now()}-${nonceCounter++}`
  const signature = buildResourceSignature(init.secret, {
    method: init.method,
    path: init.path,
    timestamp,
    nonce,
    body,
  })
  const headers: Record<string, string> = {
    [RESOURCE_CREDENTIAL_HEADER]: init.credentialId,
    [RESOURCE_TIMESTAMP_HEADER]: String(timestamp),
    [RESOURCE_NONCE_HEADER]: nonce,
    [RESOURCE_SIGNATURE_HEADER]: signature,
    [IDEMPOTENCY_KEY_HEADER]: init.idempotencyKey,
    'content-type': 'application/json',
  }
  init.tamper?.(headers)
  return { method: init.method, path: init.path, headers, body }
}

/** Minimal execution envelope builder (valid against validateExecutionRequest). */
export function executionEnvelope(input: {
  capabilityId?: string
  command?: string
  grantId: string
  workspaceId: string
  idempotencyKey: string
  requestId?: string
  invocationId?: string
}): string {
  const requestId = input.requestId ?? `req-${input.idempotencyKey}`
  const invocationId = input.invocationId ?? `inv-${input.idempotencyKey}`
  const capabilityId = input.capabilityId ?? 'shell.exec'
  const inputBlock =
    capabilityId === 'shell.exec'
      ? { command: input.command ?? 'Write-Output hello-hands' }
      : capabilityId === 'fs.write'
        ? { path: 'out.txt', content: 'written-by-test' }
        : { path: 'out.txt' }
  return JSON.stringify({
    protocolVersion: '1',
    requestId,
    invocationId,
    idempotencyKey: input.idempotencyKey,
    capabilityId,
    authorization: { grantId: input.grantId, workspaceId: input.workspaceId },
    input: inputBlock,
    limits: { timeoutSeconds: 20 },
  })
}

export interface ServiceResponse {
  status: number
  body: any
}

export const TERMINAL_STATES = ['COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN'] as const

/** Poll GET /v1/executions/{id} (fresh nonce each time) until a terminal state. */
export async function pollTerminal(
  service: { handle(request: { method: string; path: string; headers: Record<string, string | undefined>; body: Buffer }): { status: number; body: unknown } },
  executionId: string,
  opts: { credentialId: string; secret: string; timeoutMs?: number },
): Promise<ServiceResponse> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000)
  let last: ServiceResponse | undefined
  while (Date.now() < deadline) {
    last = callHandle(service, signRequest({ credentialId: opts.credentialId, secret: opts.secret, method: 'GET', path: `/v1/executions/${executionId}`, body: '', idempotencyKey: `poll-${executionId}` }))
    if ((TERMINAL_STATES as readonly string[]).includes((last.body as { state?: string })?.state ?? '')) return last
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error(`execution ${executionId} never reached a terminal state: ${JSON.stringify(last?.body)}`)
}

/** Call the in-process handler. */
export function callHandle(service: { handle(request: { method: string; path: string; headers: Record<string, string | undefined>; body: Buffer }): { status: number; body: unknown } }, signed: SignedRequest): ServiceResponse {
  const response = service.handle({ method: signed.method, path: signed.path, headers: signed.headers, body: signed.body })
  return { status: response.status, body: response.body as any }
}

/** Call the live HTTP service (out-of-process suites). */
export async function httpFetch(baseUrl: string, signed: SignedRequest): Promise<ServiceResponse> {
  const response = await fetch(`${baseUrl}${signed.path}`, {
    method: signed.method,
    headers: signed.headers,
    body: signed.method === 'GET' ? undefined : new Uint8Array(signed.body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}
