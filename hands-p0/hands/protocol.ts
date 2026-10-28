/**
 * ZhiYi Hands P0 — versioned execution protocol contracts.
 *
 * Mirrors the ZhiYi kernel's `LocalRuntimeExecutionRequest` / `LocalRuntimeExecutionResult`
 * family (kinlin `apps/agentOS/src/contracts/local_runtime.py`) so a future Hands
 * process can sit behind the same envelope the Local Runtime already speaks, while
 * remaining an independent component with no knowledge of the WorkflowRuntime.
 *
 * Invariants inherited from the ZhiYi contract family:
 * - Authorization is carried as SYSTEM-ISSUED REFERENCES ({grantId, workspaceId}),
 *   never as caller-selected scope. Inline authority in `input` is rejected.
 * - Every envelope carries a literal protocol version.
 * - A receipt is complete on its own: status, timing, sanitized error, checksum.
 */

export const HANDS_PROTOCOL_VERSION = '1'

/** Closed capability vocabulary — extends the ZhiYi local-runtime capability set. */
export const HANDS_CAPABILITIES = ['fs.read', 'fs.list', 'fs.write', 'fs.patch', 'shell.exec'] as const
export type HandsCapabilityId = (typeof HANDS_CAPABILITIES)[number]

/** System-issued authorization reference. Opaque to the caller. */
export interface HandsAuthorizationRef {
  grantId: string
  workspaceId: string
}

/**
 * Correlation identity the caller (the ZhiYi kernel) stamps onto the request so a
 * receipt can never alias a different graph generation. All fields optional in P0
 * (Hands is callable headless) but echoed verbatim when present.
 */
export interface HandsIdentityRef {
  runId?: string
  stepId?: string
  attemptId?: string
  commitId?: string
}

export interface HandsLimits {
  timeoutSeconds?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
}

export interface HandsExecutionRequest {
  protocolVersion: string
  requestId: string
  invocationId: string
  capabilityId: HandsCapabilityId
  authorization: HandsAuthorizationRef
  input: Record<string, unknown>
  limits: HandsLimits
  idempotencyKey: string
  identity?: HandsIdentityRef
}

export type HandsReceiptStatus = 'completed' | 'failed' | 'cancelled'

export interface HandsErrorBody {
  code: string
  retryable: boolean
  message: string
}

export interface HandsExecutionReceipt {
  protocolVersion: string
  requestId: string
  invocationId: string
  capabilityId: HandsCapabilityId
  grantId: string
  status: HandsReceiptStatus
  startedAt: string
  completedAt: string
  durationMs: number
  output?: Record<string, unknown>
  error?: HandsErrorBody
  /** sha256 over the canonical JSON of the receipt's meaningful fields. */
  checksum: string
  identity?: HandsIdentityRef
  idempotencyKey: string
}

/** Error names used across the Hands surface (receipt error codes and thrown class). */
export const HANDS_ERROR_CODES = {
  PROTOCOL_UNSUPPORTED: 'HANDS_PROTOCOL_UNSUPPORTED',
  INVALID_REQUEST: 'HANDS_INVALID_REQUEST',
  INLINE_AUTHORITY: 'HANDS_INLINE_AUTHORITY',
  GRANT_NOT_FOUND: 'GRANT_NOT_FOUND',
  WORKSPACE_MISMATCH: 'WORKSPACE_MISMATCH',
  GRANT_ROOT_MISMATCH: 'GRANT_ROOT_MISMATCH',
  GRANT_REVOKED: 'GRANT_REVOKED',
  GRANT_EXPIRED: 'GRANT_EXPIRED',
  CAPABILITY_DENIED: 'CAPABILITY_DENIED',
  CANCELLED: 'HANDS_CANCELLED',
  EXECUTION_FAILED: 'HANDS_EXECUTION_FAILED',
} as const

/** Keys that must never appear inside `input`: scope is system-issued, not caller-declared. */
const INLINE_AUTHORITY_KEYS = new Set([
  'allowedroot',
  'allowedroots',
  'allowedpaths',
  'workspaceroot',
  'writableroots',
  'grantid',
  'sandboxpolicy',
  'sandbox',
])

export class HandsProtocolError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'HandsProtocolError'
    this.code = code
  }
}

/** Structural validation of a raw envelope into an {@link HandsExecutionRequest}. */
export function validateExecutionRequest(raw: unknown): HandsExecutionRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new HandsProtocolError(HANDS_ERROR_CODES.INVALID_REQUEST, 'request must be an object')
  }
  const r = raw as Record<string, unknown>
  if (r.protocolVersion !== HANDS_PROTOCOL_VERSION) {
    throw new HandsProtocolError(
      HANDS_ERROR_CODES.PROTOCOL_UNSUPPORTED,
      `protocolVersion ${JSON.stringify(r.protocolVersion)} unsupported; expected "${HANDS_PROTOCOL_VERSION}"`,
    )
  }
  for (const field of ['requestId', 'invocationId', 'idempotencyKey'] as const) {
    if (typeof r[field] !== 'string' || (r[field] as string).length === 0) {
      throw new HandsProtocolError(HANDS_ERROR_CODES.INVALID_REQUEST, `${field} must be a non-empty string`)
    }
  }
  if (typeof r.capabilityId !== 'string' || !(HANDS_CAPABILITIES as readonly string[]).includes(r.capabilityId)) {
    throw new HandsProtocolError(HANDS_ERROR_CODES.INVALID_REQUEST, `capabilityId must be one of ${HANDS_CAPABILITIES.join('|')}`)
  }
  const auth = r.authorization as Record<string, unknown> | undefined
  if (typeof auth !== 'object' || auth === null || typeof auth.grantId !== 'string' || typeof auth.workspaceId !== 'string') {
    throw new HandsProtocolError(HANDS_ERROR_CODES.INVALID_REQUEST, 'authorization must be {grantId, workspaceId}')
  }
  if (typeof r.input !== 'object' || r.input === null || Array.isArray(r.input)) {
    throw new HandsProtocolError(HANDS_ERROR_CODES.INVALID_REQUEST, 'input must be an object')
  }
  rejectInlineAuthority(r.input as Record<string, unknown>)
  const request: HandsExecutionRequest = {
    protocolVersion: HANDS_PROTOCOL_VERSION,
    requestId: r.requestId as string,
    invocationId: r.invocationId as string,
    capabilityId: r.capabilityId as HandsCapabilityId,
    authorization: { grantId: auth.grantId as string, workspaceId: auth.workspaceId as string },
    input: r.input as Record<string, unknown>,
    limits: sanitizeLimits(r.limits),
    idempotencyKey: r.idempotencyKey as string,
  }
  const identity = sanitizeIdentity(r.identity)
  if (identity !== undefined) request.identity = identity
  return request
}

function sanitizeLimits(raw: unknown): HandsLimits {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object') throw new HandsProtocolError(HANDS_ERROR_CODES.INVALID_REQUEST, 'limits must be an object')
  const l = raw as Record<string, unknown>
  const out: HandsLimits = {}
  for (const key of ['timeoutSeconds', 'maxStdoutBytes', 'maxStderrBytes'] as const) {
    const v = l[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new HandsProtocolError(HANDS_ERROR_CODES.INVALID_REQUEST, `limits.${key} must be a positive finite number`)
    }
    out[key] = v
  }
  return out
}

function sanitizeIdentity(raw: unknown): HandsIdentityRef | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') throw new HandsProtocolError(HANDS_ERROR_CODES.INVALID_REQUEST, 'identity must be an object')
  const i = raw as Record<string, unknown>
  const out: HandsIdentityRef = {}
  for (const key of ['runId', 'stepId', 'attemptId', 'commitId'] as const) {
    const v = i[key]
    if (v === undefined) continue
    if (typeof v !== 'string') throw new HandsProtocolError(HANDS_ERROR_CODES.INVALID_REQUEST, `identity.${key} must be a string`)
    out[key] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Build a request with optional fields omitted (exactOptionalPropertyTypes-safe). */
export function buildExecutionRequest(parts: Omit<HandsExecutionRequest, 'identity'> & { identity?: HandsIdentityRef }): HandsExecutionRequest {
  const request: HandsExecutionRequest = { ...parts }
  delete (request as { identity?: HandsIdentityRef }).identity
  if (parts.identity !== undefined) request.identity = parts.identity
  return request
}

/** Recursively reject caller-declared scope, mirroring ZhiYi `reject_inline_authority`. */
export function rejectInlineAuthority(input: Record<string, unknown>, path = 'input'): void {
  for (const [key, value] of Object.entries(input)) {
    if (INLINE_AUTHORITY_KEYS.has(key.toLowerCase())) {
      throw new HandsProtocolError(
        HANDS_ERROR_CODES.INLINE_AUTHORITY,
        `${path}.${key}: execution scope is system-issued via authorization references, never declared by the caller`,
      )
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      rejectInlineAuthority(value as Record<string, unknown>, `${path}.${key}`)
    }
  }
}

/** Deterministic JSON: sorted object keys, stable for checksumming. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** sha256 checksum over canonical JSON — the ZhiYi provenance checksum discipline. */
export function canonicalChecksum(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

import { createHash } from 'node:crypto'
