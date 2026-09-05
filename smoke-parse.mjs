/**
 * smoke-parse — validate parse.ts discovery against the REAL preset skills dirs.
 * Reads each preset's skills/ dir through the bundle's parse helpers and prints
 * the discovered names. No dsh runtime needed.
 */
import { discoverSkills, parseSkillSource, isSkillName } from './lib/index.js'
import { existsSync } from 'node:fs'

const PRESETS = ['research', 'teacher', 'developer']
const ROOT = process.env.DSH_HOME || 'C:/Users/fuqia/.dsh'

let failures = 0
for (const preset of PRESETS) {
  const dir = `${ROOT}/.agent-presets/${preset}/skills`
  let skills
  try {
    skills = await discoverSkills(dir)
  } catch (error) {
    console.log(`[${preset}] ERROR ${error}`)
    failures++
    continue
  }
  const names = skills.map((s) => s.name)
  const bad = skills.filter((s) => !isSkillName(s.name)).map((s) => s.name)
  console.log(`[${preset}] dir=${dir}`)
  console.log(`  found=${skills.length} names=${names.join(', ')}`)
  if (bad.length > 0) {
    console.log(`  INVALID names: ${bad.join(', ')}`)
    failures++
  }
  // Each discovered skill must load (file exists).
  for (const s of skills) {
    const loaded = await (await import('./lib/index.js')).loadSkill(s)
    if (!loaded || loaded.content.length === 0) {
      console.log(`  UNLOADABLE: ${s.name} @ ${s.path}`)
      failures++
    }
  }
}

// A tiny free-standing parse check (flat + bundle + invalid).
const okBundle = parseSkillSource(['---', 'name: my-skill', 'description: A skill.', '---', 'body'].join('\n'), '/x/my-skill/SKILL.md')
if (!okBundle || okBundle.content !== 'body') { console.log('bundle parse FAIL'); failures++ }
else console.log(`\n[bundle] name=${okBundle.name} resourceBase=${okBundle.resourceBase}`)
const flat = parseSkillSource(['---', 'name: flat-skill', 'description: F.', 'whenToUse: X', '---', 'B'].join('\n'), '/x/flat-skill.md')
if (!flat || flat.whenToUse !== 'X') { console.log('flat parse FAIL'); failures++ }
else console.log(`[flat] name=${flat.name} whenToUse=${flat.whenToUse} resourceBase=${flat.resourceBase}`)
const noName = parseSkillSource('---\ndescription: nope\n---\n')
if (noName !== undefined) { console.log('no-name parse FAIL'); failures++ }
else console.log('[none] missing name rejected OK')

if (!existsSync(ROOT + '/.agent-presets')) { console.log(`\nWARN: ${ROOT} has no .agent-presets; real-dir checks may be empty`) }

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
