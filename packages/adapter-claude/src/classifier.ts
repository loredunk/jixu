import type { JixuEvent } from '@jixu/core'

/**
 * 从 StopFailure hook 的 stdin payload（JSON 或纯文本）分类事件。
 * 返回 null 表示无法识别，waiter 应忽略该事件。
 */
export function classifyHookPayload(raw: string): JixuEvent | null {
  if (!raw) return null

  // 优先尝试 JSON 解析，利用结构化字段
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const errorType = getNestedString(parsed, ['error', 'type'])
    const message = getNestedString(parsed, ['error', 'message']) ?? ''

    if (errorType === 'overloaded_error' || /overload/i.test(message)) {
      return { type: 'ApiError', reason: 'overloaded', raw }
    }

    if (errorType === 'rate_limit_error' || /rate.limit/i.test(message)) {
      const resets_at = extractResetsAt(parsed, raw)
      return { type: 'RateLimited', resets_at, raw }
    }

    if (errorType === 'authentication_error' || /auth|unauthorized|invalid.*key/i.test(message)) {
      return { type: 'ApiError', reason: 'auth_failed', raw }
    }

    if (errorType === 'billing_error' || /billing|payment/i.test(message)) {
      return { type: 'ApiError', reason: 'billing_failed', raw }
    }

    if (/context.{0,10}too.long|too.{0,10}long|413/i.test(message)) {
      return { type: 'ApiError', reason: 'context_too_long', raw }
    }

    if (/invalid.request|400/i.test(message)) {
      return { type: 'ApiError', reason: 'invalid_request', raw }
    }
  } catch {
    // 非 JSON，走关键字回退
  }

  // 关键字回退（处理非 JSON 格式的 hook 输出）
  if (/overload/i.test(raw)) {
    return { type: 'ApiError', reason: 'overloaded', raw }
  }
  if (/rate.?limit/i.test(raw)) {
    return { type: 'RateLimited', resets_at: extractResetsAtFromText(raw), raw }
  }
  if (/auth|unauthorized/i.test(raw)) {
    return { type: 'ApiError', reason: 'auth_failed', raw }
  }

  return null
}

/**
 * 从 CC debug log 的单行文本分类连接层错误。
 * 返回 null 表示该行不含已知错误特征。
 */
export function classifyLogLine(line: string): JixuEvent | null {
  if (/ECONNRESET|socket hang up|connection reset|socket closed/i.test(line)) {
    return { type: 'ConnDead', raw: line }
  }
  return null
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

function getNestedString(obj: Record<string, unknown>, path: string[]): string | undefined {
  let cur: unknown = obj
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return typeof cur === 'string' ? cur : undefined
}

function extractResetsAt(parsed: Record<string, unknown>, raw: string): number | undefined {
  // 直接字段
  const direct = parsed['resets_at']
  if (typeof direct === 'number') return direct

  // 嵌套在 error 对象里
  const nested = getNestedString(parsed, ['error', 'resets_at'])
  if (nested) {
    const n = Number(nested)
    if (!isNaN(n)) return n
  }

  return extractResetsAtFromText(raw)
}

function extractResetsAtFromText(text: string): number | undefined {
  const m = text.match(/"resets_at"\s*:\s*(\d+)/)
  if (m?.[1]) {
    const n = Number(m[1])
    return isNaN(n) ? undefined : n
  }
  return undefined
}
