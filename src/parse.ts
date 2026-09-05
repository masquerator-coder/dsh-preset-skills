/**
 * Framework-independent skill discovery and parsing for a preset's `skills/`
 * directory.
 *
 * This module has NO dsh/Cordis imports and NO runtime dependencies. The dsh
 * plugin (`src/index.ts`) feeds it a preset's `skills/` directory path (and the
 * dsh `yaml`-compatible frontmatter semantics); it returns normalized skill
 * summaries/definitions that can be handed to `ctx.skills.register(...)`.
 *
 * Discovery semantics mirror `@deepseek-ai/dsh-skill-filesystem`:
 *   - directory bundle:  `<root>/<name>/SKILL.md`,   resourceBase = `<root>/<name>`
 *   - flat skill:        `<root>/<name>.md`,         resourceBase = `<root>`
 *   - each file must open with `---` YAML frontmatter carrying at least
 *     `name` (kebab-case) and `description`.
 *
 * @module dsh-preset-skills/parse
 */

/** Valid kebab-case skill name, same grammar the dsh skill registry enforces. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

/** Invocation controls, matching `SkillInvocationPolicy`. */
export interface InvocationPolicy {
  modelInvocable: boolean
  userInvocable: boolean
}

/** Full parsed skill body plus its resource base. */
export interface ParsedSkill {
  name: string
  description: string
  whenToUse?: string
  invocation: InvocationPolicy
  metadata?: Record<string, unknown>
  content: string
  /** Directory against which the skill's relative resources resolve. */
  resourceBase: string
  /** Absolute path of the SKILL.md / .md source file. */
  path: string
}

/** A discovered candidate: name + description + locator, pre-load. */
export interface DiscoveredSkill {
  name: string
  description: string
  whenToUse?: string
  metadata?: Record<string, unknown>
  /** Absolute path of the skill file (SKILL.md or <name>.md). */
  path: string
  /** Absolute directory the skill's resources resolve against. */
  resourceBase: string
}

/** Minimal filesystem seam so callers can substitute their own reader. */
export interface FsSeam {
  /** List the immediate child names of a directory (throw on non-dir). */
  readdir(path: string): Promise<string[]>
  /** Read a file as utf8 text (throw on absence). */
  readFile(path: string): Promise<string>
  /** Whether a path exists on disk. */
  exists(path: string): Promise<boolean>
}

import { readdir, readFile, access } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** Default real-filesystem seam used by production and smoke tests. */
export const nodeFs: FsSeam = {
  async readdir(path) { return await readdir(path, { encoding: 'utf8' }) },
  async readFile(path) { return await readFile(path, { encoding: 'utf8' }) },
  async exists(path) {
    try { await access(path); return true } catch { return false }
  },
}

/**
 * Load the complete body of a discovered skill (reads its source file again).
 * @param skill - a discovered skill from {@link discoverSkills}.
 * @param fs - filesystem seam; defaults to {@link nodeFs}.
 * @returns the full parsed skill including `content`, or `undefined` when it
 *   became unreadable or no longer parses.
 */
export async function loadSkill(skill: DiscoveredSkill, fs: FsSeam = nodeFs): Promise<ParsedSkill | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(skill.path)
  } catch {
    return undefined
  }
  const parsed = parseSkillSource(raw, skill.path)
  return parsed
}

/**
 * Discover every skill in one `skills/` directory.
 * @param dir - absolute path of the preset `skills/` directory.
 * @param fs - filesystem seam; defaults to {@link nodeFs}.
 * @returns discovered skills whose files parse; unreadable/absent dir → [].
 */
export async function discoverSkills(dir: string, fs: FsSeam = nodeFs): Promise<DiscoveredSkill[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const found: DiscoveredSkill[] = []
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (entry === '.system' || entry.startsWith('.')) continue
    // Directory bundle: <name>/SKILL.md
    const bundleFile = join(dir, entry, 'SKILL.md')
    if (await fs.exists(bundleFile)) {
      const parsed = await parseFile(bundleFile, join(dir, entry), fs)
      if (parsed !== undefined) found.push(parsed)
      continue
    }
    // Flat skill: <name>.md  (must not contain a path separator)
    if (!entry.endsWith('.md') || entry.includes(sep)) continue
    const file = join(dir, entry)
    const parsed = await parseFile(file, dir, fs)
    if (parsed !== undefined) found.push(parsed)
  }
  return found
}

async function parseFile(path: string, resourceBase: string, fs: FsSeam): Promise<DiscoveredSkill | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(path)
  } catch {
    return undefined
  }
  const parsed = parseSkillSource(raw, path)
  if (parsed === undefined) return undefined
  const { content: _c, invocation: _i, ...summary } = parsed
  return { ...summary, resourceBase }
}

/**
 * Parse one skill's source text. Framework-independent.
 * @param source - full file text.
 * @param from - label for diagnostics / returned skill.
 * @returns the normalized skill, or undefined when the file is not a valid skill.
 */
export function parseSkillSource(
  source: string,
  from = '<skill>',
): ParsedSkill | undefined {
  const fm = parseFrontmatter(source)
  if (fm === undefined) return undefined
  const name = stringField(fm.data, 'name')
  const description = stringField(fm.data, 'description')
  if (name === undefined || description === undefined) return undefined
  if (!isSkillName(name)) return undefined
  let invocation: InvocationPolicy
  try {
    invocation = parseInvocation(fm.data)
  } catch {
    return undefined
  }
  return {
    name,
    description,
    ...optionalString(fm.data, 'whenToUse'),
    invocation,
    ...optionalMetadata(fm.data),
    content: fm.body.trim(),
    resourceBase: from.endsWith('SKILL.md') ? dirname(from) : dirname(from),
    path: from,
  }
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const nl = raw.indexOf('\n')
  if (nl < 0) return undefined
  const first = raw.slice(0, nl).replace(/\r$/, '')
  if (first !== '---') return undefined
  const start = nl + 1
  const closing = findClosing(raw, start)
  if (closing === undefined) return undefined
  const yaml = raw.slice(start, closing.start)
  let data: unknown
  try {
    data = parseYaml(yaml)
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  return { data: data as Record<string, unknown>, body: raw.slice(closing.bodyStart) }
}

function findClosing(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const next = raw.indexOf('\n', lineStart)
    const lineEnd = next < 0 ? raw.length : next
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return { start: lineStart, bodyStart: next < 0 ? raw.length : next + 1 }
    }
    if (next < 0) return undefined
    lineStart = next + 1
  }
  return undefined
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function optionalString(data: Record<string, unknown>, key: string): { whenToUse?: string } {
  const v = stringField(data, key)
  return v === undefined ? {} : { [key]: v }
}

function optionalMetadata(data: Record<string, unknown>): { metadata?: Record<string, unknown> } {
  const v = data.metadata
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    return { metadata: v as Record<string, unknown> }
  }
  return {}
}

function parseInvocation(data: Record<string, unknown>): InvocationPolicy {
  const model = data['disable-model-invocation']
  const user = data['user-invocable']
  return {
    modelInvocable: model !== true,
    userInvocable: user !== false,
  }
}
