/**
 * smoke-register — exercise the preset-skill registration pipeline against the
 * REAL preset skills directories with a mock (in-memory) registration sink.
 *
 * Verifies, without any dsh runtime:
 *   - registerPresetSkills discovers + registers research(20)/teacher(5)/developer(2);
 *   - every emitted registration is a legal runtime skill definition
 *     (kebab name, description, invocation booleans, provider, source, content);
 *   - sinks are isolated per preset (the mock simulates one agent scope each —
 *     no cross-preset leakage possible at the pipeline level);
 *   - resolve/discover failures fold into results instead of throwing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { registerPresetSkills, toRegistration } from '../lib/index.js'
import { parseSkillSource, isSkillName } from '../lib/index.js'

const ROOT = process.env.DSH_HOME || 'C:/Users/fuqia/.dsh'
const PRESETS = [
  { id: 'research', expect: 20 },
  { id: 'teacher', expect: 5 },
  { id: 'developer', expect: 2 },
]

/** Simulate one agent-scope sink: registrations land in this preset's bag. */
function mockSink() {
  const bag = []
  return {
    bag,
    register(registration) {
      bag.push(registration)
    },
  }
}

function seamFor(presetId, sink, resolve) {
  return {
    async resolveSkillsDir(id) {
      if (id !== presetId) throw new Error(`resolve called for unexpected preset ${id}`)
      return resolve()
    },
    async discover(dir) {
      const { discoverSkills } = await import('../lib/index.js')
      return await discoverSkills(dir)
    },
    async load(skill) {
      const { loadSkill } = await import('../lib/index.js')
      return await loadSkill(skill)
    },
    register: sink.register,
    log() {},
  }
}

for (const { id, expect } of PRESETS) {
  test(`register pipeline: preset ${id} registers ${expect} skills`, async () => {
    const sink = mockSink()
    const dir = join(ROOT, '.agent-presets', id, 'skills')
    const result = await registerPresetSkills(id, seamFor(id, sink, () => dir))
    assert.equal(result.state, 'ok', `state for ${id}`)
    assert.equal(result.found, expect, `found ${id}`)
    assert.equal(result.registered, expect, `registered ${id}`)
    assert.equal(result.skipped.length, 0, `skipped ${id}: ${result.skipped.join(',')}`)
    assert.equal(sink.bag.length, expect)
    for (const reg of sink.bag) {
      assert.ok(isSkillName(reg.name), `bad name ${reg.name}`)
      assert.ok(typeof reg.description === 'string' && reg.description.length > 0, `${reg.name} description`)
      assert.equal(typeof reg.invocation.modelInvocable, 'boolean', `${reg.name} modelInvocable`)
      assert.equal(typeof reg.invocation.userInvocable, 'boolean', `${reg.name} userInvocable`)
      assert.equal(reg.provider, 'dsh-preset-skills', `${reg.name} provider stamp`)
      assert.equal(reg.source, 'runtime', `${reg.name} source`)
      assert.equal(reg.resourceBase.kind, 'directory', `${reg.name} resourceBase kind`)
      // Directory bundles resolve against their own directory; flat skills
      // against the skills dir — either way: the file's parent directory.
      const { dirname } = await import('node:path')
      assert.equal(reg.resourceBase.path, dirname(reg.path), `${reg.name} resourceBase path`)
      assert.ok(typeof reg.content === 'string', `${reg.name} content`)
      assert.ok(reg.path.startsWith(dir), `${reg.name} path under skills dir`)
    }
  })
}

test('registration names across presets do not collide at pipeline level (per-scope sinks)', async () => {
  // Each preset registers into its own sink; duplicate names across presets are
  // legal (layers are per scope). Assert nothing leaks BETWEEN sinks by
  // registering into one sink and checking a second stays empty.
  const research = mockSink()
  const teacher = mockSink()
  const dirR = join(ROOT, '.agent-presets', 'research', 'skills')
  const dirT = join(ROOT, '.agent-presets', 'teacher', 'skills')
  await registerPresetSkills('research', seamFor('research', research, () => dirR))
  await registerPresetSkills('teacher', seamFor('teacher', teacher, () => dirT))
  assert.ok(research.bag.length > 0)
  assert.ok(teacher.bag.length > 0)
  // Sinks (one per agent scope) are independent: registering research into its
  // own sink never wrote into teacher's, and vice versa.
  assert.ok(research.bag.every((r) => r.path.includes(join('research', 'skills'))))
  assert.ok(teacher.bag.every((r) => r.path.includes(join('teacher', 'skills'))))
})

test('unknown preset id resolves to a folded result (resolve-failed)', async () => {
  const sink = mockSink()
  const result = await registerPresetSkills('no-such-preset', {
    async resolveSkillsDir() {
      return undefined
    },
    async discover() {
      return []
    },
    async load() {
      return undefined
    },
    register: sink.register,
    log() {},
  })
  assert.equal(result.state, 'resolve-failed')
  assert.equal(result.registered, 0)
  assert.equal(sink.bag.length, 0)
})

test('missing preset id yields no-preset result without touching anything', async () => {
  const result = await registerPresetSkills(undefined, {
    async resolveSkillsDir() {
      throw new Error('must not be called')
    },
    async discover() {
      throw new Error('must not be called')
    },
    async load() {
      return undefined
    },
    register() {},
    log() {},
  })
  assert.equal(result.state, 'no-preset')
})

test('toRegistration maps a parsed skill fully', () => {
  const parsed = parseSkillSource(
    ['---', 'name: demo-skill', 'description: A demo.', 'whenToUse: When X.', 'disable-model-invocation: true', '---', 'Body text'].join('\n'),
    '/p/demo-skill/SKILL.md',
  )
  assert.ok(parsed)
  const reg = toRegistration(parsed)
  assert.equal(reg.name, 'demo-skill')
  assert.equal(reg.whenToUse, 'When X.')
  assert.equal(reg.invocation.modelInvocable, false)
  assert.equal(reg.invocation.userInvocable, true)
  assert.equal(reg.content, 'Body text')
  assert.equal(reg.resourceBase.path, '/p/demo-skill')
})
