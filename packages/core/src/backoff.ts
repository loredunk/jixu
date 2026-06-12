export const BASE_MS = 5_000          // 首次退避 5s
export const CAP_MS = 30 * 60_000    // 退避上限 30min
/** retry-after header 的额外缓冲（与 engine 的 RETRY_AFTER_BUFFER_MS 含义不同，勿混淆） */
export const RETRY_AFTER_BUFFER_MS = 10_000

export interface BackoffOptions {
  attempt: number
  retryAfterMs?: number
}

/** 确定性退避（无 jitter），用于测试断言 */
export function calcDelay(opts: BackoffOptions): number {
  if (opts.retryAfterMs !== undefined) {
    return opts.retryAfterMs + RETRY_AFTER_BUFFER_MS
  }
  return Math.min(BASE_MS * Math.pow(2, opts.attempt), CAP_MS)
}

/** 带 jitter 的退避（±30%），生产使用；random 可注入以便单测 */
export function calcDelayWithJitter(
  opts: BackoffOptions,
  random: () => number = Math.random,
): number {
  if (opts.retryAfterMs !== undefined) {
    return opts.retryAfterMs + RETRY_AFTER_BUFFER_MS
  }
  const base = Math.min(BASE_MS * Math.pow(2, opts.attempt), CAP_MS)
  const jitter = base * 0.3 * random()
  return Math.round(base + jitter)
}
