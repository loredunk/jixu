// ── 归一化事件 ────────────────────────────────────────────────────────────

export type JixuEvent =
  | { type: 'TurnEnded'; sessionId: string }
  | { type: 'RateLimited'; resets_at?: number; raw?: string }
  | { type: 'ConnDead'; raw?: string }
  | { type: 'Stalled' }
  | { type: 'ApiError'; reason: ApiErrorReason; resets_at?: number; raw?: string }

export type ApiErrorReason =
  | 'overloaded'       // 可重试
  | 'rate_limit'       // 可重试，同 RateLimited（来自 hook 路径）
  | 'conn_reset'       // 死连接（来自 log-tailer）
  | 'auth_failed'      // FATAL
  | 'billing_failed'   // FATAL
  | 'context_too_long' // FATAL
  | 'invalid_request'  // FATAL

export const FATAL_REASONS = new Set<ApiErrorReason>([
  'auth_failed',
  'billing_failed',
  'context_too_long',
  'invalid_request',
])

// ── 适配器能力标志位 ──────────────────────────────────────────────────────

export interface AdapterCapabilities {
  /** strong = StopFailure hook 可用；weak = 仅 log-tail 兜底 */
  errorDetect: 'strong' | 'weak'
  /** 是否能获取 resets_at 精确时间 */
  resetTime: boolean
  /** 是否支持 PTY 交互式续接 */
  forceContinue: boolean
}

// ── 用量信息 ──────────────────────────────────────────────────────────────

export interface UsageInfo {
  fiveHour?: { used: number; resets_at: number }
  sevenDay?: { used: number; resets_at: number }
}

// ── 适配器接口 ────────────────────────────────────────────────────────────

export interface IToolAdapter {
  readonly id: string
  readonly capabilities: AdapterCapabilities
  resume(mode: 'headless' | 'pty', sessionId: string): Promise<void>
  usage(): Promise<UsageInfo>
  kill(pid: number): Promise<void>
}

// ── Job 文件（hook → waiter 通信） ────────────────────────────────────────

export interface JobFile {
  event: JixuEvent
  sessionId: string
  pid?: number
  timestamp: number // Unix ms
}

// ── 决策引擎输出 ──────────────────────────────────────────────────────────

export type Decision =
  | { action: 'sleep'; until: number; then: 'resume' }
  | { action: 'kill_resume' }
  | { action: 'backoff_resume'; delayMs: number }
  | { action: 'stop'; reason: StopReason }
  | { action: 'noop' }

export type StopReason = 'fatal_error' | 'guard_exceeded' | 'turn_ended'
