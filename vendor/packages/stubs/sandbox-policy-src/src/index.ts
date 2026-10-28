/** Minimal type stub: DSH `@deepseek-ai/dsh-sandbox-policy` is referenced by the
 * vendored extraction subset only as `import type {}` module augmentation
 * (fs/fs-sandbox/src/index.ts:36) and a `SandboxPolicyService` type shape.
 * Hands-P0 provides its own policy service (hands/world.ts). PROVENANCE: type
 * names from deepseek-ai/deepseek-harness sandbox/sandbox-policy, MIT. */
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'

export interface SandboxExecutionRequest {
  mode?: SandboxMode
  session?: { id: string; header: { cwd: string } }
}

export interface SandboxPolicyService {
  defaultMode: SandboxMode
  resolve(request?: SandboxExecutionRequest): SandboxExecutionPolicy
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }
}
