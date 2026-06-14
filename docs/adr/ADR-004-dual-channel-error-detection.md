# ADR-004：双通道错误探测策略

> 状态：**已接受**｜日期：2026-06-12

---

## 背景

CC 的错误来自两个层面：
1. **应用层错误**（overloaded、rate_limit）：CC 自身感知并触发 StopFailure hook
2. **连接层错误**（ECONNRESET、socket closed）：发生在 TLS/TCP 层，CC 的 StopFailure hook 可能捕获不到，或捕获到的内容无法区分原因

单一通道无法覆盖所有情况。

## 决策

采用双通道，各司其职：

### 强通道：StopFailure Hook

```
触发条件：CC 正常感知到的应用层错误
Matcher：/overloaded|rate.limit/i
产出：JobFile { event: ApiError | RateLimited, sessionId, pid, resets_at? }
```

### 弱通道：Log Tailer

```
触发条件：连接层错误（hook 未触发或未携带有效信息时）
监听目标：CC debug log（~/.claude/logs/ 或 stderr）
Matcher：/ECONNRESET|socket hang up|connection reset|socket closed|403 Request not allowed|Unable to connect to API|ECONNREFUSED|ConnectionRefused/i
        （2026-06-14 实测扩充：CC 2.1.177 断网/关 VPN 输出 403 Request not allowed、Unable to connect to API (ConnectionRefused)）
产出：JobFile { event: ConnDead, sessionId }
说明：classifyStreamLine 复用 classifyLogLine，故 `jixu run` 流式通道与弱通道共用此 Matcher
```

### 看门狗（Watchdog）

```
触发条件：活跃会话超过 STALL_TIMEOUT（默认 120s）无新 token 输出
产出：内部 Stalled 事件（不经过 job 文件，直接注入决策引擎）
```

### 优先级

同一 session 同一时刻若两个通道都产出事件，以强通道（Hook）为准，弱通道的 job 文件被忽略（通过 timestamp + sessionId 去重）。

## 理由

- 只用 hook：漏掉 ECONNRESET
- 只用 log-tail：无法获得 resets_at 等应用层信息
- 双通道覆盖率最高，成本可控

## 后果

- ClaudeCodeAdapter 需要同时维护 hook 和 log-tailer 两条路径
- capabilities.errorDetect 设为 'strong'（hook 可用时）
- Log tailer 需要知道 CC debug log 的路径（可能因 CC 版本变化而需要更新）
