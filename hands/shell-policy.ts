/**
 * ZhiYi Hands — shell executable resolution policy.
 *
 * P0 discovered that the Microsoft Store pwsh (an MSIX AppExecutionAlias
 * reparse point) lets grandchildren escape the Windows Job containment
 * (evidence/tree-kill-store-pwsh-escape.md). This module makes shell identity
 * an explicit, verified decision:
 *
 * - The executable is RESOLVED to a canonical absolute path and PINNED; PATH is
 *   never consulted (a poisoned PATH can never select the shell).
 * - MSIX execution aliases are rejected outright (path-segment check plus
 *   realpath check — an alias resolves back into the WindowsApps store tree).
 * - Only PowerShell-family executable names are accepted.
 * - The pinned file's sha256 and size are recorded so execution receipts can
 *   carry the actual executable identity.
 *
 * Fail-closed: any doubt throws; there is no "best effort" shell.
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Error codes for shell policy failures (receipt `error.code` vocabulary). */
export const SHELL_POLICY_ERROR_CODES = {
  MSIX_ALIAS_REJECTED: 'HANDS_SHELL_MSIX_ALIAS_REJECTED',
  NOT_FOUND: 'HANDS_SHELL_NOT_FOUND',
  NOT_POWERSHELL: 'HANDS_SHELL_NOT_POWERSHELL',
  UNREADABLE: 'HANDS_SHELL_UNREADABLE',
} as const

export class ShellPolicyError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ShellPolicyError'
    this.code = code
  }
}

/** The verified identity of the pinned shell executable. */
export interface ShellExecutableIdentity {
  /** Canonical absolute path (after realpath) of the executable actually spawned. */
  path: string
  /** sha256 of the executable file contents — recorded in execution receipts. */
  sha256: string
  sizeBytes: number
  /** How the path was chosen. */
  source: 'explicit' | 'native-windows-powershell' | 'installed-pwsh7'
}

const POWERSHELL_FAMILY = new Set(['powershell.exe', 'pwsh.exe'])

/**
 * Native candidate roots, in trust order. Deliberately NO PATH lookup and NO
 * Store alias probing (DSH's resolvePwshPath probes PATH and WindowsApps —
 * Hands inverts that policy after the P0 escape finding).
 */
export function nativeShellCandidates(systemRoot = process.env.SystemRoot ?? 'C:\\Windows', programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'): string[] {
  return [
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
  ]
}

/**
 * Whether a path refers to (or resolves into) the MSIX app-execution-alias
 * store tree. Aliases are reparse points whose realpath lands under a
 * `WindowsApps` directory, so both spellings are rejected.
 */
export function isMsixAlias(path: string): boolean {
  const normalized = path.replaceAll('/', '\\').toLowerCase()
  if (normalized.includes('\\windowsapps\\') || normalized.endsWith('\\windowsapps')) return true
  try {
    const resolved = realpathSync(path).replaceAll('/', '\\').toLowerCase()
    return resolved.includes('\\windowsapps\\')
  } catch {
    // Unresolvable paths fail later in verification; do not double-report.
    return false
  }
}

/**
 * Verify one candidate executable and return its pinned identity. Throws
 * ShellPolicyError (fail-closed) on any doubt.
 */
export function verifyShellExecutable(candidate: string, source: ShellExecutableIdentity['source']): ShellExecutableIdentity {
  if (isMsixAlias(candidate)) {
    throw new ShellPolicyError(
      SHELL_POLICY_ERROR_CODES.MSIX_ALIAS_REJECTED,
      `"${candidate}" is an MSIX app-execution alias; its processes escape Windows Job containment. Pin a native PowerShell executable instead.`,
    )
  }
  if (!existsSync(candidate)) {
    throw new ShellPolicyError(SHELL_POLICY_ERROR_CODES.NOT_FOUND, `shell executable not found: ${candidate}`)
  }
  const lstat = lstatSync(candidate)
  if (!lstat.isFile()) {
    throw new ShellPolicyError(SHELL_POLICY_ERROR_CODES.NOT_FOUND, `shell executable is not a regular file: ${candidate}`)
  }
  const name = basename(candidate).toLowerCase()
  if (!POWERSHELL_FAMILY.has(name)) {
    throw new ShellPolicyError(
      SHELL_POLICY_ERROR_CODES.NOT_POWERSHELL,
      `"${basename(candidate)}" is not a PowerShell-family executable (powershell.exe | pwsh.exe)`,
    )
  }
  const canonical = realpathSync(candidate)
  if (isMsixAlias(canonical)) {
    throw new ShellPolicyError(SHELL_POLICY_ERROR_CODES.MSIX_ALIAS_REJECTED, `"${candidate}" resolves to the MSIX store tree (${canonical})`)
  }
  const stat = statSync(canonical)
  const sha256 = createHash('sha256').update(readFileSync(canonical)).digest('hex')
  return { path: canonical, sha256, sizeBytes: stat.size, source }
}

/** Resolve the shell executable per Hands policy.
 * @param explicit - operator-pinned path; verified, never trusted blind.
 * @returns the pinned identity for the executor config and receipts.
 */
export function resolveShellExecutable(explicit?: string): ShellExecutableIdentity {
  if (explicit !== undefined && explicit !== '') {
    return verifyShellExecutable(explicit, 'explicit')
  }
  // Implicit: first existing native candidate wins; if NONE exists, fail with
  // the first candidate's path in the message (the native PS 5.1 location).
  const candidates = nativeShellCandidates()
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!
    if (existsSync(candidate)) {
      return verifyShellExecutable(candidate, i === 0 ? 'native-windows-powershell' : 'installed-pwsh7')
    }
  }
  throw new ShellPolicyError(
    SHELL_POLICY_ERROR_CODES.NOT_FOUND,
    `no native PowerShell executable found (tried: ${candidates.join('; ')}); PATH is deliberately not consulted`,
  )
}
