/**
 * Vitest-environment shim for `import.meta.resolve`.
 *
 * Vite's SSR transform replaces `import.meta` with a synthetic object that has
 * no `resolve`, which breaks the vendored DSH runner-launch probe under vitest
 * (native tsx/node runs are unaffected — P0 evidence). The vitest config
 * textually rewrites `import.meta.resolve(s)` to `handsResolveSpecifier(s)`;
 * this setup file installs that global with Node's own resolver rooted at the
 * project (workspace specifiers resolve through the tsconfig-alias layer only
 * under tsx; under vitest they resolve through the vite alias table instead,
 * and neither sandbox-local import.meta.resolve call site is on the Hands
 * execution path — Hands pins the ACL runner invocation itself).
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const projectRequire = createRequire(join(process.cwd(), 'package.json'))

;(globalThis as Record<string, unknown>).handsResolveSpecifier = (specifier: string): string => {
  try {
    // Native import.meta.resolve returns a file:// URL string; consumers pass it
    // to `node --import <url>`, which rejects bare Windows paths (protocol 'c:').
    return pathToFileURL(projectRequire.resolve(specifier)).href
  } catch {
    throw new Error(`Cannot find package '${specifier}' imported from the project root (vitest shim)`)
  }
}
