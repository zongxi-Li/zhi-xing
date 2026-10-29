/**
 * ZhiYi Hands P0 — grant registry and authorization.
 *
 * Semantics mirror the ZhiYi host-side grant model (kinlin `apps/local-runtime/grants`:
 * `GrantRecord` fields and the `GrantAuthorizationService` error family) so Hands can be
 * authorized by the same kind of grant the Local Runtime consumes. Hands issues grants
 * itself in P0 (it is a standalone component); in integration the kernel issues them and
 * Hands only verifies.
 */

import { HANDS_ERROR_CODES } from './protocol.ts'

export interface HandsGrant {
  grantId: string
  workspaceId: string
  /** Absolute canonical workspace root this grant is bound to. */
  canonicalRoot: string
  allowedCapabilities: ReadonlySet<string>
  createdAt: string
  expiresAt?: string
  revoked: boolean
}

export class HandsAuthorizationError extends Error {
  readonly code: string
  readonly retryable: boolean
  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'HandsAuthorizationError'
    this.code = code
    this.retryable = retryable
  }
}

export class HandsGrantRegistry {
  readonly #grants = new Map<string, HandsGrant>()
  #counter = 0

  issue(input: {
    workspaceId: string
    canonicalRoot: string
    allowedCapabilities: readonly string[]
    ttlMs?: number
    now?: () => Date
  }): HandsGrant {
    const now = (input.now ?? (() => new Date()))()
    const grant: HandsGrant = {
      grantId: `hgrant_${(++this.#counter).toString(16).padStart(4, '0')}_${randomId()}`,
      workspaceId: input.workspaceId,
      canonicalRoot: input.canonicalRoot,
      allowedCapabilities: new Set(input.allowedCapabilities),
      createdAt: now.toISOString(),
      revoked: false,
    }
    if (input.ttlMs !== undefined) grant.expiresAt = new Date(now.getTime() + input.ttlMs).toISOString()
    this.#grants.set(grant.grantId, grant)
    return grant
  }

  revoke(grantId: string): boolean {
    const grant = this.#grants.get(grantId)
    if (!grant) return false
    grant.revoked = true
    return true
  }

  /**
   * Install a trusted record verbatim under its existing id. Used by the
   * service layer to mirror a server-side admission into the engine's
   * defense-in-depth check; the id always originates from the trusted store,
   * never from client input. Re-installing overwrites (admission-time refresh).
   */
  install(grant: HandsGrant): void {
    this.#grants.set(grant.grantId, { ...grant, allowedCapabilities: new Set(grant.allowedCapabilities) })
  }

  get(grantId: string): HandsGrant | undefined {
    return this.#grants.get(grantId)
  }
}

export interface AuthorizationInput {
  workspaceId: string
  capabilityId: string
  /** Canonical workspace root the World is operating on, for root binding. */
  worldRoot: string
  now?: Date
}

/**
 * Verify a grant against the requested capability. Error codes mirror the ZhiYi
 * grant service (`GRANT_NOT_FOUND`, `WORKSPACE_MISMATCH`, `GRANT_ROOT_MISMATCH`,
 * `GRANT_REVOKED`, `GRANT_EXPIRED`, `CAPABILITY_DENIED`). Root comparison is
 * case-insensitive lexical on win32, drive-letter normalized; P0 does not realpath
 * the world root (the fs layer canonicalizes on every mutation anyway).
 */
export function authorizeGrant(grant: HandsGrant | undefined, input: AuthorizationInput): void {
  if (!grant) {
    throw new HandsAuthorizationError(HANDS_ERROR_CODES.GRANT_NOT_FOUND, `grant not found`)
  }
  if (grant.workspaceId !== input.workspaceId) {
    throw new HandsAuthorizationError(HANDS_ERROR_CODES.WORKSPACE_MISMATCH, `grant is bound to workspace ${grant.workspaceId}, not ${input.workspaceId}`)
  }
  if (grant.revoked) {
    throw new HandsAuthorizationError(HANDS_ERROR_CODES.GRANT_REVOKED, `grant ${grant.grantId} is revoked`)
  }
  const now = input.now ?? new Date()
  if (grant.expiresAt !== undefined && now.getTime() > Date.parse(grant.expiresAt)) {
    throw new HandsAuthorizationError(HANDS_ERROR_CODES.GRANT_EXPIRED, `grant ${grant.grantId} expired at ${grant.expiresAt}`)
  }
  if (normalizeRoot(grant.canonicalRoot) !== normalizeRoot(input.worldRoot)) {
    throw new HandsAuthorizationError(
      HANDS_ERROR_CODES.GRANT_ROOT_MISMATCH,
      `grant root ${grant.canonicalRoot} does not match the execution world root ${input.worldRoot}`,
    )
  }
  if (!grant.allowedCapabilities.has(input.capabilityId)) {
    throw new HandsAuthorizationError(
      HANDS_ERROR_CODES.CAPABILITY_DENIED,
      `grant ${grant.grantId} does not authorize capability ${input.capabilityId}`,
    )
  }
}

function normalizeRoot(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

function randomId(): string {
  return Math.random().toString(16).slice(2, 10)
}
