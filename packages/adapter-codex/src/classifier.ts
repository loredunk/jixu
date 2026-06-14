import type { JixuEvent } from '@jixu/core'

/**
 * 把 Codex 的输出 / 事件 / rollout 行分类为归一化 JixuEvent。
 *
 * Codex 没有 Claude 那样的 StopFailure hook（→ capabilities.errorDetect 'weak'）：
 *   - 交互/exec 输出逐行 → classifyStreamLine（先试 JSON 事件，再关键字兜底）
 *   - `codex exec --json` 事件行 → classifyExecEvent
 *   - rollout jsonl 行（弱通道 tail） → classifyRolloutLine
 * 返回 null 表示该行无已知中断特征。
 *
 * 注：字段形态按 Codex 公开行为推断，真实环境字段仍需校验（见 ADR-008）。
 */

// Codex 是 Rust CLI（reqwest / hyper / tokio / rustls），网络错误串与 Claude(Node) 不是一套。
//
// 连接层分两档（见 ADR-008，正则按 codex 真实 issue 输出 + 防御式推断对齐）：
//
// HARD —— 无歧义的硬连接/网络栈错误，直接 ConnDead，且优先于一切 HTTP 状态码判定。
//   既有 Node/通用串 + Rust HTTP 栈 + 中国网络高发失败面（DNS 污染 / TLS 握手被 GFW 干扰
//   / 连接重置 / 路由黑洞 / OS errno）。这些串不会出现在正常输出里，命中即连接死亡。
const HARD_CONN_PATTERNS = [
  // 通用 socket / 连接层
  'ECONNRESET', 'socket hang up', 'connection reset', 'socket closed',
  'connection (refused|timed out|closed|aborted)',
  // Node 变体 / 实测 CC 断网串
  'ETIMEDOUT', 'ECONNREFUSED', 'ConnectionRefused',
  'fetch failed', 'network error', '403 request not allowed', 'unable to connect to api',
  // reqwest / hyper 顶层与连接体
  'error sending request', 'connection closed before message completed',
  'error reading a body', 'incomplete message',
  // tokio/io OS errno（GFW 重置 104 / 超时 110 / 拒绝 111 / 不可达 101,113 / 断管 32）
  'os error (104|110|111|101|113|32)', 'connection reset by peer', 'broken pipe',
  'network is unreachable', 'no route to host',
  // DNS（污染 / 解析失败）
  'dns error', 'failed to lookup address', 'name resolution', 'ENOTFOUND',
  // 路由 / 管道 errno
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  // TLS 握手被干扰（GFW 中间人 / SNI 阻断）
  'tls handshake', 'handshake fail', 'received fatal alert', 'peer closed connection',
  'invalid peer certificate', 'certificate verify failed', 'EPROTO',
  // 超时惯用文案
  'operation timed out', 'request timed out',
]
const HARD_CONN_RE = new RegExp(HARD_CONN_PATTERNS.join('|'), 'i')

// SOFT —— 歧义信号，必须排在 HTTP 状态码判定「之后」兜底。
//   codex 把 429/401/400/5xx 都包成 `stream error: ... last status: <code>` /
//   `exceeded retry limit, last status: <code>`（实测 issue #2612/#2896/#9148）。
//   只有当文本没有可识别的 HTTP 语义时（如 `stream disconnected before completion: ...`
//   纯断流），才落 ConnDead；否则交给上面的 rate/auth/invalid/overloaded 正确归类。
const SOFT_CONN_RE = /stream (disconnected|closed|error)|exceeded retry limit/i

/** 纯文本行的硬连接层探测 → ConnDead；否则 null（歧义 stream/状态码不在此判，避免误吞 FATAL）。 */
export function classifyLogLine(line: string): JixuEvent | null {
  if (HARD_CONN_RE.test(line)) return { type: 'ConnDead', raw: line }
  return null
}

/**
 * 把一段错误消息文本分类为事件。顺序刻意为之：
 *   硬连接错误 → 速率限制 → 计费 → 过载(5xx) → 鉴权 → 上下文 → 通用 400 → 软连接兜底。
 * 关键：状态码语义（429/401/400/5xx）必须先于「stream error / exceeded retry limit」兜底，
 * 因为 codex 把这些状态码都包在 stream-error 文案里（见 SOFT_CONN_RE 注释）。
 */
export function classifyCodexMessage(message: string): JixuEvent | null {
  if (!message) return null
  const m = message

  if (HARD_CONN_RE.test(m)) return { type: 'ConnDead', raw: m }

  // ChatGPT 套餐用量上限 / API 429 → 速率限制（套餐限流是可重置的，非计费失败）
  if (/usage limit|rate.?limit|too many requests|\b429\b/i.test(m)) {
    const resets_at = extractResetsAt(m)
    return resets_at !== undefined
      ? { type: 'RateLimited', resets_at, raw: m }
      : { type: 'RateLimited', raw: m }
  }

  // 计费/额度（API key 余额耗尽）——与上面的「套餐用量上限」区分
  if (/insufficient_quota|billing|payment required|\b402\b|out of credits/i.test(m)) {
    return { type: 'ApiError', reason: 'billing_failed', raw: m }
  }

  // 服务端 5xx / 过载（含 Cloudflare 520-526），可重试
  if (/overloaded|server had an error|server_error|internal server error|temporarily unavailable|\b5\d\d\b/i.test(m)) {
    return { type: 'ApiError', reason: 'overloaded', raw: m }
  }

  if (/unauthorized|authentication[_ ]?(error|failed)?|invalid api key|not logged in|please.{0,20}log\s?in|run .*login|\b401\b/i.test(m)) {
    return { type: 'ApiError', reason: 'auth_failed', raw: m }
  }

  if (/context.{0,16}(length|window|too long)|maximum context|reduce the (length|size)|too many tokens/i.test(m)) {
    return { type: 'ApiError', reason: 'context_too_long', raw: m }
  }

  if (/invalid.?request|bad request|\b400\b/i.test(m)) {
    return { type: 'ApiError', reason: 'invalid_request', raw: m }
  }

  // 兜底：stream error / 重试耗尽且无可识别 HTTP 语义（纯断流，如 stream disconnected before completion）
  if (SOFT_CONN_RE.test(m)) return { type: 'ConnDead', raw: m }

  return null
}

/**
 * 解析 `codex exec --json` / rollout 的单行 JSONL。兼容多套形态：
 *   - SDK thread 事件：{"type":"turn.failed","error":{"message":"..."}} / {"type":"error","message":"..."}
 *   - 协议 EventMsg：{"msg":{"type":"error"|"stream_error","message":"..."}}
 *   - rollout 包裹：{"type":"event_msg","payload":{"type":"error","message":"..."}}
 * 只在能抽到错误消息时才分类（classifyCodexMessage 仅命中错误关键字，正常文本返回 null）。
 */
export function classifyExecEvent(line: string): JixuEvent | null {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  const message = extractMessage(obj)
  if (message === undefined) return null
  return classifyCodexMessage(message)
}

/** rollout jsonl 行（弱通道 tail）：JSON 感知，认错误/连接事件 */
export function classifyRolloutLine(line: string): JixuEvent | null {
  return classifyExecEvent(line)
}

/**
 * 交互式 PTY / exec 输出逐行分类（supervisor 用）。
 * 先试结构化 JSON 事件，再退化到纯文本关键字。
 */
export function classifyStreamLine(line: string): JixuEvent | null {
  const json = classifyExecEvent(line)
  if (json) return json
  return classifyCodexMessage(line)
}

// ── 内部 ──────────────────────────────────────────────────────────────────────

/** 从一条记录里收集可能的错误消息字段（多层嵌套），交给 classifyCodexMessage 过滤 */
function extractMessage(obj: Record<string, unknown>): string | undefined {
  const err = isObj(obj['error']) ? obj['error'] : undefined
  const msg = isObj(obj['msg']) ? obj['msg'] : undefined
  const payload = isObj(obj['payload']) ? obj['payload'] : undefined
  const pmsg = payload && isObj(payload['msg']) ? payload['msg'] : undefined
  return firstString([
    err?.['message'],
    msg?.['message'],
    pmsg?.['message'],
    payload?.['message'],
    obj['message'],
  ])
}

function firstString(vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.length > 0) return v
  return undefined
}

/** 从消息文本里尽力抽出绝对重置时间（毫秒）。相对时间（"in 2h"）交给 usage API 兜底。 */
function extractResetsAt(text: string): number | undefined {
  // JSON 文本里的显式 epoch
  const epoch = text.match(/"?resets?_at"?\s*[:=]\s*"?(\d{10,13})/)
  const ev = epoch?.[1]
  if (ev) {
    const n = Number(ev)
    return n < 1e12 ? n * 1000 : n
  }
  // "try again at <ISO8601 / 日期时间>"
  const at = text.match(/try again (?:at|on)\s+([0-9T:.\-+Z ]{8,40})/i)
  const av = at?.[1]
  if (av) {
    const cleaned = av.trim().replace(/[.,;\s]+$/, '') // 去掉句尾标点
    const t = Date.parse(cleaned)
    if (!Number.isNaN(t)) return t
  }
  return undefined
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
