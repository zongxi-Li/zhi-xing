/**
 * ZhiYi Hands P0 — public API surface.
 *
 * `createStandaloneHands` is the one-call composition for embedding: DSH-backed
 * world + grant registry + engine, fully headless (no LLM, no planner, no
 * session). Swapping any provider means constructing a different `HandsWorld`
 * and passing it to `HandsEngine` directly.
 */

import { HandsEngine } from './engine.ts'
import { HandsGrantRegistry } from './grants.ts'
import { createDshWorld, type DshWorldOptions } from './world.ts'

export { HANDS_PROTOCOL_VERSION, HANDS_CAPABILITIES, validateExecutionRequest, canonicalChecksum, canonicalJson, HandsProtocolError, HANDS_ERROR_CODES } from './protocol.ts'
export type { HandsExecutionRequest, HandsExecutionReceipt, HandsCapabilityId, HandsIdentityRef, HandsLimits } from './protocol.ts'
export { HandsGrantRegistry, authorizeGrant, HandsAuthorizationError } from './grants.ts'
export type { HandsGrant } from './grants.ts'
export type {
  HandsWorld,
  HandsFilesystemProvider,
  HandsProcessProvider,
  HandsProcessSpec,
  HandsProcessResult,
  HandsProcessHandle,
  HandsResourceProvider,
  HandsSandboxMode,
  HandsSandboxFacts,
  HandsExecutionIdentity,
} from './providers.ts'
export { HandsEngine, receiptChecksum } from './engine.ts'
export { createDshWorld, JobGuardedSubprocessRuntime, type DshWorldOptions } from './world.ts'
export { NativeFallbackProcessProvider } from './native-fallback.ts'
export {
  resolveShellExecutable,
  verifyShellExecutable,
  isMsixAlias,
  nativeShellCandidates,
  ShellPolicyError,
  SHELL_POLICY_ERROR_CODES,
  type ShellExecutableIdentity,
} from './shell-policy.ts'

export interface StandaloneHands {
  engine: HandsEngine
  grants: HandsGrantRegistry
  world: Awaited<ReturnType<typeof createDshWorld>>
  dispose(): Promise<void>
}

/** Compose a standalone DSH-backed Hands instance. */
export async function createStandaloneHands(options: DshWorldOptions): Promise<StandaloneHands> {
  const world = await createDshWorld(options)
  const grants = new HandsGrantRegistry()
  const engine = new HandsEngine({ world, grants })
  return {
    engine,
    grants,
    world,
    dispose: () => world.dispose(),
  }
}
