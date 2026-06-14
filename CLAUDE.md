# CLAUDE.md — jixu 项目导航

> **新会话必读**：先读完本文件，再看对应里程碑的 ADR，然后开始工作。

---

## 项目简介

**jixu（继续）** —— Claude Code 会话在 API / 网络 / 限额中断后自动续上的守护工具。  
背景：国内网络不稳定，CC 长任务频繁因 ECONNRESET / 速率限制 / 过载中断，需手动 resume。

---

## 当前状态速览

| 里程碑 | 内容摘要 | 状态 |
|--------|----------|------|
| **M1** | 契约类型 + 决策核心(TDD) + CC 适配器(headless) + hook 脚本 + demo | ✅ **完成** |
| **M2** | log-tailer + OAuth usage API + 完整 Waiter daemon | ✅ **完成** |
| **M3** | PTY 交互式续接（jixu run）+ Codex 占位 + npm/plugin 发布配置 | ✅ **完成** |
| **Codex** | CodexAdapter 真正落地（classifier/usage/rollout-tailer/pty/session）+ ToolProfile 工具选择（`jixu run`/守护 `--tool codex`） | ✅ **完成** |

**当前状态**：三个里程碑 + Codex 接入均完成。`npm run build` / `npm test` 均通过（**226 个单测**）。

下一步候选（无既定里程碑）：真实环境验证（CC hook/log/usage API 字段；**Codex 的 `exec --json` 事件、`rate_limits` 快照、rollout 记录嵌套字段**）、弱通道 log↔session 精确归因、首次 npm 发布（确认包名可用）。

> M3 核心是 **`jixu run`**：用 PTY 在你当前终端里托管 Claude Code / Codex，中断时在同一窗口自动续接（见 ADR-002 的 forceContinue + PRD F6）。Codex 接入决策见 **ADR-008**。

---

## 目录结构

```
jixu/
├── CLAUDE.md                          ← 你在这里（项目导航，新会话必读）
├── README.md                          ← 用户文档
├── package.json                       ← monorepo root (npm workspaces)
├── tsconfig.base.json
│
├── docs/
│   ├── prd.md                         ← 产品需求（问题、目标、里程碑、成功指标）
│   └── adr/
│       ├── ADR-001-monorepo-and-tech-stack.md
│       ├── ADR-002-three-layer-architecture.md
│       ├── ADR-003-hook-only-writes-job-file.md
│       ├── ADR-004-dual-channel-error-detection.md
│       ├── ADR-005-resets-at-sources.md
│       ├── ADR-006-dead-socket-must-kill-and-respawn.md
│       ├── ADR-007-distribution-strategy.md
│       └── ADR-008-codex-adapter.md    ← Codex 落地 + ToolProfile 工具选择
│
├── packages/
│   ├── core/                          ← @jixu/core（归一化契约 + 决策核心）
│   │   ├── src/
│   │   │   ├── types.ts               ← 所有 TS 接口（JixuEvent、IToolAdapter、JobFile…）
│   │   │   ├── engine.ts              ← 决策状态机，纯函数，无副作用
│   │   │   ├── backoff.ts             ← 退避 + jitter 计算
│   │   │   └── guard.ts               ← 循环 guard 计数器（按 sessionId）
│   │   └── __tests__/
│   │       ├── engine.test.ts
│   │       ├── backoff.test.ts
│   │       └── guard.test.ts
│   │
│   ├── adapter-claude/                ← @jixu/adapter-claude（CC 适配器）
│   │   ├── src/
│   │   │   ├── adapter.ts             ← 实现 IToolAdapter（headless + pty resume + usage）
│   │   │   ├── classifier.ts          ← hook payload / 日志行 / 流式输出 → JixuEvent 分类
│   │   │   ├── usage-api.ts           ← OAuth usage API + statusline 缓存兜底（resets_at）
│   │   │   ├── log-tailer.ts          ← tail CC debug log，抓 ECONNRESET（弱通道）
│   │   │   ├── pty.ts                 ← PtySpawner 抽象 + node-pty（惰性）+ claude 启动参数
│   │   │   └── session.ts             ← session_id 提取
│   │   └── __tests__/
│   │       ├── classifier.test.ts     ← fixture 驱动的错误分类单测
│   │       ├── usage-api.test.ts      ← resets_at 三级来源解析
│   │       ├── log-tailer.test.ts     ← 行扫描器 + tail 集成
│   │       └── pty.test.ts            ← 启动参数 + 流式分类 + resume('pty')（mock spawner）
│   │
│   ├── adapter-codex/                 ← @jixu/adapter-codex（OpenAI codex CLI，已落地）
│   │   ├── src/
│   │   │   ├── adapter.ts             ← 实现 IToolAdapter（weak/true/true；headless+pty resume+usage）
│   │   │   ├── classifier.ts          ← exec --json 事件 / rollout 行 / 流式输出 → JixuEvent
│   │   │   ├── usage.ts               ← 从 rollout 的 rate_limits 事件换算 resets_at
│   │   │   ├── rollout-tailer.ts      ← tail ~/.codex/sessions 的 rollout jsonl（弱通道）
│   │   │   ├── pty.ts                 ← PtySpawner + codex 启动参数（resume <id>|--last）
│   │   │   ├── session.ts             ← 从 rollout 文件名/SessionMeta 提取 session id
│   │   │   └── paths.ts               ← CODEX_HOME / sessions 目录 / 最新 rollout
│   │   └── __tests__/                 ← classifier / usage / rollout-tailer / pty / session / adapter
│   │
│   ├── waiter/                        ← jixu（常驻守护进程，npm 主包）
│   │   ├── src/
│   │   │   ├── main.ts                ← CLI：run / start / stop / status / init（+ __daemon）；解析 --tool
│   │   │   ├── tools.ts               ← ToolProfile：claude/codex 工具选择收口（adapter/分类器/参数/tailer）
│   │   │   ├── supervisor.ts          ← jixu run 前台托管循环（PTY 起 CC/Codex + 流监控 + 自动续接 + 停滞看门狗 + 注入「继续」）
│   │   │   ├── daemon.ts              ← 编排 watcher+tailer+watchdog → 引擎 → executor（按 profile 选适配器/弱通道）
│   │   │   ├── watcher.ts             ← FSWatch job 目录 + 归一化 + 去重
│   │   │   ├── watchdog.ts            ← N 秒无新活跃 → Stalled
│   │   │   ├── process-mgr.ts         ← PID lock + kill+wait + detached spawn
│   │   │   ├── executor.ts            ← Decision → adapter 调用（sleep/kill_resume/…）
│   │   │   ├── init.ts                ← 安装 hook plugin 到 ~/.claude/plugins/jixu
│   │   │   ├── paths.ts               ← XDG 路径集中
│   │   │   ├── state.ts               ← waiter.state.json 读写（供 status）
│   │   │   └── log.ts                 ← 追加式 waiter.log
│   │   ├── scripts/bundle-plugin.mjs  ← prepack 时把 hook-scripts 复制进 plugin/（发布用）
│   │   └── __tests__/                 ← process-mgr / watchdog / watcher / executor /
│   │                                     daemon / init / supervisor 单测 + helpers
│   │
│   └── hook-scripts/                  ← CC Plugin（hook 脚本）
│       ├── manifest.json
│       ├── hooks.json                 ← 用 ${CLAUDE_PLUGIN_ROOT} 引用脚本
│       └── stop-failure.sh            ← 只写 job 文件，立即返回 {}
│
└── demo/
    └── simulate.ts                    ← 模拟 rate_limit job → 3s 后 headless resume
```

---

## 核心架构原则（ADR 摘要）

读完下面几条，再去对应 ADR 看细节：

1. **三层解耦**（ADR-002）：core 契约 → adapter 翻译 → waiter 决策。上层只依赖接口，不碰实现细节。
2. **Hook 只写文件**（ADR-003）：StopFailure hook 绝不 sleep，写完 job 文件立即 `echo {}` 退出。等待在 Waiter。
3. **死连接必须 kill+respawn**（ADR-006）：ConnDead / Stalled 不能原地续，必须 kill 进程后起新进程。
4. **FATAL 不续**：auth_failed / billing_failed / context_too_long / invalid_request → stop，通知用户。
5. **Guard 计数**：同一 session 连续自动续超过 3 次 → 停手通知；成功一回合（TurnEnded）清零。

---

## 关键数据流

```
CC 会话中断
    │
    ├─[应用层错误]─→ StopFailure hook → 写 JobFile → ~/.local/share/jixu/jobs/<sid>.job.json
    │                                                           │
    └─[连接层错误]─→ log-tailer 匹配 ECONNRESET ──────────────┘
                                                               │
                                               Waiter FSWatch 触发
                                                               │
                                              engine.decide(event, guardState)
                                                               │
                          ┌────────────────────────────────────┤
                          │                                    │
                    RateLimited                          ConnDead/Stalled
                    sleep(resets_at+buffer)              kill(pid) → resume(new process)
                          │                                    │
                    resume('headless', sid)             resume('headless', sid)
```

---

## 开发约定

- **TDD**：决策引擎（engine / backoff / guard）先写测试，再写实现
- **fixture 驱动**：adapter 错误分类测试用 `__tests__/fixtures/` 目录放真实日志片段
- **无副作用**：`engine.ts` 是纯函数，不引用任何 Node.js API
- **显式处理边界**：不要假装 FATAL 错误可重试；不要假装 socket 死了还能原地续
- **注释原则**：只在 WHY 非显而易见时写注释，不写 WHAT

---

## 常用命令

```bash
npm install          # 安装所有 workspace 依赖
npm test             # 运行全部单测
npm run demo         # 运行 demo（模拟 rate_limit → 自动续）
npm run build        # 编译所有包
```

---

## 各里程碑详细需求

→ 见 `docs/prd.md` 第六节  
→ 技术决策见 `docs/adr/` 各 ADR

---

## Pending 决策（待后续会话处理）

| 问题 | 关联里程碑 | 说明 |
|------|-----------|------|
| CC debug log 的精确路径 | M2→M3 | 已实现：默认 `~/.claude/logs` 取最新 `*.log`，可经 `DaemonOptions.logDir` 覆盖；真实路径与日志→session 归因仍需在真实环境确认 |
| Statusline 缓存文件格式对齐 | M2→M3 | 已约定 jixu 端 schema：`~/.local/share/jixu/cache/rate_limits.json`，含 `timestamp`(ms) + `rate_limits.five_hour.resets_at`，30 分钟内有效；待与 statusline 插件落地对齐 |
| 弱通道 ConnDead 的 session 归因 | 后续 | Claude daemon 弱通道归因到「最近活跃 session」（启发式）；Codex 弱通道可从 rollout 文件名定位 session（`ToolProfile.sessionIdForLog`）。注：`jixu run` 因自管会话/`--last`，归因是确定的 |
| **Codex 真实字段校验** | Codex ✅→后续 | exec `--json` 事件名、`rate_limits` 快照（primary/secondary、resets_in_seconds）、rollout 记录嵌套均按公开行为**推断**，已防御式编码；需在真实 codex 环境核对后收敛正则/字段（见 ADR-008 后果） |
| PTY 库选型 | M3 ✅ | 选定 **node-pty**（PRD F6 指定）；作为 adapter-claude/adapter-codex 的 optionalDependency 惰性加载，缺失只在 `jixu run` 时报错 |
| npm 包名是否已被占用 | 发布前 | 发布配置（files/publishConfig/prepack 打包 plugin/）已就绪；实际发布与确认 `jixu`/`@jixu/*` 占名待执行 |
