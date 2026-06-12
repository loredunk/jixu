import { describe, test, expect } from 'vitest'
import { calcDelay, calcDelayWithJitter, RETRY_AFTER_BUFFER_MS, BASE_MS, CAP_MS } from '../src/backoff'

describe('calcDelay()（无 jitter，确定性）', () => {
  test('有 retryAfterMs → 用它 + RETRY_AFTER_BUFFER_MS', () => {
    expect(calcDelay({ attempt: 0, retryAfterMs: 300_000 })).toBe(300_000 + RETRY_AFTER_BUFFER_MS)
  })

  test('retryAfterMs=0 → 仍加 buffer', () => {
    expect(calcDelay({ attempt: 0, retryAfterMs: 0 })).toBe(RETRY_AFTER_BUFFER_MS)
  })

  test('attempt=0 → BASE_MS', () => {
    expect(calcDelay({ attempt: 0 })).toBe(BASE_MS)
  })

  test('attempt=1 → BASE_MS * 2', () => {
    expect(calcDelay({ attempt: 1 })).toBe(BASE_MS * 2)
  })

  test('attempt=2 → BASE_MS * 4', () => {
    expect(calcDelay({ attempt: 2 })).toBe(BASE_MS * 4)
  })

  test('高 attempt 被 CAP_MS 截断', () => {
    expect(calcDelay({ attempt: 100 })).toBe(CAP_MS)
  })

  test('CAP_MS 为 30 分钟', () => {
    expect(CAP_MS).toBe(30 * 60 * 1000)
  })
})

describe('calcDelayWithJitter()（inject random）', () => {
  test('有 retryAfterMs → 不受 jitter 影响', () => {
    const fakeRandom = () => 0.99
    expect(calcDelayWithJitter({ attempt: 0, retryAfterMs: 60_000 }, fakeRandom))
      .toBe(60_000 + RETRY_AFTER_BUFFER_MS)
  })

  test('random=0 → 等于 calcDelay（无 jitter）', () => {
    expect(calcDelayWithJitter({ attempt: 0 }, () => 0)).toBe(BASE_MS)
  })

  test('random=1 → 最大 jitter 为 base 的 +30%', () => {
    const base = BASE_MS
    expect(calcDelayWithJitter({ attempt: 0 }, () => 1)).toBe(Math.round(base + base * 0.3))
  })

  test('jitter 结果 ≥ base（不缩小）', () => {
    for (const r of [0, 0.1, 0.5, 0.99]) {
      expect(calcDelayWithJitter({ attempt: 1 }, () => r)).toBeGreaterThanOrEqual(BASE_MS * 2)
    }
  })

  test('高 attempt 受 CAP 截断后再加 jitter', () => {
    // cap 后的 jitter 最多 CAP_MS * 1.3
    const result = calcDelayWithJitter({ attempt: 100 }, () => 1)
    expect(result).toBe(Math.round(CAP_MS + CAP_MS * 0.3))
  })
})
