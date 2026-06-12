import { type JixuEvent, type Decision, FATAL_REASONS } from './types.js'
import { type GuardState, guardExceeded, guardCount } from './guard.js'
import { calcDelayWithJitter } from './backoff.js'

export const SLEEP_BUFFER_MS = 30_000 // resets_at 后的安全缓冲 30s

export interface EngineOptions {
  maxRetries?: number
  sleepBufferMs?: number
  /** 注入随机函数，用于单测消除 jitter */
  random?: () => number
}

/**
 * 纯函数决策引擎：给定事件 + 当前 guard 状态 → 返回应执行的动作。
 * 无副作用，不依赖任何 Node.js API，完全可单测。
 */
export function decide(
  event: JixuEvent,
  sessionId: string,
  guardState: GuardState,
  opts: EngineOptions = {},
): Decision {
  const {
    maxRetries,
    sleepBufferMs = SLEEP_BUFFER_MS,
    random,
  } = opts

  // TurnEnded — 会话正常结束，无需续接
  if (event.type === 'TurnEnded') {
    return { action: 'stop', reason: 'turn_ended' }
  }

  // Guard 检查：连续自动续次数已达上限
  if (guardExceeded(guardState, sessionId, maxRetries)) {
    return { action: 'stop', reason: 'guard_exceeded' }
  }

  // 当前 session 的续接次数（用于退避计算）
  const attempt = guardCount(guardState, sessionId)

  if (event.type === 'RateLimited') {
    if (event.resets_at !== undefined) {
      return { action: 'sleep', until: event.resets_at + sleepBufferMs, then: 'resume' }
    }
    return { action: 'backoff_resume', delayMs: calcDelayWithJitter({ attempt }, random) }
  }

  // 死连接 / 停滞：必须 kill 原进程，起新进程续接（见 ADR-006）
  if (event.type === 'ConnDead' || event.type === 'Stalled') {
    return { action: 'kill_resume' }
  }

  if (event.type === 'ApiError') {
    if (FATAL_REASONS.has(event.reason)) {
      return { action: 'stop', reason: 'fatal_error' }
    }
    if (event.reason === 'rate_limit' && event.resets_at !== undefined) {
      return { action: 'sleep', until: event.resets_at + sleepBufferMs, then: 'resume' }
    }
    return { action: 'backoff_resume', delayMs: calcDelayWithJitter({ attempt }, random) }
  }

  return { action: 'noop' }
}
