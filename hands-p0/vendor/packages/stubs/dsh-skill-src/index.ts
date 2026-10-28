/** Minimal type stub: DSH `@deepseek-ai/dsh-skill` is imported by the vendored
 * sandbox-windows-acl only for `BUNDLED_SKILL_RANK` (a constant) and the type
 * shapes used by the optional diagnosis-skill registration, which Hands never
 * mounts (no `skills` service exists in a Hands composition). The type surface
 * mirrors what acl-skill.ts actually consumes. PROVENANCE: shapes from
 * deepseek-ai/deepseek-harness packages/skill/skill, MIT. */
export const BUNDLED_SKILL_RANK = 600

import type { Disposable } from '@deepseek-ai/cordis'

export type SkillSource = 'bundled' | (string & {})

export interface SkillResourceBase {
  kind: 'directory' | string
  path?: string
}

export interface SkillCandidate {
  name: string
  description: string
  source: SkillSource
  rank: number
  provider?: string
  invocation?: { modelInvocable?: boolean; userInvocable?: boolean }
  resourceBase?: SkillResourceBase
  locator?: string
  [extra: string]: unknown
}

export interface SkillProvider {
  name: string
  list(): Promise<SkillCandidate[]>
  get(entry: SkillCandidate, options: { signal?: AbortSignal } & Record<string, unknown>): Promise<unknown>
  dispose?(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    skills: { registerProvider(factory: () => SkillProvider): Disposable<unknown> }
  }
}
