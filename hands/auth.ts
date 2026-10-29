/**
 * ZhiYi Hands — resource HMAC authentication (HANDS-02A).
 *
 * EXACT mirror of the ZhiYi resource-signing protocol (kinlin
 * apps/agentOS/src/contracts/resource_signing.py + apps/local-runtime/runtime/http_server.py
 * RuntimeRequestAuthenticator), so a Hands service accepts the same signing
 * discipline the kernel already uses for the Local Runtime:
 *
 *   key       = sha256(secret)
 *   signed    = HMAC-SHA256(key, "METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX")
 *   headers   = X-Resource-Credential / X-Resource-Timestamp (unix) /
 *               X-Resource-Nonce / X-Resource-Signature (hex)
 *   window    = ±300s (default); nonce expires at signed-at + window
 *   replay    = 409 REPLAY_REJECTED
 *
 * Signature comparison is fixed-time (timingSafeEqual). Secrets are never
 * part of any error, log line, or receipt.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const RESOURCE_CREDENTIAL_HEADER = 'x-resource-credential'
export const RESOURCE_TIMESTAMP_HEADER = 'x-resource-timestamp'
export const RESOURCE_NONCE_HEADER = 'x-resource-nonce'
export const RESOURCE_SIGNATURE_HEADER = 'x-resource-signature'
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'

export class HandsAuthError extends Error {
  constructor(
    readonly code: 'AUTHENTICATION_FAILED' | 'REPLAY_REJECTED',
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'HandsAuthError'
  }
}

/** Canonical signed string — byte-for-byte the ZhiYi construction. */
export function canonicalResourceRequest(parts: { method: string; path: string; timestamp: number; nonce: string; body: Buffer }): Buffer {
  const bodyDigest = createHash('sha256').update(parts.body).digest('hex')
  return Buffer.from([parts.method.toUpperCase(), parts.path, String(parts.timestamp), parts.nonce, bodyDigest].join('\n'), 'utf8')
}

/** Build the expected signature for a secret — mirror of build_resource_signature. */
export function buildResourceSignature(secret: string, parts: { method: string; path: string; timestamp: number; nonce: string; body: Buffer }): string {
  const key = createHash('sha256').update(secret, 'utf8').digest()
  return createHmac('sha256', key).update(canonicalResourceRequest(parts)).digest('hex')
}

export interface AuthenticatedCaller {
  credentialId: string
}

export interface AuthenticatorOptions {
  /** Allowed clock skew in milliseconds, both directions (ZhiYi: 300_000). */
  clockSkewMs?: number
  now?: () => number
  /** Resolves the secret for a credential id; undefined = unknown credential. */
  resolveSecret: (credentialId: string) => string | undefined
  /** Nonce bookkeeping seam (tests / future persistent nonce store). */
  nonces?: NonceStore
}

/** Nonce seen-set with expiry-purge, mirroring the ZhiYi in-memory dict. */
export class NonceStore {
  readonly #seen = new Map<string, number>()

  /** @returns false when the nonce was already seen (replay). */
  claim(nonce: string, expiresAtMs: number, nowMs: number): boolean {
    this.purge(nowMs)
    if (this.#seen.has(nonce)) return false
    this.#seen.set(nonce, expiresAtMs)
    return true
  }

  purge(nowMs: number): void {
    for (const [nonce, expiresAt] of this.#seen) {
      if (expiresAt <= nowMs) this.#seen.delete(nonce)
    }
  }

  get size(): number {
    return this.#seen.size
  }
}

export class ResourceAuthenticator {
  readonly #resolveSecret: (credentialId: string) => string | undefined
  readonly #clockSkewMs: number
  readonly #now: () => number
  readonly #nonces: NonceStore

  constructor(options: AuthenticatorOptions) {
    this.#resolveSecret = options.resolveSecret
    this.#clockSkewMs = options.clockSkewMs ?? 300_000
    this.#now = options.now ?? Date.now
    this.#nonces = options.nonces ?? new NonceStore()
    if (this.#clockSkewMs <= 0) throw new Error('clockSkewMs must be positive')
  }

  /**
   * Authenticate one request. Throws HandsAuthError on any failure; returns the
   * authenticated caller identity on success. `body` is the RAW request body.
   */
  authenticate(parts: { method: string; path: string; headers: Record<string, string | undefined>, body: Buffer }): AuthenticatedCaller {
    const header = (name: string): string => {
      for (const [key, value] of Object.entries(parts.headers)) {
        if (key.toLowerCase() === name) return (value ?? '').trim()
      }
      return ''
    }
    const credentialId = header(RESOURCE_CREDENTIAL_HEADER)
    const timestampText = header(RESOURCE_TIMESTAMP_HEADER)
    const nonce = header(RESOURCE_NONCE_HEADER)
    const signature = header(RESOURCE_SIGNATURE_HEADER)
    if (credentialId === '' || timestampText === '' || nonce === '' || signature === '') {
      throw new HandsAuthError('AUTHENTICATION_FAILED', 'resource authentication failed', 401)
    }
    const timestamp = Number(timestampText)
    if (!Number.isInteger(timestamp) || !Number.isSafeInteger(timestamp)) {
      throw new HandsAuthError('AUTHENTICATION_FAILED', 'resource authentication failed', 401)
    }
    const now = this.#now()
    if (Math.abs(now - timestamp) > this.#clockSkewMs) {
      throw new HandsAuthError('AUTHENTICATION_FAILED', 'resource authentication failed', 401)
    }
    const secret = this.#resolveSecret(credentialId)
    if (secret === undefined) {
      throw new HandsAuthError('AUTHENTICATION_FAILED', 'resource authentication failed', 401)
    }
    const expected = buildResourceSignature(secret, { method: parts.method, path: parts.path, timestamp, nonce, body: parts.body })
    // Fixed-time comparison over equal-length hex digests.
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(signature, 'utf8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new HandsAuthError('AUTHENTICATION_FAILED', 'resource authentication failed', 401)
    }
    const expiresAt = timestamp + this.#clockSkewMs
    if (!this.#nonces.claim(nonce, expiresAt, now)) {
      throw new HandsAuthError('REPLAY_REJECTED', 'resource request replay rejected', 409)
    }
    return { credentialId }
  }
}
