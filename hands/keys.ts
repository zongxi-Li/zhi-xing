/**
 * ZhiYi Hands — credential store (HANDS-02A).
 *
 * Secrets come from the operator (keys file / direct injection in tests) —
 * NEVER from a request, and they never appear in logs, errors, or receipts
 * (the service screens every outgoing payload; tests assert it).
 *
 * Rotation strategy: the store accepts multiple credentials simultaneously;
 * swapping the file content (or calling rotate) atomically replaces the set,
 * so a new credential can start signing before the old one is dropped.
 */

export interface HandsCredential {
  credentialId: string
  secret: string
}

export class HandsCredentialStore {
  #secrets = new Map<string, string>()

  constructor(credentials: readonly HandsCredential[] = []) {
    for (const { credentialId, secret } of credentials) this.#set(credentialId, secret)
  }

  #set(credentialId: string, secret: string): void {
    const id = credentialId.trim()
    const material = secret.trim()
    if (id === '' || material === '') throw new Error('credential id and secret must be non-empty')
    this.#secrets.set(id, material)
  }

  /** Load/replace the whole credential set from a parsed keys file. */
  static fromParsedFile(parsed: unknown): HandsCredentialStore {
    const credentials = parseCredentialsFile(parsed)
    const store = new HandsCredentialStore()
    for (const { credentialId, secret } of credentials) store.#set(credentialId, secret)
    return store
  }

  secretFor(credentialId: string): string | undefined {
    return this.#secrets.get(credentialId)
  }

  get credentialIds(): readonly string[] {
    return [...this.#secrets.keys()]
  }

  /** Atomic rotation: replaces the active set in one call. */
  rotate(credentials: readonly HandsCredential[]): void {
    const next = new HandsCredentialStore()
    for (const { credentialId, secret } of credentials) next.#set(credentialId, secret)
    this.#secrets = next.#secrets
  }
}

/** Accepted keys-file shape: {credentials:[{credentialId,secret}]} (no other keys). */
export function parseCredentialsFile(parsed: unknown): HandsCredential[] {
  if (typeof parsed !== 'object' || parsed === null) throw new Error('keys file must be an object')
  const credentials = (parsed as { credentials?: unknown }).credentials
  if (!Array.isArray(credentials)) throw new Error('keys file must carry a credentials array')
  const out: HandsCredential[] = []
  for (const entry of credentials) {
    if (typeof entry !== 'object' || entry === null) throw new Error('credentials entries must be objects')
    const credentialId = (entry as { credentialId?: unknown }).credentialId
    const secret = (entry as { secret?: unknown }).secret
    if (typeof credentialId !== 'string' || typeof secret !== 'string') {
      throw new Error('credentials entries need string credentialId and secret')
    }
    out.push({ credentialId, secret })
  }
  if (out.length === 0) throw new Error('keys file carries no credentials')
  return out
}
