# dsh-preset-skills

把每个 agent 预设（agent preset）自己 `skills/` 目录里的技能注册为**可发现、按预设严格隔离**的技能。

- 不泄漏：research 会话只见 research 的技能，teacher 会话只见 teacher 的，兄弟预设互不可见。
- 不动 dsh 源码树：纯 out-of-tree profile bundle 插件。
- 确定性证据：`<DSH_HOME>/dsh-preset-skills.log`（append-only marker）逐事件记录注册来源、目录与计数。

## 机制（v4，bundle 事件驱动）

单个 host 平面插件（profile bundle 行 `name: dsh-preset-skills`），挂 `agent/created` 生命周期事件：

1. agent 工厂在 **setup 阶段先装配预设**（web 新建会话与 resume 都是：`presets.mount(agentCtx, preset)` 在 agent 发布前完成），发布序列随后触发 `agent/created`。host（无 scope tag）监听者被 dsh-scope 的 carrier filter 放行，所以 host 平面能可靠收到该事件。
2. 回调内**惰性**解析服务（`ctx.get('agentPresets')`，绝不在 apply 时缓存）→ `composedPreset(agent.ctx)` 拿预设 id → `agentPresets.resolve(id).path` 推出技能目录 `dirname(path)/skills`（同时覆盖 user 根 `~/.dsh/.agent-presets/<id>` 与 shipped 根 `packages/preset/agent-presets/presets/<id>`）。
3. 发现/解析复用 `parse.ts`（目录束 `<name>/SKILL.md` 与扁平 `<name>.md`，frontmatter 至少 name+description）。
4. **经 agent 自己的 scoped ctx 拿到 skills 服务再注册**：Cordis `getTraceable` 会把 service 方法调用 `this` 重定向到访问方 ctx，`SkillRegistry.register()` 据此把注册落进**该 agent 的 scope 层**（`[agentKey → presetStandingKey → …]`）。因此：
   - 该会话自己的 `/` 目录与模型可见目录（scope 链含 agentKey 层）能看到；
   - 兄弟预设永远看不到（standing 键不相交）；
   - 注册 effect 归 agent scope fiber 所有，agent 释放自动回收，无手动清理。
   - 若某预设的 standing 组合自己发布了 `skills` 服务，则优先走 `agentPresets.serviceFor(...)`（落 standing 层，同预设所有会话共享）；否则回退 agent ctx 通道。
5. **v4.2 空白会话动态切预设**：dsh 的预设切换（`agent-presets select`→`swap`）在空白会话上把 agent scope 重链到新预设 standing，但**不会重触发 agent/created**。插件新增生产监听 `agent-preset/selected`（该事件在 recompose 提交后才由 agent-presets 发出），取出 live agent 后做**收敛式同步**：先只读 prepare 新预设技能 → 释放旧注册集的 disposers → 应用新注册集。所有 per-agent 工作走同一条串行队列，与 `agent/created` 注册不交错。语义与 dsh recompose 一致：换绑即换视角，旧预设技能立即清出该会话。
6. **v4.3 启动 roster 预热（缓解，非根治）**：见下「启动竞态」。

## 启动竞态（v4.3 缓解 → 根本修复归属 dsh）

**症状**：dsh 刚启动进入默认预设时，`<available_skills>` 里没有预设目录里自定义的技能；**切一次预设后才正常**。

**根因（诊断 2026-09-06，D:\Apps\deepseek-harness）**：不是本插件没注册——marker 日志证明 `agent/created … registered=20` 每次都成功。真正的问题在 **dsh web UI 侧（`ui-skill` browser half）的 per-session 技能目录缓存**：

- UI 的 scope-birth `warm()` 在会话诞生瞬间就发 `skills/list` RPC 并缓存 settled 快照（`ui-skill/src/client/index.ts`），只在该会话 **切预设（`agent-preset/selected`）或断线重连（connection/reset）** 时失效。
- 冷启动时，本插件的首个子代理注册要走 **第一次 `agentPresets.resolve` → 全 roster discovery**（逐个 health-check 每个预设组合，冷启动约 5s）。期间 UI 已缓存「注册前」的空快照。
- host 侧 `SkillRegistry` 注册完成会有 `skills/change` 事件，且 UI 能订阅**恰恰漏了**——dsh 把转发到浏览器的 host 事件放在白名单 `API_REMOTE_FORWARDED_EVENTS`（`packages/api/remotes/src/remote-events.ts`）里，那里**有** `commands/change`（ui-commands 订阅它目录才不陈旧）但**没有** `skills/change`，所以 UI 根本收不到「技能已注册」。

**v4.3 缓解**：apply 后立刻用**一次** `agentPresets.list()` 填满 `dirCache`（所有预设的 skills 目录已解析好），首个 `agent/created` 注册从 ~5s 降到毫秒级，在常见冷启动下抢在 UI prewarm 前完成。严格 best-effort：roster 未就绪会短暂重试后放弃，回退到慢但正确的 resolve 路径。

**真根治（归属 dsh 核心，未在本仓库做）**：在 `API_REMOTE_FORWARDED_EVENTS` 增加 `skills/change`，并让 `ui-skill` 订阅 `ctx.remote.$on('skills/change', clearAll)`——与 `ui-commands` 对 `commands/change` 的处理完全对称。这样任何技能注册完成，UI 目录缓存立即失效重拉，不再依赖切预设。

Marker 主行示例（`build` 戳用于区分旧 build/残留进程）：

```
[preset-skills] agent/created build=v4.2 agent=session-… preset=teacher presetSource=composed
                agentPresets=present dir=C:\Users\fuqia\.dsh\.agent-presets\teacher\skills
                state=ok found=5 registered=5
[preset-skills] sync build=v4.2 agent=session-… source=selected from=research to=teacher
                dir=C:\Users\fuqia\.dsh\.agent-presets\teacher\skills state=ok found=5 disposed=20 registered=5
```

## 构建 / 测试 / 部署

```bash
node build.mjs                    # esbuild 打包 src → lib/index.js（需要 danger-full-access；yaml 保持 external）
npm run test                      # node --test tests/*.test.mjs（真实 preset 目录 + mock 注册 sink）
node smoke-parse.mjs              # 解析层自检（research/teacher/developer 计数）
```

dev 类型检查（本机，指向 harness 的 TS + @types/node）：

```bash
node "D:/Apps/deepseek-harness/node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc" -p tsconfig.typecheck.json
```

bundle 接线（已在 profile）：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组含 `dsh-preset-skills`；dsh 启动时按包的 `dsh.bundle.patch` → `cordis.patch.yml` 把行 `name: dsh-preset-skills`（裸包名，解析到包 main 的 `apply(ctx, config)`）插进组合树。改代码后：

```bash
# 1) 仓库内构建，2) 同步到 profile 安装位（git 依赖拷贝，不重跑 pnpm update 也行）
cp lib/index.js lib/index.js.map lib/index.d.ts cordis.patch.yml \
   ~/.dsh/profiles/web/node_modules/dsh-preset-skills/lib/
# 3) 重启 dsh web 生效；可用 --dump-config 确认组合树里有 preset-skills 行
```

> **文件锁提示（Windows）**：dsh web 运行时会锁定 profile 里 `dsh-preset-skills/lib/index.js`，直接覆盖报 `Access denied`。顺序必须是**先停 dsh web → 再覆盖 → 再启动**。PowerShell 一键：
>
> ```powershell
> # 先手动停止运行中的 dsh web（监听 :3080 的进程），再执行：
> Copy-Item lib\index.js, lib\index.js.map, lib\index.d.ts `
>   -Destination "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-preset-skills\lib" -Force
> # 然后重启 dsh web，看 marker：apply build=v4.3.0 + roster prewarm rows=N dirs=M
> ```

分发铁律：`lib/`（构建产物）**随 git 提交**，`package.json` 无 `prepare` 脚本 → 任何机器 git 安装零 allowBuilds。**`lib/index.js.map` 不被 git 跟踪**（`git status` 不会显示它），但它参与 esbuild sourcemap 定位，覆盖部署时仍一并拷到 profile 保持一致。

## 验证（2026-09-05 真机，dsh web）

新建会话（web UI 实测）marker 证据：

- research 会话：`agent/created … preset=research … found=20 registered=20`
- teacher 会话：`agent/created … preset=teacher … found=5 registered=5`
- standard（shipped，无 skills 目录）：`found=0 registered=0`（优雅空转）

模型可见 `<available_skills>` 目录（解压会话 `session.jsonl.zstd` 取证）：

- research 会话：research 20 项 + 全局技能；**无 teacher 项**。
- teacher 会话：teacher 5 项（chaoxing-suite、lesson-plan-generator、ppt-master、programmatic-excel-generation、teaching-ppt-pipeline）+ 全局技能；**research 泄漏为空**。

旧机制已移除：三预设（research/teacher/developer）的 `agent.cordis.yml` 不再含 `preset-skills`/`./preset-skills/index.mjs` 行（grep 计数 0），其 `preset-skills/` 目录已不存在；新机制独立成立。

**v4.2 动态切预设真机验证（dsh web，2026-09-05）**：新建 research 会话（marker：`sync source=created … to=research … registered=20`）→ 空白态切 teacher → 发 hi，marker：`sync build=v4.2 … source=selected from=research to=teacher … disposed=20 registered=5`；模型可见 `<available_skills>` = teacher 5 项 + 全局，research 泄漏为空。对比 v4.1 同场景（遗留旧预设、新预设缺失）已修复。

## 已知边界

- **动态切预设（v4.2 已支持，限空白会话）**：dsh 只允许在从未跑过模型回合的空白会话里切预设（`turnBoundary` 守卫）。切换后插件立即把该会话的注册收敛到新预设（释放旧集、应用新集）。已开始过对话的会话其预设被 dsh 锁定，无需也无法切换。若未来 dsh 允许会话中途换预设，需要新的收敛语义（含历史一致性设计）。
- 子代理（delegation depth > 0）跳过注册（避免高频读盘）；子代理看不到父 agent 的 agentKey 层技能（如需请走 standing 层或另行扩展）。
- **启动首次会话的 UI 目录缓存竞态（v4.3 缓解，未根治）**：dsh web 的 ui-skill 缓存每会话技能目录，只在切预设/断线时才失效，且 `skills/change` 不在 dsh 转发白名单 → UI 收不到「技能已注册」。v4.3 用一次 roster 预填把注册压到毫秒级，让注册抢在 UI prewarm 前；但理论上仍可能输掉极窄的竞态窗口。彻底修复需改 dsh 核心（白名单加 `skills/change` + ui-skill 订阅），见上文「启动竞态」。
- marker 日志随每事件追加；`config.debug: true` 会额外记录候选事件探针（噪音较大），排查用。

## 环境锚点

- 工作区：D:\Coding\DSH-Plugin\dsh-preset-skills
- dsh 源码：D:\Apps\deepseek-harness（未改动）
- DSH_HOME：C:\Users\fuqia\.dsh；user 预设根 `.agent-presets\`：teacher=5、developer=2、research=20
- profile：C:\Users\fuqia\.dsh\profiles\web（bundles 含 dsh-preset-skills）
- git origin：git@gitcode.com:foqiang/dsh-preset-skills.git（SSH）
