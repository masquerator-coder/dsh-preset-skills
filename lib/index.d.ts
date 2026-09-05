/**
 * dsh-preset-skills — type declarations for the built bundle.
 *
 * These describe the runtime surface of the compiled `lib/index.js`. The full
 * source types live in `src/`. See `src/index.ts` and `src/parse.ts` for the
 * authoritative signatures.
 */
import type { Context } from '@deepseek-ai/cordis'

/** Config accepted by the binder. */
export interface Config {
  /** DSH_HOME override; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Marker log path override; defaults to `<DSH_HOME>/dsh-preset-skills.log`. */
  logFile?: string
  /** Append detailed diagnostics for every event to the marker log. */
  debug?: boolean
}

/** A fully-parsed, loadable skill. */
export interface ParsedSkill {
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  metadata?: Record<string, unknown>
  source: string
  provider: string
  resourceBase: string
  path: string
  content: string
}

/** A skill discovered in a directory (not yet loaded/parsed). */
export interface DiscoveredSkill {
  name: string
  path: string
  resourceBase: string
}

/** Framework-independent filesystem seam used by discovery. */
export interface FsSeam {
  readdir(path: string): Promise<string[]>
  readFile(path: string): Promise<string>
  exists(path: string): Promise<boolean>
}

/** Discover skills under a directory (name-validated, ordered). */
export function discoverSkills(dir: string, fs?: FsSeam): Promise<DiscoveredSkill[]>
/** Load + parse a discovered skill; resolves undefined if unreadable. */
export function loadSkill(skill: DiscoveredSkill, fs?: FsSeam): Promise<ParsedSkill | undefined>
/** Parse a raw skill file body into a ParsedSkill (throws on bad frontmatter). */
export function parseSkillSource(source: string, from: string): ParsedSkill
/** Whether a string is a valid skill name (kebab-case). */
export function isSkillName(name: string): boolean

/** Cordis plugin apply. */
export function apply(ctx: Context, config?: Config): void

export default apply
