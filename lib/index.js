// src/index.ts
import { appendFile } from "node:fs/promises";
import { dirname as dirname2, join as join2 } from "node:path";
import { homedir } from "node:os";

// src/parse.ts
import { readdir, readFile, access } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { parse as parseYaml } from "yaml";
var SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function isSkillName(name2) {
  return SKILL_NAME.test(name2);
}
var nodeFs = {
  async readdir(path) {
    return await readdir(path, { encoding: "utf8" });
  },
  async readFile(path) {
    return await readFile(path, { encoding: "utf8" });
  },
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
};
async function loadSkill(skill, fs = nodeFs) {
  let raw;
  try {
    raw = await fs.readFile(skill.path);
  } catch {
    return void 0;
  }
  const parsed = parseSkillSource(raw, skill.path);
  return parsed;
}
async function discoverSkills(dir, fs = nodeFs) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (entry === ".system" || entry.startsWith(".")) continue;
    const bundleFile = join(dir, entry, "SKILL.md");
    if (await fs.exists(bundleFile)) {
      const parsed2 = await parseFile(bundleFile, join(dir, entry), fs);
      if (parsed2 !== void 0) found.push(parsed2);
      continue;
    }
    if (!entry.endsWith(".md") || entry.includes(sep)) continue;
    const file = join(dir, entry);
    const parsed = await parseFile(file, dir, fs);
    if (parsed !== void 0) found.push(parsed);
  }
  return found;
}
async function parseFile(path, resourceBase, fs) {
  let raw;
  try {
    raw = await fs.readFile(path);
  } catch {
    return void 0;
  }
  const parsed = parseSkillSource(raw, path);
  if (parsed === void 0) return void 0;
  const { content: _c, invocation: _i, ...summary } = parsed;
  return { ...summary, resourceBase };
}
function parseSkillSource(source, from = "<skill>") {
  const fm = parseFrontmatter(source);
  if (fm === void 0) return void 0;
  const name2 = stringField(fm.data, "name");
  const description = stringField(fm.data, "description");
  if (name2 === void 0 || description === void 0) return void 0;
  if (!isSkillName(name2)) return void 0;
  let invocation;
  try {
    invocation = parseInvocation(fm.data);
  } catch {
    return void 0;
  }
  return {
    name: name2,
    description,
    ...optionalString(fm.data, "whenToUse"),
    invocation,
    ...optionalMetadata(fm.data),
    content: fm.body.trim(),
    resourceBase: from.endsWith("SKILL.md") ? dirname(from) : dirname(from),
    path: from
  };
}
function parseFrontmatter(raw) {
  const nl = raw.indexOf("\n");
  if (nl < 0) return void 0;
  const first = raw.slice(0, nl).replace(/\r$/, "");
  if (first !== "---") return void 0;
  const start = nl + 1;
  const closing = findClosing(raw, start);
  if (closing === void 0) return void 0;
  const yaml = raw.slice(start, closing.start);
  let data;
  try {
    data = parseYaml(yaml);
  } catch {
    return void 0;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return void 0;
  return { data, body: raw.slice(closing.bodyStart) };
}
function findClosing(raw, start) {
  let lineStart = start;
  while (lineStart <= raw.length) {
    const next = raw.indexOf("\n", lineStart);
    const lineEnd = next < 0 ? raw.length : next;
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") {
      return { start: lineStart, bodyStart: next < 0 ? raw.length : next + 1 };
    }
    if (next < 0) return void 0;
    lineStart = next + 1;
  }
  return void 0;
}
function stringField(data, key) {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : void 0;
}
function optionalString(data, key) {
  const v = stringField(data, key);
  return v === void 0 ? {} : { [key]: v };
}
function optionalMetadata(data) {
  const v = data.metadata;
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return { metadata: v };
  }
  return {};
}
function parseInvocation(data) {
  const model = data["disable-model-invocation"];
  const user = data["user-invocable"];
  return {
    modelInvocable: model !== true,
    userInvocable: user !== false
  };
}

// src/register.ts
async function preparePresetSkills(presetId, seam) {
  if (presetId === void 0 || presetId.length === 0) {
    return { presetId: void 0, skillsDir: void 0, state: "no-preset", found: 0, skipped: [], definitions: [] };
  }
  let dir;
  try {
    dir = await seam.resolveSkillsDir(presetId);
  } catch (error) {
    seam.log(`resolve failed preset=${presetId}: ${describe(error)}`);
    return { presetId, skillsDir: void 0, state: "resolve-failed", found: 0, skipped: [], definitions: [] };
  }
  if (dir === void 0) {
    seam.log(`preset not resolvable preset=${presetId}`);
    return { presetId, skillsDir: void 0, state: "resolve-failed", found: 0, skipped: [], definitions: [] };
  }
  let discovered;
  try {
    discovered = await seam.discover(dir);
  } catch (error) {
    seam.log(`discover failed dir=${dir}: ${describe(error)}`);
    return { presetId, skillsDir: dir, state: "discover-failed", found: 0, skipped: [], definitions: [] };
  }
  const skipped = [];
  const definitions = [];
  for (const skill of discovered) {
    let parsed;
    try {
      parsed = await seam.load(skill);
    } catch {
      parsed = void 0;
    }
    if (parsed === void 0) {
      skipped.push(`${skill.name}:unreadable`);
      continue;
    }
    definitions.push(toRegistration(parsed));
  }
  return { presetId, skillsDir: dir, state: "ok", found: discovered.length, skipped, definitions };
}
async function applyPresetDefinitions(prepared, register) {
  const skipped = [];
  const disposers = [];
  let registered = 0;
  for (const definition of prepared.definitions) {
    try {
      const disposer = register(definition);
      if (disposer !== void 0) disposers.push(disposer);
      registered += 1;
    } catch (error) {
      skipped.push(`${definition.name}:${describe(error)}`);
    }
  }
  return { registered, skipped, disposers };
}
function toRegistration(skill) {
  return {
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse === void 0 ? {} : { whenToUse: skill.whenToUse },
    invocation: {
      modelInvocable: skill.invocation.modelInvocable,
      userInvocable: skill.invocation.userInvocable
    },
    ...skill.metadata !== void 0 ? { metadata: skill.metadata } : {},
    source: "runtime",
    provider: "dsh-preset-skills",
    resourceBase: { kind: "directory", path: skill.resourceBase },
    content: skill.content,
    path: skill.path
  };
}
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/index.ts
var name = "dsh-preset-skills";
var BUILD = "v4.2.1";
function resolveDshHome(override) {
  if (override !== void 0 && override.length > 0) return override;
  return process.env.DSH_HOME || join2(homedir(), ".dsh");
}
function apply(ctx, config = {}) {
  const dshHome = resolveDshHome(config.dshHome);
  const logFile = config.logFile ?? join2(dshHome, "dsh-preset-skills.log");
  const debug = config.debug ?? false;
  const log = (line) => {
    void appendFile(logFile, `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`, "utf8").catch((error) => ctx.logger.warn(`[preset-skills] marker append failed: ${String(error)}`));
  };
  log(`[preset-skills] apply build=${BUILD} dshHome=${dshHome} debug=${debug} logFile=${logFile}`);
  const getService = (name2) => {
    try {
      return ctx.get(name2);
    } catch {
      return void 0;
    }
  };
  const on = (name2, listener) => {
    ;
    ctx.on(name2, listener);
  };
  const queues = /* @__PURE__ */ new Map();
  const current = /* @__PURE__ */ new WeakMap();
  const dirCache = /* @__PURE__ */ new Map();
  const resolveSkillsDirMemo = (agentPresets, preset) => {
    if (agentPresets === void 0) return Promise.resolve(void 0);
    let memo = dirCache.get(preset);
    if (memo === void 0) {
      memo = (async () => {
        const resolved = await agentPresets.resolve(preset);
        if (resolved === void 0 || resolved.path === void 0) return void 0;
        return join2(dirname2(resolved.path), "skills");
      })();
      memo.catch(() => {
        dirCache.delete(preset);
      });
      dirCache.set(preset, memo);
    }
    return memo;
  };
  const enqueue = (agentId, task) => {
    const prev = queues.get(agentId) ?? Promise.resolve();
    const guard = prev.then(task, task).catch(() => void 0);
    queues.set(agentId, guard);
    void guard.then(() => {
      if (queues.get(agentId) === guard) queues.delete(agentId);
    });
  };
  const resolveDir = (preset) => resolveSkillsDirMemo(getService("agentPresets"), preset);
  on("agent/created", ({ agent }) => {
    const a = agent;
    try {
      const delegated = sessionDelegationDepth(agent);
      if (delegated > 0) {
        log(`[preset-skills] agent/created build=${BUILD} agent=${String(a.id ?? "?")} DELEGATED depth=${delegated} (skip)`);
        return;
      }
      enqueue(String(a.id ?? "?"), () => syncPreset({
        agent,
        source: "created",
        desired: resolveComposedPreset(ctx, agent, log),
        log,
        getService,
        resolveDir,
        current
      }));
    } catch (error) {
      log(`[preset-skills] ERROR enqueue agent/created agent=${String(a.id ?? "?")}: ${String(error)}`);
    }
  });
  on("agent-preset/selected", (sessionId, agentPreset) => {
    const sid = typeof sessionId === "string" ? sessionId : String(sessionId ?? "?");
    const preset = typeof agentPreset === "string" ? agentPreset : void 0;
    try {
      if (preset === void 0) {
        log(`[preset-skills] preset/selected build=${BUILD} agent=${sid} INVALID preset payload`);
        return;
      }
      const agents = getService("agents");
      const agent = agents?.get(sid);
      if (agent === void 0 || !isAgentLike(agent)) {
        log(`[preset-skills] preset/selected build=${BUILD} agent=${sid} to=${preset} no-live-agent (skip)`);
        return;
      }
      if (sessionDelegationDepth(agent) > 0) {
        log(`[preset-skills] preset/selected build=${BUILD} agent=${sid} to=${preset} DELEGATED (skip)`);
        return;
      }
      enqueue(sid, () => syncPreset({
        agent,
        source: "selected",
        desired: preset,
        log,
        getService,
        resolveDir,
        current
      }));
    } catch (error) {
      log(`[preset-skills] ERROR preset/selected agent=${sid}: ${String(error)}`);
    }
  });
  if (debug) {
    on("session/created", (session) => {
      log(`[preset-skills:ev] session/created id=${idOfSession(session)}`);
    });
    on("agent/session-start", ({ agent }) => {
      log(`[preset-skills:ev] agent/session-start agent=${idOfAgent(agent)}`);
    });
    on("session/event", (session, event) => {
      const sid = idOfSession(session);
      const type = typeof event?.type === "string" ? event.type : "?";
      if (type === "agent-preset/selected") {
        log(`[preset-skills:ev] session/event agent-preset/selected session=${sid} data=${safeString(event)}`);
        return;
      }
      const key = `${sid}:${type}`;
      if (seenEventTypes.has(key)) return;
      seenEventTypes.add(key);
      if (seenEventTypes.size > 4096) seenEventTypes.clear();
      log(`[preset-skills:ev] session/event session=${sid} first=${type}`);
    });
  }
}
var seenEventTypes = /* @__PURE__ */ new Set();
async function syncPreset(opts) {
  const { agent, source, desired, log, getService, resolveDir, current } = opts;
  const agentId = String(agent.id ?? "?");
  if (desired === void 0 || desired.length === 0) {
    log(`[preset-skills] sync build=${BUILD} agent=${agentId} source=${source} preset=<none> (no preset)`);
    return;
  }
  const record = current.get(agent);
  if (record !== void 0 && record.presetId === desired) {
    log(`[preset-skills] sync build=${BUILD} agent=${agentId} source=${source} to=${desired} already-current`);
    return;
  }
  const seam = makeSeam(getService, agent, log, resolveDir);
  const prepared = await preparePresetSkills(desired, seam);
  if (prepared.state !== "ok") {
    log(
      `[preset-skills] sync build=${BUILD} agent=${agentId} source=${source} to=${desired} state=${prepared.state} KEEP current=${record?.presetId ?? "<none>"}`
    );
    return;
  }
  let disposed = 0;
  if (record !== void 0) {
    for (const disposer of record.disposers) {
      try {
        disposer();
      } catch (error) {
        log(`[preset-skills] sync dispose error agent=${agentId}: ${String(error)}`);
      }
      disposed += 1;
    }
    current.delete(agent);
  }
  const applied = await applyPresetDefinitions(prepared, seam.register);
  const from = record === void 0 ? "<none>" : record.presetId;
  current.set(agent, { presetId: desired, disposers: applied.disposers });
  log(
    `[preset-skills] sync build=${BUILD} agent=${agentId} source=${source} from=${from} to=${desired} dir=${prepared.skillsDir ?? "<none>"} state=ok found=${prepared.found} disposed=${disposed} registered=${applied.registered}${applied.skipped.length > 0 ? ` skipped=[${applied.skipped.join("|")}]` : ""}`
  );
}
function resolveComposedPreset(ctx, agent, log) {
  const a = agent;
  try {
    const agentPresets = readAgentPresets(ctx);
    if (agentPresets !== void 0) {
      try {
        const presetId = agentPresets.composedPreset(a.ctx);
        if (presetId !== void 0 && presetId.length > 0) return presetId;
      } catch (error) {
        log(`[preset-skills] composedPreset threw agent=${String(a.id ?? "?")}: ${String(error)}`);
      }
    }
  } catch {
  }
  return sessionHeaderPreset(agent);
}
function readAgentPresets(ctx) {
  try {
    return ctx.get("agentPresets");
  } catch {
    return void 0;
  }
}
function makeSeam(getService, agent, log, resolveDir) {
  const agentPresets = getService("agentPresets");
  return {
    resolveSkillsDir: resolveDir,
    discover: (dir) => discoverSkills(dir),
    load: (skill) => loadSkill(skill),
    register(definition) {
      const target = registrationTarget(agentPresets, agent);
      if (target === void 0) throw new Error("no skills service reachable from the agent context");
      const disposer = target.register(definition);
      return typeof disposer === "function" ? disposer : void 0;
    },
    log
  };
}
function registrationTarget(agentPresets, agent) {
  if (agentPresets !== void 0) {
    try {
      const scoped = agentPresets.serviceFor({ ctx: agent.ctx }, "skills");
      if (scoped !== void 0) return scoped;
    } catch {
    }
  }
  try {
    const ctxRead = agent.ctx;
    const skills = ctxRead.get?.("skills");
    return skills;
  } catch {
    return void 0;
  }
}
function isAgentLike(value) {
  return typeof value === "object" && value !== null;
}
function idOfAgent(agent) {
  try {
    const id = agent.id;
    return id === void 0 ? "?" : String(id);
  } catch {
    return "?";
  }
}
function idOfSession(session) {
  try {
    const s = session;
    return s.id !== void 0 ? String(s.id) : s.sessionId !== void 0 ? String(s.sessionId) : "?";
  } catch {
    return "?";
  }
}
function sessionDelegationDepth(agent) {
  try {
    const s = agent.session;
    const depth = s?.header?.delegationDepth ?? s?.meta?.delegationDepth;
    return typeof depth === "number" && depth > 0 ? depth : 0;
  } catch {
    return 0;
  }
}
function sessionHeaderPreset(agent) {
  try {
    const s = agent.session;
    const value = s?.header?.agentPreset ?? s?.meta?.agentPreset;
    return typeof value === "string" && value.length > 0 ? value : void 0;
  } catch {
    return void 0;
  }
}
function safeString(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
var index_default = apply;
export {
  apply,
  applyPresetDefinitions,
  index_default as default,
  discoverSkills,
  isSkillName,
  loadSkill,
  name,
  parseSkillSource,
  preparePresetSkills,
  toRegistration
};
//# sourceMappingURL=index.js.map
