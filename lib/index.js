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
async function registerPresetSkills(presetId, seam) {
  if (presetId === void 0 || presetId.length === 0) {
    return { presetId: void 0, skillsDir: void 0, state: "no-preset", found: 0, registered: 0, skipped: [] };
  }
  let dir;
  try {
    dir = await seam.resolveSkillsDir(presetId);
  } catch (error) {
    seam.log(`resolve failed preset=${presetId}: ${describe(error)}`);
    return { presetId, skillsDir: void 0, state: "resolve-failed", found: 0, registered: 0, skipped: [] };
  }
  if (dir === void 0) {
    seam.log(`preset not resolvable preset=${presetId}`);
    return { presetId, skillsDir: void 0, state: "resolve-failed", found: 0, registered: 0, skipped: [] };
  }
  let discovered;
  try {
    discovered = await seam.discover(dir);
  } catch (error) {
    seam.log(`discover failed dir=${dir}: ${describe(error)}`);
    return { presetId, skillsDir: dir, state: "discover-failed", found: 0, registered: 0, skipped: [] };
  }
  const skipped = [];
  let registered = 0;
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
    try {
      seam.register(toRegistration(parsed));
      registered += 1;
    } catch (error) {
      skipped.push(`${skill.name}:${describe(error)}`);
    }
  }
  return { presetId, skillsDir: dir, state: "ok", found: discovered.length, registered, skipped };
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
var BUILD = "v4.1";
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
  on("agent/created", ({ agent }) => {
    void handleAgentCreated(ctx, agent, { log, getService });
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
    on("agent-preset/selected", (sessionId, agentPreset) => {
      log(`[preset-skills:ev] agent-preset/selected session=${String(sessionId)} preset=${String(agentPreset)}`);
    });
  }
}
var seenEventTypes = /* @__PURE__ */ new Set();
async function handleAgentCreated(ctx, agent, deps) {
  const { log, getService } = deps;
  const a = agent;
  const id = String(a.id ?? "?");
  try {
    const agentPresets = getService("agentPresets");
    const delegated = sessionDelegationDepth(agent);
    if (delegated > 0) {
      log(`[preset-skills] agent/created build=${BUILD} agent=${id} DELEGATED depth=${delegated} (skip)`);
      return;
    }
    let presetId;
    let presetSource = "none";
    if (agentPresets !== void 0) {
      try {
        presetId = agentPresets.composedPreset(a.ctx);
        if (presetId !== void 0 && presetId.length > 0) presetSource = "composed";
      } catch (error) {
        log(`[preset-skills] composedPreset threw agent=${id}: ${String(error)}`);
      }
    }
    if (presetId === void 0) {
      const headerPreset = sessionHeaderPreset(agent);
      if (headerPreset !== void 0) {
        presetId = headerPreset;
        presetSource = "header";
      }
    }
    const seam = {
      async resolveSkillsDir(preset) {
        if (agentPresets === void 0) return void 0;
        const resolved = await agentPresets.resolve(preset);
        if (resolved === void 0 || resolved.path === void 0) return void 0;
        return join2(dirname2(resolved.path), "skills");
      },
      discover: (dir) => discoverSkills(dir),
      load: (skill) => loadSkill(skill),
      register(registration) {
        const target = registrationTarget(agentPresets, agent);
        if (target === void 0) throw new Error("no skills service reachable from the agent context");
        target.register(registration);
      },
      log
    };
    const result = await registerPresetSkills(presetId, seam);
    if (result.state === "no-preset") {
      log(
        `[preset-skills] agent/created build=${BUILD} agent=${id} preset=<none> agentPresets=${agentPresets === void 0 ? "missing" : "present"} source=${presetSource} delegated=${delegated}`
      );
      return;
    }
    log(
      `[preset-skills] agent/created build=${BUILD} agent=${id} preset=${result.presetId} presetSource=${presetSource} agentPresets=${agentPresets === void 0 ? "missing" : "present"} dir=${result.skillsDir ?? "<none>"} state=${result.state} found=${result.found} registered=${result.registered}${result.skipped.length > 0 ? ` skipped=[${result.skipped.join("|")}]` : ""}`
    );
  } catch (error) {
    log(`[preset-skills] ERROR agent/created agent=${id}: ${String(error)}`);
  }
}
function registrationTarget(agentPresets, agent) {
  const a = agent;
  if (agentPresets !== void 0) {
    try {
      const scoped = agentPresets.serviceFor({ ctx: a.ctx }, "skills");
      if (scoped !== void 0) return scoped;
    } catch {
    }
  }
  try {
    const ctxRead = a.ctx;
    return ctxRead.get?.("skills");
  } catch {
    return void 0;
  }
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
  index_default as default,
  discoverSkills,
  isSkillName,
  loadSkill,
  name,
  parseSkillSource,
  registerPresetSkills,
  toRegistration
};
//# sourceMappingURL=index.js.map
