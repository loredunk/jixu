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
