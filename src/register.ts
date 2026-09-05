/**
 * Preset-skill registration core: framework-independent, fully seam-injected.
 *
 * Two phases keep switching safe:
 *
 *  1. `preparePresetSkills` — READ-ONLY. Resolve the preset's `skills/`
 *     directory, discover the skills it holds, parse each body into a
 *     `SkillRegistration`. Nothing is mutated, so a failed prepare leaves the
 *     agent's current registrations untouched (v2 preset-switch can dispose
 *     the old set only after the new set is ready).
 *  2. `applyPresetDefinitions` — MUTATING. Push each definition through the
 *     seam `register` sink and collect the returned disposers, so the caller
 *     can later unregister exactly this set (v2 switch) or rely on the agent
 *     scope teardown (v1 single-shot).
 *
 * This module has NO dsh/Cordis imports: the plugin (`src/index.ts`) adapts
 * the live dsh context into these seams, and tests exercise the exact same
 * prepare→apply pipeline against real preset directories with a mock sink.
 *
 * @module dsh-preset-skills/register
 */

import type { DiscoveredSkill, ParsedSkill } from './parse.ts'

/** One runtime skill definition handed to `ctx.skills.register(...)`. */
export interface SkillRegistration {
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  metadata?: Record<string, unknown>
  /** Registry bucket label; must be a legal `SkillSource`. */
  source: 'runtime'
  /** Provider label shown by the catalog; distinguishes this mechanism. */
  provider: string
  /** Directory the skill's relative resources resolve against. */
  resourceBase: { kind: 'directory'; path: string }
  /** Markdown instruction body. */
  content: string
  /** Absolute path of the skill source file. */
  path: string
}

/** Every external effect the registration pipeline needs. */
export interface RegisterSeam {
  /**
   * Resolve one preset id to the absolute path of its `skills/` directory.
   * Return `undefined` (or reject) when the roster cannot resolve the id.
   */
  resolveSkillsDir(presetId: string): Promise<string | undefined>
  /** List the skills in a directory (parse failures are skipped upstream). */
  discover(dir: string): Promise<DiscoveredSkill[]>
  /** Load + parse one discovered skill body; `undefined` when unreadable. */
  load(skill: DiscoveredSkill): Promise<ParsedSkill | undefined>
  /**
   * Register one definition and return its disposer (or undefined). Must
   * throw when the sink rejects the definition.
   */
  register(registration: SkillRegistration): (() => void) | undefined
  /** Append one diagnostic line (marker log). */
  log(line: string): void
}

export type PrepareState =
  | 'ok'
  | 'no-preset'
  | 'resolve-failed'
  | 'discover-failed'

/** One preset fully read and parsed, ready to apply. */
export interface PreparedPreset {
  readonly presetId: string | undefined
  readonly skillsDir: string | undefined
  readonly state: PrepareState
  readonly found: number
  readonly skipped: string[]
  /** Valid definitions to register; empty unless `state === 'ok'`. */
  readonly definitions: readonly SkillRegistration[]
}

/** Result of pushing one prepared set through the sink. */
export interface ApplyResult {
  readonly registered: number
  readonly skipped: string[]
  /** Disposers of every accepted registration, in order. */
  readonly disposers: readonly (() => void)[]
}

/**
 * Phase 1 — read-only. Resolve the preset directory and parse every skill in
 * it into a ready-to-register definition. Never mutates anything and never
 * throws: each failure mode is folded into the returned result and logged.
 */
export async function preparePresetSkills(
  presetId: string | undefined,
  seam: RegisterSeam,
): Promise<PreparedPreset> {
  if (presetId === undefined || presetId.length === 0) {
    return { presetId: undefined, skillsDir: undefined, state: 'no-preset', found: 0, skipped: [], definitions: [] }
  }
  let dir: string | undefined
  try {
    dir = await seam.resolveSkillsDir(presetId)
  } catch (error) {
    seam.log(`resolve failed preset=${presetId}: ${describe(error)}`)
    return { presetId, skillsDir: undefined, state: 'resolve-failed', found: 0, skipped: [], definitions: [] }
  }
  if (dir === undefined) {
    seam.log(`preset not resolvable preset=${presetId}`)
    return { presetId, skillsDir: undefined, state: 'resolve-failed', found: 0, skipped: [], definitions: [] }
  }
  let discovered: DiscoveredSkill[]
  try {
    discovered = await seam.discover(dir)
  } catch (error) {
    seam.log(`discover failed dir=${dir}: ${describe(error)}`)
    return { presetId, skillsDir: dir, state: 'discover-failed', found: 0, skipped: [], definitions: [] }
  }
  const skipped: string[] = []
  const definitions: SkillRegistration[] = []
  for (const skill of discovered) {
    let parsed: ParsedSkill | undefined
    try {
      parsed = await seam.load(skill)
    } catch {
      parsed = undefined
    }
    if (parsed === undefined) {
      skipped.push(`${skill.name}:unreadable`)
      continue
    }
    definitions.push(toRegistration(parsed))
  }
  return { presetId, skillsDir: dir, state: 'ok', found: discovered.length, skipped, definitions }
}

/**
 * Phase 2 — mutate. Push a prepared set through the seam sink and keep the
 * disposers so the caller can unregister exactly this set later. Individual
 * definition failures are collected, never thrown.
 */
export async function applyPresetDefinitions(
  prepared: PreparedPreset,
  register: (registration: SkillRegistration) => (() => void) | undefined,
): Promise<ApplyResult> {
  const skipped: string[] = []
  const disposers: (() => void)[] = []
  let registered = 0
  for (const definition of prepared.definitions) {
    try {
      const disposer = register(definition)
      if (disposer !== undefined) disposers.push(disposer)
      registered += 1
    } catch (error) {
      skipped.push(`${definition.name}:${describe(error)}`)
    }
  }
  return { registered, skipped, disposers }
}

/** Map a fully parsed skill to the runtime registration shape. */
export function toRegistration(skill: ParsedSkill): SkillRegistration {
  return {
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
    invocation: {
      modelInvocable: skill.invocation.modelInvocable,
      userInvocable: skill.invocation.userInvocable,
    },
    ...skill.metadata !== undefined ? { metadata: skill.metadata } : {},
    source: 'runtime',
    provider: 'dsh-preset-skills',
    resourceBase: { kind: 'directory', path: skill.resourceBase },
    content: skill.content,
    path: skill.path,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
