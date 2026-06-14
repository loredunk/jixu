import { describe, test, expect } from 'vitest'
import {
  parseRateLimitsSnapshot,
  extractRateLimits,
  parseLatestUsage,
  getUsage,
} from '../src/usage'

const HOUR = 3_600_000
const WEEK = 7 * 24 * HOUR

// ── parseRateLimitsSnapshot ──────────────────────────────────────────────────
describe('parseRateLimitsSnapshot()', () => {
  test('primary→fiveHour、secondary→sevenDay；resets_in_seconds 换算绝对时间', () => {
    const now = 1_700_000_000_000
    const usage = parseRateLimitsSnapshot(
      {
        primary: { used_percent: 42, resets_in_seconds: 3600 },
        secondary: { used_percent: 10, resets_in_seconds: 7 * 24 * 3600 },
      },
      now,
    )
    expect(usage.fiveHour).toEqual({ used: 42, resets_at: now + HOUR })
    expect(usage.sevenDay).toEqual({ used: 10, resets_at: now + WEEK })
  })

  test('绝对 resets_at（秒）也可解析', () => {
    const usage = parseRateLimitsSnapshot({ primary: { resets_at: 1_700_003_600 } }, 0)
    expect(usage.fiveHour?.resets_at).toBe(1_700_003_600_000)
  })

  test('非对象 → 空', () => {
    expect(parseRateLimitsSnapshot(null, 0)).toEqual({})
  })
})

// ── extractRateLimits（多层嵌套） ────────────────────────────────────────────
describe('extractRateLimits()', () => {
  test('顶层 rate_limits + timestamp 决定 emittedAt', () => {
    const ts = '2026-06-14T00:00:00Z'
    const found = extractRateLimits(
      { timestamp: ts, rate_limits: { primary: { resets_in_seconds: 60 } } },
      999,
    )
    expect(found?.emittedAtMs).toBe(Date.parse(ts))
    expect(found?.snapshot).toMatchObject({ primary: { resets_in_seconds: 60 } })
  })

  test('payload.info.rate_limits（深层嵌套）', () => {
    const found = extractRateLimits(
      { payload: { info: { rate_limits: { primary: { resets_in_seconds: 1 } } } } },
      123,
    )
    expect(found?.emittedAtMs).toBe(123) // 无 timestamp → fallbackNow
    expect(found?.snapshot).toMatchObject({ primary: {} })
  })

  test('无 rate_limits → undefined', () => {
    expect(extractRateLimits({ foo: 1 }, 0)).toBeUndefined()
  })
})

// ── parseLatestUsage（倒序取最后一条 rate_limits） ──────────────────────────
describe('parseLatestUsage()', () => {
  test('取最后一条 rate_limits 记录', () => {
    const now = 5_000_000
    const lines = [
      JSON.stringify({ type: 'response_item', payload: { foo: 1 } }),
      JSON.stringify({ msg: { type: 'token_count', rate_limits: { primary: { resets_in_seconds: 100 } } } }),
      JSON.stringify({ msg: { type: 'token_count', rate_limits: { primary: { resets_in_seconds: 200 } } } }),
      '', // 空行忽略
    ]
    const usage = parseLatestUsage(lines, now)
    expect(usage.fiveHour?.resets_at).toBe(now + 200_000) // 最后一条
  })

  test('无任何 rate_limits → 空对象', () => {
    expect(parseLatestUsage(['{"type":"x"}', 'garbage'], 0)).toEqual({})
  })
})

// ── getUsage 编排 ────────────────────────────────────────────────────────────
describe('getUsage()', () => {
  test('注入 readLatestRollout + now → 解析 UsageInfo', async () => {
    const now = 1_000_000
    const rollout = [
      JSON.stringify({ msg: { type: 'token_count', rate_limits: { secondary: { used_percent: 5, resets_in_seconds: 10 } } } }),
    ].join('\n')
    const usage = await getUsage({ readLatestRollout: () => rollout, now: () => now })
    expect(usage.sevenDay).toEqual({ used: 5, resets_at: now + 10_000 })
  })

  test('无 rollout → 空对象', async () => {
    expect(await getUsage({ readLatestRollout: () => undefined })).toEqual({})
  })

  test('读取抛错 → 空对象（不冒泡）', async () => {
    expect(
      await getUsage({
        readLatestRollout: () => {
          throw new Error('boom')
        },
      }),
    ).toEqual({})
  })
})
