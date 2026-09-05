/**
 * dsh-preset-skills — register each agent preset's own `skills/` directory as
 * discoverable, strictly preset-isolated skills.
 *
 * v4 mechanism (bundle-based, out-of-tree; replaces the old per-preset
 * copy-in rows in `agent.cordis.yml`):
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
 * All services are resolved lazily INSIDE the event handler (never cached at
 * `apply` time), so composition order cannot strand the plugin with a stale
 * `undefined` service handle.
 *
 * Marker log (`<DSH_HOME>/dsh-preset-skills.log`, append-only) is the
 * deterministic evidence channel: every event, resolution, and registration
 * attempt is recorded there regardless of logger level.
 *
 * @module dsh-preset-skills
 */

import type { Context } from '@deepseek-ai/cordis'
import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { discoverSkills, loadSkill } from './parse.ts'
import { registerPresetSkills, toRegistration, type RegisterSeam } from './register.ts'
import type { AgentLike, AgentPresetsLike, SkillsLike } from './types.ts'

export { discoverSkills, loadSkill, parseSkillSource, isSkillName } from './parse.ts'
export { registerPresetSkills, toRegistration } from './register.ts'
export type { RegisterSeam, PresetRegisterResult, SkillRegistration } from './register.ts'

export const name = 'dsh-preset-skills'

/** Build stamp included in marker lines so experiments identify the running code. */
const BUILD = 'v4.1'

/** Config accepted by the binder. */
export interface Config {
  /** DSH_HOME override; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Marker log path override; defaults to `<DSH_HOME>/dsh-preset-skills.log`. */
  logFile?: string
  /** Append candidate-event probes to the marker log (diagnostic noise). */
  debug?: boolean
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

  // ---------------------------------------------------------------------------
  // MAIN HOOK: agent/created. The preset is already composed at this point.
  // Body is fully async-contained: a synchronous throw would veto publication.
  // ---------------------------------------------------------------------------
  on('agent/created', ({ agent }: { agent: unknown }) => {
    void handleAgentCreated(ctx, agent, { log, getService })
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
      // Firehose is chatty: record only the first event type per session and
      // every preset switch (the recompose signal).
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
    on('agent-preset/selected', (sessionId: unknown, agentPreset: unknown) => {
      log(`[preset-skills:ev] agent-preset/selected session=${String(sessionId)} preset=${String(agentPreset)}`)
    })
  }
}

/** Debug probe dedupe key (first event type per session). */
const seenEventTypes = new Set<string>()

/** Handle one `agent/created`: resolve preset, discover, register. Never throws. */
async function handleAgentCreated(
  ctx: Context,
  agent: unknown,
  deps: { log: (line: string) => void; getService: <T>(name: string) => T | undefined },
): Promise<void> {
  const { log, getService } = deps
  const a = agent as AgentLike
  const id = String(a.id ?? '?')
  try {
    const agentPresets = getService<AgentPresetsLike>('agentPresets')
    const delegated = sessionDelegationDepth(agent)
    if (delegated > 0) {
      log(`[preset-skills] agent/created build=${BUILD} agent=${id} DELEGATED depth=${delegated} (skip)`)
      return
    }

    let presetId: string | undefined
    let presetSource = 'none'
    if (agentPresets !== undefined) {
      try {
        presetId = agentPresets.composedPreset(a.ctx)
        if (presetId !== undefined && presetId.length > 0) presetSource = 'composed'
      } catch (error) {
        log(`[preset-skills] composedPreset threw agent=${id}: ${String(error)}`)
      }
    }
    // Fallback: an agent announced without a composed preset may still declare
    // one on its session header (e.g. some resume paths). Resolve that id.
    if (presetId === undefined) {
      const headerPreset = sessionHeaderPreset(agent)
      if (headerPreset !== undefined) {
        presetId = headerPreset
        presetSource = 'header'
      }
    }

    const seam: RegisterSeam = {
      async resolveSkillsDir(preset) {
        if (agentPresets === undefined) return undefined
        const resolved = await agentPresets.resolve(preset)
        if (resolved === undefined || resolved.path === undefined) return undefined
        return join(dirname(resolved.path), 'skills')
      },
      discover: (dir) => discoverSkills(dir),
      load: (skill) => loadSkill(skill),
      register(registration) {
        const target = registrationTarget(agentPresets, agent)
        if (target === undefined) throw new Error('no skills service reachable from the agent context')
        target.register(registration as never)
      },
      log,
    }

    const result = await registerPresetSkills(presetId, seam)
    if (result.state === 'no-preset') {
      log(
        `[preset-skills] agent/created build=${BUILD} agent=${id} preset=<none> `
        + `agentPresets=${agentPresets === undefined ? 'missing' : 'present'} source=${presetSource} delegated=${delegated}`,
      )
      return
    }
    log(
      `[preset-skills] agent/created build=${BUILD} agent=${id} preset=${result.presetId} `
      + `presetSource=${presetSource} agentPresets=${agentPresets === undefined ? 'missing' : 'present'} `
      + `dir=${result.skillsDir ?? '<none>'} state=${result.state} found=${result.found} `
      + `registered=${result.registered}${result.skipped.length > 0 ? ` skipped=[${result.skipped.join('|')}]` : ''}`,
    )
  } catch (error) {
    log(`[preset-skills] ERROR agent/created agent=${id}: ${String(error)}`)
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
function registrationTarget(agentPresets: AgentPresetsLike | undefined, agent: unknown): SkillsLike | undefined {
  const a = agent as AgentLike
  if (agentPresets !== undefined) {
    try {
      const scoped = agentPresets.serviceFor({ ctx: a.ctx }, 'skills') as SkillsLike | undefined
      if (scoped !== undefined) return scoped
    } catch {
      // Fall through to the agent-context channel.
    }
  }
  try {
    const ctxRead = a.ctx as unknown as { get?(name: string): unknown }
    return ctxRead.get?.('skills') as SkillsLike | undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Minimal structural readers (best-effort, never throw).
// ---------------------------------------------------------------------------

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
