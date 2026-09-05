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

Marker 主行示例（`build` 戳用于区分旧 build/残留进程）：

```
[preset-skills] agent/created build=v4.1 agent=session-… preset=teacher presetSource=composed
                agentPresets=present dir=C:\Users\fuqia\.dsh\.agent-presets\teacher\skills
                state=ok found=5 registered=5
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

分发铁律：`lib/`（构建产物）**随 git 提交**，`package.json` 无 `prepare` 脚本 → 任何机器 git 安装零 allowBuilds。

## 验证（2026-09-05 真机，dsh web）

新建会话（web UI 实测）marker 证据：

- research 会话：`agent/created … preset=research … found=20 registered=20`
- teacher 会话：`agent/created … preset=teacher … found=5 registered=5`
- standard（shipped，无 skills 目录）：`found=0 registered=0`（优雅空转）

模型可见 `<available_skills>` 目录（解压会话 `session.jsonl.zstd` 取证）：

- research 会话：research 20 项 + 全局技能；**无 teacher 项**。
- teacher 会话：teacher 5 项（chaoxing-suite、lesson-plan-generator、ppt-master、programmatic-excel-generation、teaching-ppt-pipeline）+ 全局技能；**research 泄漏为空**。

旧机制已移除：三预设（research/teacher/developer）的 `agent.cordis.yml` 不再含 `preset-skills`/`./preset-skills/index.mjs` 行（grep 计数 0），其 `preset-skills/` 目录已不存在；新机制独立成立。

## 已知边界

- **只在“新会话/创建即预设”时注册**：dsh 允许在空白会话内动态切预设（`agent-preset/selected` → recompose），但 recompose **不会**重新触发 `agent/created`，因此已创建的 agent 不会为新预设补注册、也不会移除已注册的旧预设技能（实测：research 会话空白期切到 teacher 后仍只见 research 技能）。成功场景请始终“新建会话时选定预设”。若需要支持动态切换，后续可在 `session/event` firehose 筛 `agent-preset/selected` 后重注册（含清理策略）。
- 子代理（delegation depth > 0）跳过注册（避免高频读盘）；子代理看不到父 agent 的 agentKey 层技能（如需请走 standing 层或另行扩展）。
- marker 日志随每事件追加；`config.debug: true` 会额外记录候选事件探针（噪音较大），排查用。

## 环境锚点

- 工作区：D:\Coding\DSH-Plugin\dsh-preset-skills
- dsh 源码：D:\Apps\deepseek-harness（未改动）
- DSH_HOME：C:\Users\fuqia\.dsh；user 预设根 `.agent-presets\`：teacher=5、developer=2、research=20
- profile：C:\Users\fuqia\.dsh\profiles\web（bundles 含 dsh-preset-skills）
- git origin：git@gitcode.com:foqiang/dsh-preset-skills.git（SSH）
