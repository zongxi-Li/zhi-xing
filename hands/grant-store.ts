/**
 * ZhiYi Hands — trusted grant store (HANDS-02A admission authority).
 *
 * A Hands service NEVER trusts a grantId (or any identity field) submitted by
 * a client: requests carry only REFERENCES, and admission resolves them against
 * this operator-provisioned store — a JSON file on the server
 * ({grants:[{grantId, workspaceId, canonicalRoot, capabilities,
 * allowedCallers, expiresAt?, revoked?}]}) reloaded on every admission when
 * the file mtime changes (revocation/expiry take effect immediately at the
 * NEXT request; running executions keep their admission-time authorization —
 * documented semantics, mirroring a capability token).
 *
 * The caller binding (allowedCallers ↔ authenticated credentialId) is what
 * makes "client-asserted identity" impossible: only the credential that
 * signed the request can be the caller, and the grant must name it.
 *
 * Tests use the local issuer helper below (a test issuer, never a client).
 */

import { statSync, readFileSync } from 'node:fs'

export const ADMISSION_ERROR_CODES = {
  GRANT_NOT_FOUND: 'GRANT_NOT_FOUND',
  WORKSPACE_MISMATCH: 'WORKSPACE_MISMATCH',
  GRANT_ROOT_MISMATCH: 'GRANT_ROOT_MISMATCH',
  GRANT_REVOKED: 'GRANT_REVOKED',
  GRANT_EXPIRED: 'GRANT_EXPIRED',
  CAPABILITY_DENIED: 'CAPABILITY_DENIED',
  CALLER_NOT_AUTHORIZED: 'CALLER_NOT_AUTHORIZED',
} as const

export class HandsAdmissionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 403) {
    super(message)
    this.name = 'HandsAdmissionError'
  }
}

export interface TrustedGrantRecord {
  grantId: string
  workspaceId: string
  /** Must equal the service's workspace root. */
  canonicalRoot: string
  capabilities: readonly string[]
  /** Credential ids allowed to use this grant; the authenticated signer must be among them. */
  allowedCallers: readonly string[]
  /** ISO timestamp; absent = no expiry. */
  expiresAt?: string
  revoked?: boolean
}

export class TrustedGrantStore {
  #grants = new Map<string, TrustedGrantRecord>()
  #loadedFrom: string | undefined
  #loadedMtimeMs: number | undefined

  constructor(grants: readonly TrustedGrantRecord[] = []) {
    this.#ingest(grants)
  }

  #ingest(grants: readonly TrustedGrantRecord[]): void {
    const next = new Map<string, TrustedGrantRecord>()
    for (const grant of grants) {
      if (typeof grant.grantId !== 'string' || grant.grantId === '') throw new Error('grant records need a grantId')
      if (grant.capabilities.length === 0) throw new Error(`grant ${grant.grantId} carries no capabilities`)
      if (grant.allowedCallers.length === 0) throw new Error(`grant ${grant.grantId} names no allowed callers`)
      next.set(grant.grantId, { ...grant, capabilities: [...grant.capabilities], allowedCallers: [...grant.allowedCallers] })
    }
    this.#grants = next
  }

  /** Load (and hot-reload on mtime change) from a grants JSON file. */
  static fromFile(path: string): TrustedGrantStore {
    const store = new TrustedGrantStore()
    store.#loadedFrom = path
    store.#reloadIfChanged(true)
    return store
  }

  #reloadIfChanged(force = false): void {
    if (this.#loadedFrom === undefined) return
    const mtimeMs = statSync(this.#loadedFrom).mtimeMs
    if (!force && mtimeMs === this.#loadedMtimeMs) return
    const parsed: unknown = JSON.parse(readFileSync(this.#loadedFrom, 'utf8'))
    const grants = (parsed as { grants?: unknown }).grants
    if (!Array.isArray(grants)) throw new Error('grants file must carry a grants array')
    this.#ingest(grants as TrustedGrantRecord[])
    this.#loadedMtimeMs = mtimeMs
  }

  /** Resolve a grant reference against the CURRENT trusted set (hot-reloaded). */
  get(grantId: string): TrustedGrantRecord | undefined {
    this.#reloadIfChanged()
    return this.#grants.get(grantId)
  }

  /**
   * Full admission check: existence, caller binding, workspace binding, root
   * binding, revocation, expiry, capability. Throws HandsAdmissionError with
   * the ZhiYi grant error vocabulary (plus CALLER_NOT_AUTHORIZED).
   */
  authorize(input: {
    grantId: string
    workspaceId: string
    capabilityId: string
    callerId: string
    serviceWorkspaceRoot: string
    now?: Date
  }): TrustedGrantRecord {
    const grant = this.get(input.grantId)
    if (!grant) throw new HandsAdmissionError(ADMISSION_ERROR_CODES.GRANT_NOT_FOUND, 'grant not found')
    if (!grant.allowedCallers.includes(input.callerId)) {
      throw new HandsAdmissionError(ADMISSION_ERROR_CODES.CALLER_NOT_AUTHORIZED, `grant ${input.grantId} does not name caller ${input.callerId}`)
    }
    if (grant.workspaceId !== input.workspaceId) {
      throw new HandsAdmissionError(ADMISSION_ERROR_CODES.WORKSPACE_MISMATCH, `grant is bound to workspace ${grant.workspaceId}, not ${input.workspaceId}`)
    }
    if (grant.revoked === true) {
      throw new HandsAdmissionError(ADMISSION_ERROR_CODES.GRANT_REVOKED, `grant ${input.grantId} is revoked`)
    }
    const now = input.now ?? new Date()
    if (grant.expiresAt !== undefined && now.getTime() > Date.parse(grant.expiresAt)) {
      throw new HandsAdmissionError(ADMISSION_ERROR_CODES.GRANT_EXPIRED, `grant ${input.grantId} expired at ${grant.expiresAt}`)
    }
    if (normalizeRoot(grant.canonicalRoot) !== normalizeRoot(input.serviceWorkspaceRoot)) {
      throw new HandsAdmissionError(ADMISSION_ERROR_CODES.GRANT_ROOT_MISMATCH, `grant root does not match this service workspace`)
    }
    if (!grant.capabilities.includes(input.capabilityId)) {
      throw new HandsAdmissionError(ADMISSION_ERROR_CODES.CAPABILITY_DENIED, `grant ${input.grantId} does not authorize capability ${input.capabilityId}`)
    }
    return grant
  }
}

function normalizeRoot(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** Serialize the trusted set back to the grants-file shape (operator tooling / tests). */
export function writeGrantsFileShape(grants: readonly TrustedGrantRecord[]): { grants: TrustedGrantRecord[] } {
  return { grants: grants.map((grant) => ({ ...grant, capabilities: [...grant.capabilities], allowedCallers: [...grant.allowedCallers] })) }
}

/** TEST issuer (also the shape example for operator provisioning). */
export function issueTestGrant(input: {
  grantId: string
  workspaceId: string
  canonicalRoot: string
  capabilities: readonly string[]
  allowedCallers: readonly string[]
  ttlMs?: number
  revoked?: boolean
}): TrustedGrantRecord {
  const grant: TrustedGrantRecord = {
    grantId: input.grantId,
    workspaceId: input.workspaceId,
    canonicalRoot: input.canonicalRoot,
    capabilities: [...input.capabilities],
    allowedCallers: [...input.allowedCallers],
  }
  if (input.ttlMs !== undefined) grant.expiresAt = new Date(Date.now() + input.ttlMs).toISOString()
  if (input.revoked === true) grant.revoked = true
  return grant
}
