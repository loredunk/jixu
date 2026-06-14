import { describe, test, expect } from 'vitest'
import {
  epochToMs,
  parseAccessToken,
  parseUsageResponse,
  parseRateLimitCache,
  getUsage,
  fetchUsage,
  TokenExpiredError,
  CACHE_MAX_AGE_MS,
  type FetchLike,
} from '../src/usage-api'

// ── epochToMs ────────────────────────────────────────────────────────────────
describe('epochToMs()', () => {
  test('秒级时间戳 → × 1000', () => {
    expect(epochToMs(1_718_000_000)).toBe(1_718_000_000_000)
  })
  test('毫秒级时间戳 → 原样', () => {
    expect(epochToMs(1_718_000_000_000)).toBe(1_718_000_000_000)
  })
})

// ── parseAccessToken ─────────────────────────────────────────────────────────
describe('parseAccessToken()', () => {
  test('提取 .claudeAiOauth.accessToken', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-tok-123' } })
    expect(parseAccessToken(raw)).toBe('sk-tok-123')
  })
  test('缺少 oauth 字段 → undefined', () => {
    expect(parseAccessToken(JSON.stringify({ other: 1 }))).toBeUndefined()
  })
  test('空 token → undefined', () => {
    expect(parseAccessToken(JSON.stringify({ claudeAiOauth: { accessToken: '' } }))).toBeUndefined()
  })
  test('非 JSON → undefined', () => {
    expect(parseAccessToken('not json')).toBeUndefined()
  })
})

// ── parseUsageResponse ───────────────────────────────────────────────────────
describe('parseUsageResponse()', () => {
  test('five_hour.reset（秒）→ resets_at 毫秒', () => {
    const usage = parseUsageResponse({ five_hour: { used: 42, reset: 1_718_000_000 } })
    expect(usage.fiveHour).toEqual({ used: 42, resets_at: 1_718_000_000_000 })
  })
  test('同时解析 seven_day', () => {
    const usage = parseUsageResponse({
      five_hour: { reset: 1_718_000_000 },
      seven_day: { utilization: 10, reset: 1_718_500_000 },
    })
    expect(usage.fiveHour?.resets_at).toBe(1_718_000_000_000)
    expect(usage.sevenDay).toEqual({ used: 10, resets_at: 1_718_500_000_000 })
  })
  test('reset 为 ISO 字符串也可解析', () => {
    const usage = parseUsageResponse({ five_hour: { reset: '2024-06-10T00:00:00Z' } })
    expect(usage.fiveHour?.resets_at).toBe(Date.parse('2024-06-10T00:00:00Z'))
  })
  test('无窗口字段 → 空对象', () => {
    expect(parseUsageResponse({ foo: 1 })).toEqual({})
  })
  test('非对象 → 空对象', () => {
    expect(parseUsageResponse(null)).toEqual({})
  })
})

// ── parseRateLimitCache ──────────────────────────────────────────────────────
describe('parseRateLimitCache()', () => {
  const now = 1_718_000_000_000

  test('新鲜缓存 → 返回 UsageInfo', () => {
    const raw = JSON.stringify({
      timestamp: now - 60_000, // 1 分钟前
      rate_limits: { five_hour: { resets_at: 1_718_100_000_000 } },
    })
    const usage = parseRateLimitCache(raw, now)
    expect(usage?.fiveHour?.resets_at).toBe(1_718_100_000_000)
  })

  test('过期缓存（> 30 分钟）→ undefined', () => {
    const raw = JSON.stringify({
      timestamp: now - (CACHE_MAX_AGE_MS + 1),
      rate_limits: { five_hour: { resets_at: 1_718_100_000_000 } },
    })
    expect(parseRateLimitCache(raw, now)).toBeUndefined()
  })

  test('缺少 timestamp → undefined', () => {
    const raw = JSON.stringify({ rate_limits: { five_hour: { resets_at: 1 } } })
    expect(parseRateLimitCache(raw, now)).toBeUndefined()
  })

  test('无 rate_limits 数据 → undefined', () => {
    const raw = JSON.stringify({ timestamp: now })
    expect(parseRateLimitCache(raw, now)).toBeUndefined()
  })

  test('秒级 timestamp 也按新鲜处理', () => {
    const raw = JSON.stringify({
      timestamp: Math.floor(now / 1000) - 60, // 秒
      rate_limits: { five_hour: { resets_at: 1_718_100_000 } },
    })
    expect(parseRateLimitCache(raw, now)?.fiveHour?.resets_at).toBe(1_718_100_000_000)
  })
})

// ── getUsage 编排 ────────────────────────────────────────────────────────────
describe('getUsage()（来源优先级）', () => {
  const okFetch = (body: unknown): FetchLike => async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })

  test('API 成功 → 用 API 数据，不读缓存', async () => {
    let cacheRead = false
    const usage = await getUsage({
      readToken: () => 'tok',
      fetchFn: okFetch({ five_hour: { reset: 1_718_000_000 } }),
      readCacheRaw: () => {
        cacheRead = true
        return undefined
      },
    })
    expect(usage.fiveHour?.resets_at).toBe(1_718_000_000_000)
    expect(cacheRead).toBe(false)
  })

  test('API 401（token 过期）→ fallback 到缓存', async () => {
    const now = 1_718_000_000_000
    const usage = await getUsage({
      readToken: () => 'expired',
      fetchFn: async () => ({
        ok: false,
        status: 401,
        json: async () => {
          throw new TokenExpiredError()
        },
      }),
      readCacheRaw: () =>
        JSON.stringify({
          timestamp: now - 1000,
          rate_limits: { five_hour: { resets_at: 1_718_100_000_000 } },
        }),
      now: () => now,
    })
    expect(usage.fiveHour?.resets_at).toBe(1_718_100_000_000)
  })

  test('无 token → 直接走缓存', async () => {
    const now = 1_718_000_000_000
    const usage = await getUsage({
      readToken: () => undefined,
      readCacheRaw: () =>
        JSON.stringify({
          timestamp: now,
          rate_limits: { seven_day: { resets_at: 1_718_200_000_000 } },
        }),
      now: () => now,
    })
    expect(usage.sevenDay?.resets_at).toBe(1_718_200_000_000)
  })

  test('API 与缓存都失败 → 空对象', async () => {
    const usage = await getUsage({
      readToken: () => 'tok',
      fetchFn: async () => {
        throw new Error('ECONNRESET')
      },
      readCacheRaw: () => undefined,
    })
    expect(usage).toEqual({})
  })
})

// ── fetchUsage 401 ───────────────────────────────────────────────────────────
describe('fetchUsage()', () => {
  test('401 → 抛 TokenExpiredError', async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({}) })
    await expect(fetchUsage('tok', fetchFn)).rejects.toBeInstanceOf(TokenExpiredError)
  })

  test('500 → 抛通用错误', async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) })
    await expect(fetchUsage('tok', fetchFn)).rejects.toThrow('500')
  })
})
