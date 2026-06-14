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

// 连接层错误关键字（弱通道核心）。刻意避开过宽的词（如裸 "terminated"）以减少误判。
const CONN_RE =
  /ECONNRESET|socket hang up|connection reset|socket closed|stream (disconnected|closed|error)|ETIMEDOUT|ECONNREFUSED|ConnectionRefused|connection (refused|timed out|closed)|fetch failed|network error|403 request not allowed|unable to connect to api/i

/** 连接层错误 → ConnDead；否则 null。用于在任意纯文本行上做连接层判定。 */
export function classifyLogLine(line: string): JixuEvent | null {
  if (CONN_RE.test(line)) return { type: 'ConnDead', raw: line }
  return null
}

/**
 * 把一段错误消息文本分类为事件。顺序很重要：先具体后宽泛
 * （连接层 → 速率限制 → 计费 → 过载 → 鉴权 → 上下文 → 通用 400）。
 */
export function classifyCodexMessage(message: string): JixuEvent | null {
  if (!message) return null
  const m = message

  if (CONN_RE.test(m)) return { type: 'ConnDead', raw: m }

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

  if (/overloaded|server had an error|server_error|temporarily unavailable|\b50[234]\b/i.test(m)) {
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
