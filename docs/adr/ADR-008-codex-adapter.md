# ADR-008：Codex 适配器落地与 ToolProfile 工具选择

> 状态：**已接受**｜日期：2026-06-14

---

## 背景

ADR-002 预留了 `CodexAdapter` 接口占位（throw NotImplemented），用以证明三层架构可扩展。
现在把它真正实现，并让 `jixu run` / 守护进程可以在 Claude 与 Codex 之间选择，
端到端托管 OpenAI 的 `codex` CLI。

Codex 与 Claude Code 在三处结构性不同，决定了实现不是照抄 adapter-claude：

| 维度 | Claude Code | Codex CLI |
|------|-------------|-----------|
| 强通道 | StopFailure hook（应用层错误结构化上报） | **无等价 hook** |
| session id | `--session-id <uuid>` 可**预设** | **不可预设**，启动后自动生成 |
| resets_at | OAuth `GET /api/oauth/usage` HTTP API | **内联**在会话流的 `rate_limits` 事件 |
| 续接 | `claude --resume <sid>` | `codex resume <sid>` / `codex exec resume <sid>` |
| 会话日志 | `~/.claude/logs/*.log`（纯文本） | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |

## 决策

### 1. 能力位：`weak / true / true`

```typescript
capabilities = { errorDetect: 'weak', resetTime: true, forceContinue: true }
```

- **errorDetect `weak`**：Codex 没有 StopFailure hook，后台探测只能 tail rollout jsonl
  或解析输出流（无强通道的结构化保证）。`jixu run` 仍能逐行分类输出，但能力位按
  最弱通道（后台）如实标注。
- **resetTime `true`**：Codex 把用量/重置内联在 `rate_limits` 事件
  （`primary`=5 小时、`secondary`=每周，各含 `resets_in_seconds` 相对秒数）。
  `usage()` 读最新 rollout 的最后一条 `rate_limits`，用记录时间戳 + 相对秒数换算
  成绝对 `resets_at`。**不存在** Claude 那样独立的用量 HTTP API。
- **forceContinue `true`**：`codex resume` 支持 PTY 交互式续接。

### 2. session id 不可预设 → 续接靠真实 id 或 `--last`

`buildCodexArgs` 对续接给出两种目标：

- 有真实 id（守护进程从 rollout 文件名/SessionMeta 提取）→ `codex resume <id>` /
  `codex exec resume <id>`
- 无真实 id（`jixu run` 自管的 sessionId 只是 guard 计数标签，对 Codex 无意义）→
  `codex resume --last`（最近会话）。supervisor 在单一 cwd 里托管单个会话，
  `--last` 的归因是确定的。

### 3. 弱通道 = tail 最新 rollout jsonl，归因用文件名

`RolloutTailer` 复刻 `LogTailer` 的字节级 tail，但用 `classifyRolloutLine`（JSON 感知）。
Codex 的 rollout 文件名含 uuid，故弱通道命中错误时**可确定归因**到该 session
（优于 Claude 弱通道「最近活跃 session」的启发式）——通过 `ToolProfile.sessionIdForLog` 暴露。

### 4. ToolProfile：把工具差异收口，不动 core

新增 `packages/waiter/src/tools.ts`：一个 `ToolProfile` 把「某工具相关的一切」
（adapter 工厂、流式分类器、bin、启动参数、弱通道目录/tailer、session 归因）收口。
`supervisor` / `daemon` / `main` 只依赖 `ToolProfile`，`--tool claude|codex` 切换 profile。
`@jixu/core` 契约**零改动**，再次验证 ADR-002 的可扩展性。

## 理由

- 能力位如实反映 Codex 真实形态，决策引擎据此优雅降级（见 ADR-002）。
- 适配器自包含：adapter-codex 不依赖 adapter-claude（PTY 抽象、line-scanner 各自一份）。
- 工具选择集中在 waiter 的一个文件，新增第三个工具仍只需加一个 profile。

## 后果

- Codex 的 `exec --json` 事件名与 rollout 记录嵌套仍按公开行为**推断**，解析处处防御式
  （`rate_limits` 快照字段已联网查证证实，见下）；真实环境抓样后再收敛剩余字段名。
- **连接层分类改为两档 + 状态码优先（已联网查证 codex 真实 issue 输出后定型）**：
  - 经查证（issue #2612 / #2896 / #9148 / #19121 / #23304），codex 把多种 HTTP 状态码
    **包装**成 `⚠ stream error: exceeded retry limit, last status: <code> ...; retrying N/5 in …` 与
    `Stream disconnected before completion: <api message> ... request ID …`，**用户/rollout 通常看不到
    裸 reqwest/hyper 串**。
  - 因此旧的「`stream error` 一律 ConnDead」是错误的：会把 `last status: 429`(限流)、
    `401`(鉴权 FATAL)、`400`(无效请求 FATAL) 全吞成可重试连接错误——**401 尤其危险，本应停手通知
    却被反复 kill+重启**。
  - 现拆为 `HARD_CONN_RE`（无歧义硬连接错误，**优先** ConnDead）+ 应用层状态码语义判定
    （429/401/400/5xx）+ `SOFT_CONN_RE`（`stream error|exceeded retry limit`，**兜底** ConnDead，
    仅当无可识别 HTTP 语义时如纯 `stream disconnected before completion`）。
  - `HARD_CONN_RE` 在对齐 Claude 之外，**额外**覆盖中国网络高发失败面：DNS 污染
    （`dns error`/`failed to lookup address`/`ENOTFOUND`）、TLS 握手被 GFW 干扰
    （`tls handshake`/`received fatal alert`/`certificate verify failed`）、连接重置与路由黑洞
    （`os error 104/110/111/101/113`、`network is unreachable`、`no route to host`）、reqwest 顶层
    （`error sending request`/`connection closed before message completed`）、超时
    （`operation timed out`/`request timed out`）。**这一档是防御式推断**：codex 通常把底层错误
    包装掉，这些裸串主要为「rollout 偶尔暴露底层 / 第三方 OpenAI 兼容端点」场景兜底，命中即 ConnDead
    无误判风险（不出现在正常输出里）。
- **`rate_limits` 快照字段已查证证实**：`primary`/`secondary`，各含 `used_percent` /
  `resets_in_seconds` / `window_minutes`（`usage.ts` 的 `used_percent`+`resets_in_seconds` 解析正确）。
  注意 **`codex exec` 模式下 `rate_limits` 恒为 `null`**（issue #14728），仅交互/PTY 会话有快照——
  `jixu run` 用交互 PTY 不受影响；若未来弱通道改走 `exec --json` 则拿不到 resets_at，需另寻来源。
- 弱通道当前在启动时解析「最新 rollout」并 tail 之；跨会话切换文件的精确跟随留待后续。
- `node-pty` 现为 adapter-codex 的 optionalDependency（与 adapter-claude 一致）。
