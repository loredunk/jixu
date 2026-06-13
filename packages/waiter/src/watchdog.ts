/**
 * 看门狗（ADR-004）：跟踪每个 session 的最近活跃时间。
 * 超过 STALL_TIMEOUT 无活跃（无新 token / 无新日志行）→ 判定 Stalled。
 *
 * 纯粹的时间逻辑，注入 now() 即可确定性单测。
 */
export const DEFAULT_STALL_TIMEOUT_MS = 120_000 // 默认 120s

export class Watchdog {
  private readonly lastActivity = new Map<string, number>()
  private readonly now: () => number
  private readonly timeoutMs: number

  constructor(opts: { now?: () => number; timeoutMs?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
  }

  /** 记录一次活跃（收到 job、读到新日志行、触发 resume 时调用） */
  record(sessionId: string): void {
    this.lastActivity.set(sessionId, this.now())
  }

  /** 不再跟踪某 session（正常结束 / 被 halt 时调用） */
  forget(sessionId: string): void {
    this.lastActivity.delete(sessionId)
  }

  /** 当前所有已停滞的 session（now - 最近活跃 > timeout） */
  stalled(): string[] {
    const now = this.now()
    const out: string[] = []
    for (const [sid, t] of this.lastActivity) {
      if (now - t > this.timeoutMs) out.push(sid)
    }
    return out
  }

  isTracking(sessionId: string): boolean {
    return this.lastActivity.has(sessionId)
  }
}
