# ADR-006：死 Socket 必须 Kill 后新进程 Resume

> 状态：**已接受**｜日期：2026-06-12

---

## 背景

当 ECONNRESET 或 socket closed 发生时，Node.js 进程的连接池中对应的 TCP 连接已经死亡。在同一个 CC 进程内部尝试续接，会复用已死的连接池，导致续接请求也立即失败。

## 决策

**ConnDead 和 Stalled 事件必须走 kill → 新进程 resume 路径，不能在原进程内续。**

```
ConnDead / Stalled 决策路径：
  1. adapter.kill(pid)        — SIGTERM，超时后 SIGKILL
  2. 等待进程退出（最多 5s）
  3. adapter.resume('headless', sessionId) — 启动全新进程
```

与之对比，overloaded / rate_limit 可以在进程退出后再起新进程（CC 自己已退出，不需要 kill）。

## 理由

- 新进程会建立新的连接池，获得新的 TCP 连接
- 原地续接在死连接上必然失败，浪费一次重试机会和 guard 计数
- CC 在死连接时通常会自己 hang 住，不会主动退出，必须外部 kill

## 后果

- `process-mgr.ts` 必须实现 kill+等待退出的逻辑，不能只发信号
- 决策引擎中 `ConnDead`/`Stalled` 对应的 action 为 `kill_resume`，与 `backoff_resume` 严格区分
- PTY 模式下同样适用：PTY 进程也需要 kill 后重新 spawn

## 修订（2026-06-14）：`jixu run` 先试探、再 kill

> 状态：**已接受**（补充本 ADR，不推翻原则）

**背景（实测）**：Claude Code 2.1.177 遇到网络层错误（`403 Request not allowed`、
`Unable to connect to API (ConnectionRefused)`）时**不退出、仍停在提示符**，连接池在下一次
请求时会自行重建。此时直接 kill 重开偏重，且丢掉了当前存活会话。

**决策**：仅在 **`jixu run` 前台托管**、且事件为**流式探测到的 `ConnDead`** 时，引入一次
**同会话试探**作为 `kill_resume` 的前置快速路径：

```
检测到 ConnDead（进程仍存活）
  → 向当前会话补发一次「继续」+回车（试探）
  → 观察窗口 probeEscalateMs（默认 8s，env JIXU_PROBE_ESCALATE_MS）：
      · 窗口内未再报错  → 判定恢复，继续原会话（不 kill）
      · 窗口内再次报错  → 升级：按本 ADR kill 原进程 → 新进程 --resume
  · 试探后会话纯静默无输出 → 由停滞看门狗（Stalled）兜底 kill
```

**为何"窗口内无报错=恢复"而非"超时即 kill"**：注入「继续」后 PTY 会回显该串，无法可靠地把
"回显"与"真实恢复输出"区分开，故不以"出现干净输出"作正向恢复信号；改以**是否再次报错**作判据
——网络仍断时 CC 会立即再报错从而快速升级，网络已恢复时则平稳续跑。极端的"试探后彻底卡死"
由独立的停滞看门狗收口。

**边界**：本试探**只作用于 `jixu run`**（交互、进程存活才能补发按键）。
daemon/headless 路径、以及升级后的重开，仍严格遵守本 ADR 的 kill+respawn 不变量。
`continuePrompt` 为空串则禁用试探，`ConnDead` 直接走 kill+respawn。
