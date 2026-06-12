import { describe, test, expect } from 'vitest'
import { decide, SLEEP_BUFFER_MS } from '../src/engine'
import { freshGuardState, guardIncrement, MAX_RETRIES } from '../src/guard'
import type { ApiErrorReason } from '../src/types'

const SID = 'sess-test-001'
const noGuard = freshGuardState()
// 固定 random=0 消除 jitter，让退避测试确定
const opts = { random: () => 0 as number }

// ── TurnEnded ──────────────────────────────────────────────────────────────
describe('TurnEnded', () => {
  test('→ stop{turn_ended}', () => {
    expect(decide({ type: 'TurnEnded', sessionId: SID }, SID, noGuard, opts))
      .toEqual({ action: 'stop', reason: 'turn_ended' })
  })
})

// ── RateLimited ────────────────────────────────────────────────────────────
describe('RateLimited', () => {
  test('有 resets_at → sleep until resets_at + SLEEP_BUFFER_MS', () => {
    const resets_at = 1_000_000_000_000
    expect(decide({ type: 'RateLimited', resets_at }, SID, noGuard, opts))
      .toEqual({ action: 'sleep', until: resets_at + SLEEP_BUFFER_MS, then: 'resume' })
  })

  test('无 resets_at → backoff_resume', () => {
    const d = decide({ type: 'RateLimited' }, SID, noGuard, opts)
    expect(d.action).toBe('backoff_resume')
  })
})

// ── ConnDead ───────────────────────────────────────────────────────────────
describe('ConnDead', () => {
  test('→ kill_resume', () => {
    expect(decide({ type: 'ConnDead' }, SID, noGuard, opts))
      .toEqual({ action: 'kill_resume' })
  })
})

// ── Stalled ────────────────────────────────────────────────────────────────
describe('Stalled', () => {
  test('→ kill_resume', () => {
    expect(decide({ type: 'Stalled' }, SID, noGuard, opts))
      .toEqual({ action: 'kill_resume' })
  })
})

// ── ApiError ───────────────────────────────────────────────────────────────
describe('ApiError', () => {
  test('overloaded → backoff_resume', () => {
    const d = decide({ type: 'ApiError', reason: 'overloaded' }, SID, noGuard, opts)
    expect(d.action).toBe('backoff_resume')
  })

  test('rate_limit + resets_at → sleep', () => {
    const resets_at = 1_000_000_000_000
    expect(decide({ type: 'ApiError', reason: 'rate_limit', resets_at }, SID, noGuard, opts))
      .toEqual({ action: 'sleep', until: resets_at + SLEEP_BUFFER_MS, then: 'resume' })
  })

  test('rate_limit 无 resets_at → backoff_resume', () => {
    const d = decide({ type: 'ApiError', reason: 'rate_limit' }, SID, noGuard, opts)
    expect(d.action).toBe('backoff_resume')
  })

  const FATAL: ApiErrorReason[] = [
    'auth_failed',
    'billing_failed',
    'context_too_long',
    'invalid_request',
  ]

  test.each(FATAL)('FATAL %s → stop{fatal_error}', (reason) => {
    expect(decide({ type: 'ApiError', reason }, SID, noGuard, opts))
      .toEqual({ action: 'stop', reason: 'fatal_error' })
  })
})

// ── Guard ──────────────────────────────────────────────────────────────────
describe('Guard（循环保护）', () => {
  test(`连续续接 ${MAX_RETRIES} 次后 guard exceeded → stop`, () => {
    let state = noGuard
    for (let i = 0; i < MAX_RETRIES; i++) state = guardIncrement(state, SID)
    expect(decide({ type: 'ConnDead' }, SID, state, opts))
      .toEqual({ action: 'stop', reason: 'guard_exceeded' })
  })

  test(`续接 ${MAX_RETRIES - 1} 次未超 → 仍 kill_resume`, () => {
    let state = noGuard
    for (let i = 0; i < MAX_RETRIES - 1; i++) state = guardIncrement(state, SID)
    expect(decide({ type: 'ConnDead' }, SID, state, opts).action).toBe('kill_resume')
  })

  test('guard exceeded 对所有非 FATAL 事件均返回 stop', () => {
    let state = noGuard
    for (let i = 0; i < MAX_RETRIES; i++) state = guardIncrement(state, SID)
    for (const event of [
      { type: 'RateLimited' as const },
      { type: 'ConnDead' as const },
      { type: 'Stalled' as const },
      { type: 'ApiError' as const, reason: 'overloaded' as ApiErrorReason },
    ]) {
      expect(decide(event, SID, state, opts).action).toBe('stop')
    }
  })

  test('不同 session 的 guard 独立', () => {
    let state = noGuard
    for (let i = 0; i < MAX_RETRIES; i++) state = guardIncrement(state, SID)
    // 另一个 session 的 guard 未超
    expect(decide({ type: 'ConnDead' }, 'sess-other', state, opts).action).toBe('kill_resume')
  })

  test('自定义 maxRetries=1 → 续一次后 stop', () => {
    const state = guardIncrement(noGuard, SID)
    expect(decide({ type: 'ConnDead' }, SID, state, { ...opts, maxRetries: 1 }))
      .toEqual({ action: 'stop', reason: 'guard_exceeded' })
  })
})

// ── Sleep buffer 可覆盖 ───────────────────────────────────────────────────
describe('sleepBufferMs 可覆盖', () => {
  test('自定义 sleepBufferMs', () => {
    const resets_at = 1_000_000_000_000
    const d = decide(
      { type: 'RateLimited', resets_at },
      SID,
      noGuard,
      { ...opts, sleepBufferMs: 5_000 },
    )
    expect(d).toEqual({ action: 'sleep', until: resets_at + 5_000, then: 'resume' })
  })
})
