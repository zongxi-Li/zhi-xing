/** Hands-P0 trimmed vendor of `@deepseek-ai/dsh-llm`. The extraction subset
 * (fs/fs, sandbox/sandbox, shell/*) imports ONLY `HarnessError`. This stub
 * re-exports the VERBATIM error.ts from DSH (deepseek-ai/deepseek-harness @
 * 22ddee3792402c3e70ec5f86a63c3e3e895a2f60, MIT) without the rest of the LLM
 * vocabulary package (zod/typert/crypto closure), which Hands does not need. */
export { HarnessError } from './error.ts'
