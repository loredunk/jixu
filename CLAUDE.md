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
| **M2** | log-tailer + OAuth usage API + 完整 Waiter daemon | ⬜ 待开始 |
| **M3** | PTY 模式 + Codex 占位 + npm/plugin 发布配置 | ⬜ 待开始 |

**当前任务（M2）**：log-tailer（tail CC debug log，抓 ECONNRESET）、OAuth usage API（resets_at 来源 #1）、完整 Waiter daemon（start/stop/status/init 守护进程）。

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
│       └── ADR-007-distribution-strategy.md
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
│   │   │   ├── adapter.ts             ← 实现 IToolAdapter（headless resume）
│   │   │   ├── usage-api.ts           ← OAuth usage API（M2）
│   │   │   ├── log-tailer.ts          ← tail CC debug log，抓 ECONNRESET（M2）
│   │   │   └── session.ts             ← session_id 提取
│   │   └── __tests__/
│   │       ├── adapter.test.ts        ← fixture 驱动的错误分类单测
│   │       └── log-tailer.test.ts     ← M2
│   │
│   ├── adapter-codex/                 ← @jixu/adapter-codex（占位，M3）
│   │   └── src/adapter.ts             ← 全部方法 throw NotImplementedError
│   │
│   ├── waiter/                        ← jixu（常驻守护进程，npm 主包）
│   │   ├── src/
│   │   │   ├── main.ts                ← CLI：start / stop / status / init
│   │   │   ├── watcher.ts             ← FSWatch job 文件目录
│   │   │   ├── watchdog.ts            ← N 秒无新 token → Stalled
│   │   │   └── process-mgr.ts         ← PID lock + spawn + kill
│   │   └── __tests__/
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
| CC debug log 的精确路径 | M2 | 需要在真实环境中确认 CC 写 log 的位置 |
| Statusline 缓存文件格式对齐 | M2 | 需要和 statusline 插件约定 JSON schema |
| PTY 库选型（node-pty vs portable-pty）| M3 | 两者都支持 macOS/Linux，portable-pty 更轻量 |
| npm 包名是否已被占用 | M3 | 发布前需确认 `jixu` 和 `@jixu/core` 可用 |
