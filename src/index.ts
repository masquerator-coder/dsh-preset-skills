/**
 * dsh-preset-skills — register each agent preset's own `skills/` directory as
 * discoverable, strictly preset-isolated skills.
 *
 * v4 bundle mechanism (out-of-tree; replaces the old per-preset copy-in rows):
 *
 *   - Host-plane plugin row (profile bundle, unscoped). It observes
 *     `agent/created`, which the agent factory emits AFTER the agent's preset
 *     was composed in `setup` (session-controller new-session AND resume both
 *     mount the preset before publication), so `composedPreset(agent.ctx)`
 *     already resolves at that point.
 *   - A host (unscoped) listener is admitted for agent-scoped dispatches by
 *     dsh-scope's carrier filter (`scopeTarget`: an untagged ctx returns true),
 *     so the event reaches this host plane.
 *   - Skills are registered through the skills service reached FROM THE
 *     AGENT'S OWN scoped context (`agent.ctx`), so `SkillRegistry.register()`
 *     — whose layer is decided by the CALLING context's scope via Cordis
 *     `getTraceable` — files into that agent's own scope layer. The agent's
 *     scope chain is `[agentKey → presetStandingKey → …]`, so:
 *       · the session's own `/`-catalog read (`skills.list({scope: agent})`)
 *         sees the registrations (nearest layer wins),
 *       · sibling presets never do (their standing keys are disjoint), and
 *       · the registration effect is owned by the agent's scope fiber, so it
 *         is removed automatically when the agent is torn down.
 *   - A preset whose standing composition publishes its OWN `skills` service
 *     (behind an isolate realm) is preferred via `agentPresets.serviceFor`;
 *     registering on that instance files into the standing scope layer.
 *   - The skills directory for a preset id is resolved through the roster
 *     (`agentPresets.resolve(id).path` → `dirname(path)/skills`), covering
 *     both user-root presets (`~/.dsh/.agent-presets/<id>/skills`) and
 *     shipped-root presets that carry one (e.g. `cordis`).
 *
 * v4.2 — dynamic preset switching on a BLANK session:
 *
 *   dsh allows switching an agent to another preset while its session is blank
 *   (`agent-presets select → swap`: guarded by turnBoundary, then
 *   `recompose()` re-links the agent scope to the new standing key, and only
 *   after the commit appends `agent-preset/selected` to the session). That
 *   recompose does NOT re-announce `agent/created`, so v4.1 left the previous
 *   preset's skills in the agentKey layer and never registered the new
 *   preset's. v4.2 listens for `agent-preset/selected` (sessionId, preset),
 *   resolves the live agent, and CONVERGES that agent's registration:
 *   prepare the new preset's skills read-only first, then dispose the
 *   previous set's disposers, then apply the new set. All per-agent work runs
 *   through one serialized queue, so a switch racing an in-flight
 *   `agent/created` registration cannot interleave. Disposing the old set
 *   mirrors dsh's own recompose semantics (re-link = swap of the resolved
 *   view); the blank-session guard means no model turn observes the window.
 *
 * All services are resolved lazily INSIDE the event handlers (never cached at
 * `apply` time), so composition order cannot strand the plugin with a stale
 * `undefined` service handle.
 *
 * Marker log (`<DSH_HOME>/dsh-preset-skills.log`, append-only) is the
 * deterministic evidence channel: every event, resolution, registration, and
 * switch is recorded there regardless of logger level.
 *
 * @module dsh-preset-skills
 */

import type { Context } from '@deepseek-ai/cordis'
import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { discoverSkills, loadSkill } from './parse.ts'
import {
  applyPresetDefinitions,
  preparePresetSkills,
  toRegistration,
  type RegisterSeam,
  type SkillRegistration,
} from './register.ts'
import type { AgentLike, AgentPresetsLike, SkillsLike } from './types.ts'

export { discoverSkills, loadSkill, parseSkillSource, isSkillName } from './parse.ts'
export {
  applyPresetDefinitions,
  preparePresetSkills,
  toRegistration,
} from './register.ts'
export type { RegisterSeam, PreparedPreset, ApplyResult, SkillRegistration } from './register.ts'

export const name = 'dsh-preset-skills'

/** Build stamp included in marker lines so experiments identify the running code. */
const BUILD = 'v4.2.1'

/** Config accepted by the binder. */
export interface Config {
  /** DSH_HOME override; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Marker log path override; defaults to `<DSH_HOME>/dsh-preset-skills.log`. */
  logFile?: string
  /** Append candidate-event probes to the marker log (diagnostic noise). */
  debug?: boolean
}

/** One applied registration set for a live agent (WeakMap value; GC with agent). */
interface RegistrationRecord {
  readonly presetId: string
  readonly disposers: readonly (() => void)[]
}

/** Resolve DSH_HOME the same way `@deepseek-ai/dsh-home-paths` does. */
function resolveDshHome(override?: string): string {
  if (override !== undefined && override.length > 0) return override
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function apply(ctx: Context, config: Config = {}): void {
  const dshHome = resolveDshHome(config.dshHome)
  const logFile = config.logFile ?? join(dshHome, 'dsh-preset-skills.log')
  const debug = config.debug ?? false

  const log = (line: string): void => {
    void appendFile(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8')
      .catch((error) => ctx.logger.warn(`[preset-skills] marker append failed: ${String(error)}`))
  }

  log(`[preset-skills] apply build=${BUILD} dshHome=${dshHome} debug=${debug} logFile=${logFile}`)

  // Lazy reads: never cache a service at apply time. `get` is Cordis' strict
  // non-inject read; it returns a caller-traced wrapper (or undefined).
  const getService = <T>(name: string): T | undefined => {
    try {
      return (ctx as unknown as { get(n: string): unknown }).get(name) as T | undefined
    } catch {
      return undefined
    }
  }

  // dsh event names are declared through module augmentation of cordis' Events
  // in the dsh packages, which this out-of-tree checkout does not compile
  // against; route listeners through a local untyped `on` for the same shape.
  const on = (name: string, listener: (...args: any[]) => void): void => {
    ;(ctx as unknown as { on(name: string, listener: (...args: any[]) => void): unknown }).on(name, listener)
  }

  /** Per-agent serialized work: a switch racing a create cannot interleave. */
  const queues = new Map<string, Promise<void>>()
  const current = new WeakMap<object, RegistrationRecord>()

  /**
   * Memoized preset → skills-dir resolution. `agentPresets.resolve` triggers a
   * full roster discovery (health checks over every preset composition) on
   * EACH call, which is far slower than the client UI's one-shot catalog
   * prewarm — enough to lose the race on a freshly created session (the UI
   * caches the empty catalog until a preset switch invalidates it). Resolve
   * once per preset per process so registration finishes before the prewarm.
   */
  const dirCache = new Map<string, Promise<string | undefined>>()
  const resolveSkillsDirMemo = (agentPresets: AgentPresetsLike | undefined, preset: string): Promise<string | undefined> => {
    if (agentPresets === undefined) return Promise.resolve(undefined)
    let memo = dirCache.get(preset)
    if (memo === undefined) {
      memo = (async () => {
        const resolved = await agentPresets.resolve(preset)
        if (resolved === undefined || resolved.path === undefined) return undefined
        return join(dirname(resolved.path), 'skills')
      })()
      memo.catch(() => { dirCache.delete(preset) })
      dirCache.set(preset, memo)
    }
    return memo
  }

  const enqueue = (agentId: string, task: () => Promise<void>): void => {
    const prev = queues.get(agentId) ?? Promise.resolve()
    const guard = prev.then(task, task).catch(() => undefined)
    queues.set(agentId, guard)
    void guard.then(() => {
      if (queues.get(agentId) === guard) queues.delete(agentId)
    })
  }

  /** Roster-backed, memoized skills-dir lookup used by every seam. */
  const resolveDir = (preset: string): Promise<string | undefined> =>
    resolveSkillsDirMemo(getService<AgentPresetsLike>('agentPresets'), preset)

  // ---------------------------------------------------------------------------
  // MAIN HOOK: agent/created. Preset already composed; register its skills and
  // record the applied set so a later blank-session switch can converge it.
  // Body is fully async-contained: a synchronous throw would veto publication.
  // ---------------------------------------------------------------------------
  on('agent/created', ({ agent }: { agent: unknown }) => {
    const a = agent as AgentLike
    try {
      const delegated = sessionDelegationDepth(agent)
      if (delegated > 0) {
        log(`[preset-skills] agent/created build=${BUILD} agent=${String(a.id ?? '?')} DELEGATED depth=${delegated} (skip)`)
        return
      }
      enqueue(String(a.id ?? '?'), () => syncPreset({
        agent: agent as AgentView,
        source: 'created',
        desired: resolveComposedPreset(ctx, agent, log),
        log,
        getService,
        resolveDir,
        current,
      }))
    } catch (error) {
      log(`[preset-skills] ERROR enqueue agent/created agent=${String(a.id ?? '?')}: ${String(error)}`)
    }
  })

  // ---------------------------------------------------------------------------
  // v4.2: dynamic preset switch on a live (blank) session. agent-presets emits
  // this AFTER recompose committed AND the session appended agent-preset/selected
  // (agent-presets/src/index.ts swap: recompose → append → session/event → emit).
  // Converge the agent's registrations: dispose previous set, apply the new.
  // ---------------------------------------------------------------------------
  on('agent-preset/selected', (sessionId: unknown, agentPreset: unknown) => {
    const sid = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '?')
    const preset = typeof agentPreset === 'string' ? agentPreset : undefined
    try {
      if (preset === undefined) {
        log(`[preset-skills] preset/selected build=${BUILD} agent=${sid} INVALID preset payload`)
        return
      }
      const agents = getService<{ get(id: string): unknown }>('agents')
      const agent = agents?.get(sid) as AgentView | undefined
      if (agent === undefined || !isAgentLike(agent)) {
        log(`[preset-skills] preset/selected build=${BUILD} agent=${sid} to=${preset} no-live-agent (skip)`)
        return
      }
      if (sessionDelegationDepth(agent) > 0) {
        log(`[preset-skills] preset/selected build=${BUILD} agent=${sid} to=${preset} DELEGATED (skip)`)
        return
      }
      enqueue(sid, () => syncPreset({
        agent,
        source: 'selected',
        desired: preset,
        log,
        getService,
        resolveDir,
        current,
      }))
    } catch (error) {
      log(`[preset-skills] ERROR preset/selected agent=${sid}: ${String(error)}`)
    }
  })

  // ---------------------------------------------------------------------------
  // DEBUG EVENT PROBES — candidate lifecycle events for the empirical hook test.
  // ---------------------------------------------------------------------------
  if (debug) {
    on('session/created', (session: unknown) => {
      log(`[preset-skills:ev] session/created id=${idOfSession(session)}`)
    })
    on('agent/session-start', ({ agent }: { agent: unknown }) => {
      log(`[preset-skills:ev] agent/session-start agent=${idOfAgent(agent)}`)
    })
    on('session/event', (session: unknown, event: { type?: string }) => {
      const sid = idOfSession(session)
      const type = typeof event?.type === 'string' ? event.type : '?'
      if (type === 'agent-preset/selected') {
        log(`[preset-skills:ev] session/event agent-preset/selected session=${sid} data=${safeString(event)}`)
        return
      }
      const key = `${sid}:${type}`
      if (seenEventTypes.has(key)) return
      seenEventTypes.add(key)
      if (seenEventTypes.size > 4096) seenEventTypes.clear()
      log(`[preset-skills:ev] session/event session=${sid} first=${type}`)
    })
  }
}

/** Debug probe dedupe key (first event type per session). */
const seenEventTypes = new Set<string>()

/** Minimal structural agent surface used by the sync path. */
interface AgentView {
  readonly id?: unknown
  readonly ctx: unknown
  readonly session?: unknown
}

interface SyncDeps {
  log: (line: string) => void
  getService: <T>(name: string) => T | undefined
  resolveDir: (presetId: string) => Promise<string | undefined>
  current: WeakMap<object, RegistrationRecord>
}

/**
 * Converge one agent's registrations onto `desired` preset: prepare read-only,
 * then dispose the previous applied set (if any) and apply the new one.
 * Never throws.
 */
async function syncPreset(opts: {
  agent: AgentView
  source: 'created' | 'selected'
  desired: string | undefined
} & SyncDeps): Promise<void> {
  const { agent, source, desired, log, getService, resolveDir, current } = opts
  const agentId = String(agent.id ?? '?')
  if (desired === undefined || desired.length === 0) {
    log(`[preset-skills] sync build=${BUILD} agent=${agentId} source=${source} preset=<none> (no preset)`)

    return
  }
  const record = current.get(agent as object)
  if (record !== undefined && record.presetId === desired) {
    log(`[preset-skills] sync build=${BUILD} agent=${agentId} source=${source} to=${desired} already-current`)
    return
  }

  const seam = makeSeam(getService, agent, log, resolveDir)
  const prepared = await preparePresetSkills(desired, seam)
  if (prepared.state !== 'ok') {
    log(
      `[preset-skills] sync build=${BUILD} agent=${agentId} source=${source} to=${desired} `
      + `state=${prepared.state} KEEP current=${record?.presetId ?? '<none>'}`,
    )
    return
  }

  // Dispose the previous set only after the new set is fully prepared.
  let disposed = 0
  if (record !== undefined) {
    for (const disposer of record.disposers) {
      try {
        disposer()
      } catch (error) {
        log(`[preset-skills] sync dispose error agent=${agentId}: ${String(error)}`)
      }
      disposed += 1
    }
    current.delete(agent as object)
  }

  const applied = await applyPresetDefinitions(prepared, seam.register)
  const from = record === undefined ? '<none>' : record.presetId
  current.set(agent as object, { presetId: desired, disposers: applied.disposers })

  log(
    `[preset-skills] sync build=${BUILD} agent=${agentId} source=${source} from=${from} to=${desired} `
    + `dir=${prepared.skillsDir ?? '<none>'} state=ok found=${prepared.found} disposed=${disposed} `
    + `registered=${applied.registered}${applied.skipped.length > 0 ? ` skipped=[${applied.skipped.join('|')}]` : ''}`,
  )
}

/** Resolve the preset an agent currently runs, with a session-header fallback. */
function resolveComposedPreset(ctx: Context, agent: unknown, log: (line: string) => void): string | undefined {
  const a = agent as AgentLike
  try {
    const agentPresets = readAgentPresets(ctx)
    if (agentPresets !== undefined) {
      try {
        const presetId = agentPresets.composedPreset(a.ctx)
        if (presetId !== undefined && presetId.length > 0) return presetId
      } catch (error) {
        log(`[preset-skills] composedPreset threw agent=${String(a.id ?? '?')}: ${String(error)}`)
      }
    }
  } catch {
    // fall through to header
  }
  return sessionHeaderPreset(agent)
}

function readAgentPresets(ctx: Context): AgentPresetsLike | undefined {
  try {
    return (ctx as unknown as { get(n: string): unknown }).get('agentPresets') as AgentPresetsLike | undefined
  } catch {
    return undefined
  }
}

/** The dsh seams backing prepare/apply for one live agent. */
function makeSeam(
  getService: <T>(name: string) => T | undefined,
  agent: AgentView,
  log: (line: string) => void,
  resolveDir: (presetId: string) => Promise<string | undefined>,
): RegisterSeam {
  const agentPresets = getService<AgentPresetsLike>('agentPresets')
  return {
    resolveSkillsDir: resolveDir,
    discover: (dir) => discoverSkills(dir),
    load: (skill) => loadSkill(skill),
    register(definition: SkillRegistration): (() => void) | undefined {
      const target = registrationTarget(agentPresets, agent)
      if (target === undefined) throw new Error('no skills service reachable from the agent context')
      const disposer = (target as SkillsLike).register(definition)
      return typeof disposer === 'function' ? disposer as () => void : undefined
    },
    log,
  }
}

/**
 * Which skills registry instance to register through, and via which context.
 *
 * 1. If the agent's preset standing composition published its own `skills`
 *    service, prefer it: registering on that instance files into the preset
 *    standing layer (shared by every agent of the preset).
 * 2. Otherwise register through the host registry reached FROM the agent's own
 *    scoped context — Cordis traces the call to `agent.ctx`, so the registry
 *    files into the agent's own scope layer.
 *
 * Both channels stay preset/agent-isolated; neither touches the host (global)
 * layer.
 */
function registrationTarget(
  agentPresets: AgentPresetsLike | undefined,
  agent: AgentView,
): { register(registration: unknown): unknown } | undefined {
  if (agentPresets !== undefined) {
    try {
      const scoped = agentPresets.serviceFor({ ctx: agent.ctx as Context }, 'skills') as
        | { register(registration: unknown): unknown }
        | undefined
      if (scoped !== undefined) return scoped
    } catch {
      // Fall through to the agent-context channel.
    }
  }
  try {
    const ctxRead = agent.ctx as unknown as { get?(name: string): unknown }
    const skills = ctxRead.get?.('skills') as { register(registration: unknown): unknown } | undefined
    return skills
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Minimal structural readers (best-effort, never throw).
// ---------------------------------------------------------------------------

function isAgentLike(value: unknown): value is AgentView {
  return typeof value === 'object' && value !== null
}

function idOfAgent(agent: unknown): string {
  try {
    const id = (agent as { id?: unknown }).id
    return id === undefined ? '?' : String(id)
  } catch {
    return '?'
  }
}

function idOfSession(session: unknown): string {
  try {
    const s = session as { id?: unknown; sessionId?: unknown }
    return s.id !== undefined ? String(s.id) : s.sessionId !== undefined ? String(s.sessionId) : '?'
  } catch {
    return '?'
  }
}

/** Subagent heuristic: session delegation depth. 0/absent = top-level session. */
function sessionDelegationDepth(agent: unknown): number {
  try {
    const s = (agent as { session?: { header?: { delegationDepth?: unknown }; meta?: { delegationDepth?: unknown } } }).session
    const depth = s?.header?.delegationDepth ?? s?.meta?.delegationDepth
    return typeof depth === 'number' && depth > 0 ? depth : 0
  } catch {
    return 0
  }
}

/** Best-effort read of the session header's recorded agent preset. */
function sessionHeaderPreset(agent: unknown): string | undefined {
  try {
    const s = (agent as {
      session?: { header?: { agentPreset?: unknown }; meta?: { agentPreset?: unknown } }
    }).session
    const value = s?.header?.agentPreset ?? s?.meta?.agentPreset
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function safeString(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export default apply
