import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * Explicit alias table built from tsconfig.json paths. Deterministic for the
 * vendored @deepseek-ai/* sources (vite-tsconfig-paths would not apply aliases
 * to vendor files outside the tsconfig include list).
 */
const tsconfig = JSON.parse(readFileSync(new URL('./tsconfig.json', import.meta.url), 'utf8')) as {
  compilerOptions: { paths: Record<string, string[]> }
}
const alias: Record<string, string> = {}
for (const [specifier, targets] of Object.entries(tsconfig.compilerOptions.paths)) {
  // Path keys here have no '*' patterns (exact entries only), so one alias each.
  alias[specifier] = resolve(import.meta.dirname, targets[0]!)
}
// Rollup alias matches by prefix (key + '/'), so longer keys must win first —
// '@deepseek-ai/dsh-subprocess/control' must be tested before '@deepseek-ai/dsh-subprocess'.
const orderedAlias = Object.fromEntries(
  Object.entries(alias).sort(([a], [b]) => b.length - a.length),
)

/**
 * Scoped shim for `import.meta.resolve` under vitest: Vite's SSR transform
 * omits it, but the vendored DSH sources call it (runner-launch probe, sandbox
 * runner resolution). Restrict the rewrite to project sources (a global vite
 * `define` would also hit vite's own @vite/env module and crash the runner).
 * The global itself is installed by tests/setup-resolve-shim.ts before any
 * test module loads. Under plain tsx/node the native resolve is untouched.
 */
function importMetaResolveShim(): Plugin {
  const projectRoot = import.meta.dirname.replaceAll('\\', '/')
  return {
    name: 'hands-import-meta-resolve-shim',
    transform(code, id) {
      const normalized = id.replaceAll('\\', '/')
      if (!normalized.startsWith(projectRoot) || normalized.includes('node_modules')) return null
      if (!code.includes('import.meta.resolve')) return null
      return { code: code.replaceAll('import.meta.resolve(', 'handsResolveSpecifier('), map: null }
    },
  }
}

export default defineConfig({
  plugins: [importMetaResolveShim()],
  resolve: { alias: orderedAlias },
  test: {
    include: ['tests/**/*.spec.ts'],
    // Real process trees + koffi FFI: forked processes, no worker threads.
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ['tests/setup-resolve-shim.ts'],
  },
})
