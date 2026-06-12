# PRD — jixu（继续）

> 状态：**草稿**｜最后更新：2026-06-12

---

## 一、问题陈述

国内网络环境下，Claude Code 长会话频繁因以下原因中断，需要用户手动重新执行 `claude --resume`：

| 中断类型 | 触发条件 | 频率 |
|----------|----------|------|
| 速率限制 | 五小时窗口或七天窗口用尽 | 极高 |
| 连接中断 | ECONNRESET / socket closed | 高 |
| 服务过载 | API 返回 overloaded | 中 |
| 会话停滞 | N 秒无新 token 输出 | 中 |

用户痛点：深夜跑长任务时会话中断，早晨发现进度丢失，无法确定重续时机。

---

## 二、目标

### 核心目标
- 自动检测上述四类中断事件
- 在合适时机（速率限制解除后、网络恢复后）自动执行 headless resume
- 循环保护：避免无限重试导致账户异常

### 非目标（当前版本）
- 不做内容感知（不判断任务是否真正完成）
- 不跨机器同步会话状态
- 不支持多账户切换
- Codex 适配器本期只留接口占位，不实现

---

## 三、用户故事

**主要用户**：独立开发者，使用 Claude Code 跑长时间编码/分析任务，网络环境不稳定（国内）。

```
作为 Claude Code 用户，
当我的会话因速率限制中断时，
我希望 jixu 自动等到限额重置后续上，
这样我不需要盯着屏幕等。

作为 Claude Code 用户，
当网络突然断开导致会话死掉时，
我希望 jixu 能立刻 kill 并拉起新进程续上，
这样任务不会因为网络抖动永久停止。

作为 Claude Code 用户，
当 jixu 连续自动续 3 次仍然失败时，
我希望收到通知而不是无限循环，
这样我可以手动介入检查问题。
```

---

## 四、功能需求

### F1 — 错误检测（双通道）
- **强通道**：通过 CC StopFailure hook 捕获 overloaded / rate_limit 类错误
- **弱通道**：tail CC debug log，捕获 ECONNRESET / socket closed 等连接层错误
- **看门狗**：活跃会话 N 秒（默认 120s）无新 token 输出 → 触发 Stalled 事件

### F2 — 自动续接
- **RateLimited**：获取 resets_at，sleep 到重置时刻 + buffer，然后 headless resume
- **ConnDead / Stalled**：立即 kill 原进程，启动新进程 headless resume
- **Overloaded**：指数退避后 headless resume
- **FATAL 错误**（auth / billing / context_too_long / invalid_request）：不续，通知用户

### F3 — 循环保护
- 按 session_id 计连续自动续次数，超过 MAX_RETRIES（默认 3）停手通知
- 成功完成一个完整回合（TurnEnded）后计数清零
- 退避时间带 jitter（±30%），有 retry-after header 时优先使用

### F4 — resets_at 获取
- **优先**：OAuth usage API（`GET /api/oauth/usage`，需 accessToken）
- **备选**：statusline 输入 JSON 缓存（`rate_limits.five_hour.resets_at`）

### F5 — 守护进程管理
- `jixu start` — 启动守护进程（后台 detached）
- `jixu stop` — 停止守护进程
- `jixu status` — 查看当前状态（监听中的 session / 计数器）
- `jixu init` — 安装 CC hook（写入 hooks.json，不修改 settings.json）
- PID 文件 + lock 防止重复启动

### F6 — PTY 交互式续（可选，M3）
- 当检测到任务需要用户输入时，用 node-pty 以交互模式 resume
- 仅在 waiter 自己 spawn 的进程上启用，不注入外部终端

---

## 五、非功能需求

| 指标 | 要求 |
|------|------|
| 续接延迟 | ConnDead/Stalled 续接 < 5s |
| 内存占用 | Waiter 常驻 < 50MB |
| 日志 | 所有决策写入 ~/.local/share/jixu/waiter.log |
| 分发 | npm install -g jixu；hook 走 CC plugin |
| 平台 | macOS / Linux（Windows 暂不支持 PTY 模式）|

---

## 六、里程碑

| 里程碑 | 内容 | 状态 |
|--------|------|------|
| **M1** | 契约类型 + 决策核心(TDD) + ClaudeCodeAdapter(headless) + hook 脚本 + demo | ✅ **完成** |
| **M2** | log-tailer + OAuth usage API + 完整 Waiter daemon（start/stop/status/init）| ⬜ 待开始 |
| **M3** | PTY 模式 + CodexAdapter 占位 + npm/plugin 发布配置 | ⬜ 待开始 |

---

## 七、成功指标

- M1 完成：demo 脚本能模拟 rate_limit job → 3s 后触发 headless resume，单测全绿
- M2 完成：在真实网络中断场景下，waiter 能自动续接，日志可查
- M3 完成：`npx jixu init` + `npx jixu start` 完整流程可用，第三方可复用 @jixu/core 接入新工具
