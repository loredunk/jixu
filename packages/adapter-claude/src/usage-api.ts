import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageInfo } from '@jixu/core'

/**
 * resets_at 获取（ADR-005）。优先级：
 *   1. OAuth usage API（GET /api/oauth/usage，需 accessToken）
 *   2. statusline 缓存文件（30 分钟内有效）
 *   3. 无信息 → 返回 {}，决策引擎退化到指数退避
 *
 * 纯解析函数（parseAccessToken / parseUsageResponse / parseRateLimitCache）
 * 与 IO（readAccessToken / fetchUsage / readCacheRaw）分离，便于单测。
 */

export const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage'
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20'
export const CACHE_MAX_AGE_MS = 30 * 60_000 // 缓存有效期 30 分钟

/** 最小化的 fetch 形状，解耦 DOM/undici 类型，便于注入 mock */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** OAuth token 过期（401）：getUsage 据此 fallback 到缓存 */
export class TokenExpiredError extends Error {
  constructor() {
    super('OAuth accessToken 已过期（401）')
    this.name = 'TokenExpiredError'
  }
}

// ── 纯解析 ──────────────────────────────────────────────────────────────────

/**
 * 把 Unix 时间戳归一化为毫秒。
 * < 1e12 视为「秒」（当前纪元秒约 1.7e9，毫秒约 1.7e12），× 1000。
 */
export function epochToMs(v: number): number {
  return v < 1e12 ? Math.round(v * 1000) : Math.round(v)
}

/** 从 credentials JSON 提取 .claudeAiOauth.accessToken */
export function parseAccessToken(raw: string): string | undefined {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const oauth = obj['claudeAiOauth']
    if (typeof oauth === 'object' && oauth !== null) {
      const tok = (oauth as Record<string, unknown>)['accessToken']
      if (typeof tok === 'string' && tok.length > 0) return tok
    }
  } catch {
    // 非 JSON
  }
  return undefined
}

/** 解析 usage API 响应为 UsageInfo（resets_at 统一为毫秒） */
export function parseUsageResponse(body: unknown): UsageInfo {
  if (typeof body !== 'object' || body === null) return {}
  const obj = body as Record<string, unknown>
  const out: UsageInfo = {}
  const five = parseWindow(obj['five_hour'])
  if (five) out.fiveHour = five
  const seven = parseWindow(obj['seven_day'])
  if (seven) out.sevenDay = seven
  return out
}

/**
 * 解析 statusline 缓存（~/.local/share/jixu/cache/rate_limits.json）。
 * timestamp 超过 maxAgeMs 视为过期，返回 undefined（让 getUsage 退化）。
 */
export function parseRateLimitCache(
  raw: string,
  nowMs: number,
  maxAgeMs: number = CACHE_MAX_AGE_MS,
): UsageInfo | undefined {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }

  const tsRaw = obj['timestamp']
  if (typeof tsRaw !== 'number') return undefined
  const ts = epochToMs(tsRaw)
  if (nowMs - ts > maxAgeMs) return undefined // 过期

  const rl = obj['rate_limits']
  if (typeof rl !== 'object' || rl === null) return undefined
  const rlObj = rl as Record<string, unknown>

  const out: UsageInfo = {}
  const five = parseWindow(rlObj['five_hour'])
  if (five) out.fiveHour = five
  const seven = parseWindow(rlObj['seven_day'])
  if (seven) out.sevenDay = seven
  return out.fiveHour || out.sevenDay ? out : undefined
}

// ── IO ────────────────────────────────────────────────────────────────────

/**
 * 读取 OAuth accessToken。
 *   macOS：钥匙串 "Claude Code-credentials"
 *   Linux/其他：~/.claude/.credentials.json
 */
export function readAccessToken(
  opts: { platform?: NodeJS.Platform; home?: string } = {},
): string | undefined {
  const platform = opts.platform ?? process.platform
  if (platform === 'darwin') {
    try {
      const out = execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf-8' },
      )
      return parseAccessToken(out)
    } catch {
      return undefined
    }
  }
  try {
    const home = opts.home ?? homedir()
    const raw = readFileSync(join(home, '.claude', '.credentials.json'), 'utf-8')
    return parseAccessToken(raw)
  } catch {
    return undefined
  }
}

/** statusline 缓存文件路径 */
export function cacheFilePath(home: string = homedir()): string {
  const base = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share')
  return join(base, 'jixu', 'cache', 'rate_limits.json')
}

function readCacheRaw(home: string = homedir()): string | undefined {
  try {
    return readFileSync(cacheFilePath(home), 'utf-8')
  } catch {
    return undefined
  }
}

/** 调用 OAuth usage API；401 抛 TokenExpiredError，其他非 2xx 抛通用错误 */
export async function fetchUsage(token: string, fetchFn?: FetchLike): Promise<UsageInfo> {
  const doFetch = fetchFn ?? (globalThis.fetch as unknown as FetchLike)
  const res = await doFetch(USAGE_API_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
    },
  })
  if (res.status === 401) throw new TokenExpiredError()
  if (!res.ok) throw new Error(`usage API 返回 ${res.status}`)
  return parseUsageResponse(await res.json())
}

export interface UsageDeps {
  readToken?: () => string | undefined
  fetchFn?: FetchLike
  readCacheRaw?: () => string | undefined
  now?: () => number
  cacheMaxAgeMs?: number
}

/**
 * 按 ADR-005 优先级获取用量：API → 缓存 → 空对象。
 * 任一来源抛错或为空都静默落到下一来源。
 */
export async function getUsage(deps: UsageDeps = {}): Promise<UsageInfo> {
  // 来源 1：OAuth usage API
  try {
    const token = (deps.readToken ?? (() => readAccessToken()))()
    if (token) {
      const usage = await fetchUsage(token, deps.fetchFn)
      if (usage.fiveHour || usage.sevenDay) return usage
    }
  } catch {
    // token 过期 / 网络失败 → 落到缓存
  }

  // 来源 2：statusline 缓存
  try {
    const raw = (deps.readCacheRaw ?? (() => readCacheRaw()))()
    if (raw) {
      const now = (deps.now ?? Date.now)()
      const cached = parseRateLimitCache(raw, now, deps.cacheMaxAgeMs)
      if (cached) return cached
    }
  } catch {
    // 缓存缺失 / 损坏 → 落到来源 3
  }

  // 来源 3：无信息
  return {}
}

// ── 内部 ────────────────────────────────────────────────────────────────────

function parseWindow(w: unknown): { used: number; resets_at: number } | undefined {
  if (typeof w !== 'object' || w === null) return undefined
  const obj = w as Record<string, unknown>
  const resetMs = readResetMs(obj)
  if (resetMs === undefined) return undefined
  return { used: readUsed(obj), resets_at: resetMs }
}

function readResetMs(obj: Record<string, unknown>): number | undefined {
  // ADR-005：API 字段名为 reset（Unix 秒）；同时兼容 resets_at
  for (const key of ['reset', 'resets_at'] as const) {
    const v = obj[key]
    if (typeof v === 'number') return epochToMs(v)
    if (typeof v === 'string') {
      const t = Date.parse(v)
      if (!Number.isNaN(t)) return t
    }
  }
  return undefined
}

function readUsed(obj: Record<string, unknown>): number {
  for (const key of ['used', 'utilization'] as const) {
    const v = obj[key]
    if (typeof v === 'number') return v
  }
  return 0
}
