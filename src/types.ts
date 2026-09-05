/**
 * Structural (type-only) contracts for the small dsh service surface this
 * plugin consumes. Kept local so the bundled output needs no runtime
 * `@deepseek-ai/*` resolution beyond what the loader injects.
 *
 * @module dsh-preset-skills/types
 */

import type { Context } from '@deepseek-ai/cordis'

/** A live dsh Agent with its scoped context. */
export interface AgentLike {
  readonly id: string
  readonly ctx: Context
}

/** The agent-presets service surface we read. */
export interface AgentPresetsLike {
  /** The preset id the given agent's scope is parented to, or undefined. */
  composedPreset(agentCtx: Context): string | undefined
  /** Resolve a preset id to its roster record (path = agent.cordis.yml). */
  resolve(id: string): Promise<{ id: string; path?: string } | undefined>
  /** The preset's own instance of a service (e.g. `skills`), if published. */
  serviceFor<K extends string>(agent: { ctx: Context }, name: K): unknown
}

/** The skills service surface we register against. */
export interface SkillsLike {
  register(skill: unknown): unknown
}
