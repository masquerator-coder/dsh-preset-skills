/**
 * Preset-skill registration core: framework-independent, fully seam-injected.
 *
 * Given a preset id, resolve its `skills/` directory, discover the skills it
 * holds, parse each body, and push every valid one into a caller-provided
 * skills sink (the dsh `SkillRegistry.register` surface, mocked in smoke).
 *
 * This module has NO dsh/Cordis imports: the plugin (`src/index.ts`) adapts
 * the live dsh context into these seams, and tests exercise the exact same
 * discovery→parse→register pipeline against real preset directories with a
 * mock sink.
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
  /** Register one definition; must throw when the sink rejects it. */
  register(registration: SkillRegistration): void
  /** Append one diagnostic line (marker log). */
  log(line: string): void
}

export type RegisterState =
  | 'ok'
  | 'no-preset'
  | 'resolve-failed'
  | 'discover-failed'

export interface PresetRegisterResult {
  readonly presetId: string | undefined
  readonly skillsDir: string | undefined
  readonly state: RegisterState
  readonly found: number
  readonly registered: number
  readonly skipped: string[]
}

/**
 * Register every skill of one preset directory through the seam sink.
 * Never throws: every failure is folded into the returned result and logged.
 */
export async function registerPresetSkills(
  presetId: string | undefined,
  seam: RegisterSeam,
): Promise<PresetRegisterResult> {
  if (presetId === undefined || presetId.length === 0) {
    return { presetId: undefined, skillsDir: undefined, state: 'no-preset', found: 0, registered: 0, skipped: [] }
  }
  let dir: string | undefined
  try {
    dir = await seam.resolveSkillsDir(presetId)
  } catch (error) {
    seam.log(`resolve failed preset=${presetId}: ${describe(error)}`)
    return { presetId, skillsDir: undefined, state: 'resolve-failed', found: 0, registered: 0, skipped: [] }
  }
  if (dir === undefined) {
    seam.log(`preset not resolvable preset=${presetId}`)
    return { presetId, skillsDir: undefined, state: 'resolve-failed', found: 0, registered: 0, skipped: [] }
  }
  let discovered: DiscoveredSkill[]
  try {
    discovered = await seam.discover(dir)
  } catch (error) {
    seam.log(`discover failed dir=${dir}: ${describe(error)}`)
    return { presetId, skillsDir: dir, state: 'discover-failed', found: 0, registered: 0, skipped: [] }
  }
  const skipped: string[] = []
  let registered = 0
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
    try {
      seam.register(toRegistration(parsed))
      registered += 1
    } catch (error) {
      skipped.push(`${skill.name}:${describe(error)}`)
    }
  }
  return { presetId, skillsDir: dir, state: 'ok', found: discovered.length, registered, skipped }
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
