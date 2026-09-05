/**
 * smoke-register — exercise the preset-skill prepare/apply pipeline against the
 * REAL preset skills directories with a mock (in-memory) registration sink.
 *
 * Verifies, without any dsh runtime:
 *   - preparePresetSkills discovers + parses research(20)/teacher(5)/developer(2);
 *   - applyPresetDefinitions registers definitions and returns disposers;
 *   - every emitted registration is a legal runtime skill definition
 *     (kebab name, description, invocation booleans, provider, source, content);
 *   - sinks are isolated per preset (the mock simulates one agent scope each);
 *   - resolve/discover failures fold into prepared results instead of throwing;
 *   - v4.2 switch convergence: applying preset B after A disposes A's
 *     disposers and leaves only B registered (one shared layer).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { preparePresetSkills, applyPresetDefinitions, toRegistration } from '../lib/index.js'
import { parseSkillSource, isSkillName } from '../lib/index.js'

const ROOT = process.env.DSH_HOME || 'C:/Users/fuqia/.dsh'
const PRESETS = [
  { id: 'research', expect: 20 },
  { id: 'teacher', expect: 5 },
  { id: 'developer', expect: 2 },
]

/** One simulated agent-scope skill layer: name → disposer, register/dispose ops. */
function makeLayer() {
  const entries = new Map()
  const ops = []
  return {
    entries,
    ops,
    register(registration) {
      if (entries.has(registration.name)) throw new Error(`duplicate ${registration.name}`)
      let live = true
      entries.set(registration.name, registration)
      ops.push(['register', registration.name])
      return () => {
        if (!live) return
        live = false
        entries.delete(registration.name)
        ops.push(['dispose', registration.name])
      }
    },
  }
}

function readSeam(log = () => {}) {
  return {
    async resolveSkillsDir(id) {
      return join(ROOT, '.agent-presets', id, 'skills')
    },
    async discover(dir) {
      const { discoverSkills } = await import('../lib/index.js')
      return await discoverSkills(dir)
    },
    async load(skill) {
      const { loadSkill } = await import('../lib/index.js')
      return await loadSkill(skill)
    },
    log,
  }
}

for (const { id, expect } of PRESETS) {
  test(`prepare+apply: preset ${id} yields ${expect} registrations`, async () => {
    const layer = makeLayer()
    const seam = readSeam()
    const prepared = await preparePresetSkills(id, seam)
    assert.equal(prepared.state, 'ok', `state for ${id}`)
    assert.equal(prepared.found, expect, `found ${id}`)
    assert.equal(prepared.skipped.length, 0, `skipped ${id}: ${prepared.skipped.join(',')}`)
    assert.equal(prepared.definitions.length, expect)
    const applied = await applyPresetDefinitions(prepared, (def) => layer.register(def))
    assert.equal(applied.registered, expect, `registered ${id}`)
    assert.equal(applied.disposers.length, expect)
    assert.equal(layer.entries.size, expect)
    for (const reg of layer.entries.values()) {
      assert.ok(isSkillName(reg.name), `bad name ${reg.name}`)
      assert.ok(typeof reg.description === 'string' && reg.description.length > 0, `${reg.name} description`)
      assert.equal(typeof reg.invocation.modelInvocable, 'boolean', `${reg.name} modelInvocable`)
      assert.equal(typeof reg.invocation.userInvocable, 'boolean', `${reg.name} userInvocable`)
      assert.equal(reg.provider, 'dsh-preset-skills', `${reg.name} provider stamp`)
      assert.equal(reg.source, 'runtime', `${reg.name} source`)
      assert.equal(reg.resourceBase.kind, 'directory', `${reg.name} resourceBase kind`)
      assert.equal(reg.resourceBase.path, dirname(reg.path), `${reg.name} resourceBase path`)
      assert.ok(typeof reg.content === 'string', `${reg.name} content`)
      assert.ok(reg.path.startsWith(join(ROOT, '.agent-presets', id)), `${reg.name} path under preset`)
    }
  })
}

test('v4.2 switch convergence: B replaces A in one shared layer', async () => {
  const layer = makeLayer()
  const seam = readSeam()

  // Agent created under research → apply research set.
  const researchPrepared = await preparePresetSkills('research', seam)
  const researchApplied = await applyPresetDefinitions(researchPrepared, (def) => layer.register(def))
  assert.ok(researchApplied.registered === 20)
  assert.ok([...layer.entries.keys()].includes('nature-writing'))

  // Blank-session switch to teacher: prepare new set read-only…
  const teacherPrepared = await preparePresetSkills('teacher', seam)
  assert.ok(teacherPrepared.definitions.length === 5)
  // …still research-only in the layer (nothing disposed before apply)…
  assert.ok([...layer.entries.keys()].includes('nature-writing'))
  assert.ok(![...layer.entries.keys()].includes('chaoxing-suite'))
  // …dispose the old set…
  for (const disposer of researchApplied.disposers) disposer()
  assert.ok(layer.entries.size === 0)
  // …then apply the new set.
  const teacherApplied = await applyPresetDefinitions(teacherPrepared, (def) => layer.register(def))
  assert.ok(teacherApplied.registered === 5)
  const names = [...layer.entries.keys()]
  assert.ok(names.includes('chaoxing-suite'))
  assert.ok(!names.includes('nature-writing'), 'research names must be gone after switch')
  assert.ok(layer.entries.size === 5)

  // Disposers of the replaced set are single-shot: second call is a no-op.
  assert.doesNotThrow(() => teacherApplied.disposers[0]())
})

test('unknown preset id folds into a prepared resolve-failed result', async () => {
  const prepared = await preparePresetSkills('no-such-preset', {
    ...readSeam(),
    async resolveSkillsDir() {
      return undefined
    },
  })
  assert.equal(prepared.state, 'resolve-failed')
  assert.equal(prepared.definitions.length, 0)
})

test('missing preset id yields no-preset result without touching anything', async () => {
  const prepared = await preparePresetSkills(undefined, {
    async resolveSkillsDir() {
      throw new Error('must not be called')
    },
    async discover() {
      throw new Error('must not be called')
    },
    async load() {
      return undefined
    },
    register() {
      return () => {}
    },
    log() {},
  })
  assert.equal(prepared.state, 'no-preset')
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
