import { readFileSync } from 'node:fs'
import type { UsageInfo } from '@jixu/core'
import { resolveLatestRollout, sessionsDir } from './paths.js'

/**
 * Codex 的 resets_at 来源与 Claude 不同：没有独立的 OAuth 用量 HTTP API，
 * 用量/重置信息内联在会话流的 rate_limits 事件里
 * （primary = 5 小时窗口，secondary = 每周窗口；各含 resets_in_seconds 相对秒数）。
 *
 * getUsage 读最新 rollout jsonl，取其中最后一条带 rate_limits 的记录，用该记录的
 * 时间戳 + resets_in_seconds 换算成绝对 resets_at（毫秒），映射到 UsageInfo。
 *
 * 纯解析（parseRateLimitsSnapshot / extractRateLimits / parseLatestUsage）与 IO
 * 分离，便于单测。字段形态按 codex-rs 推断，真实环境仍需校验（见 ADR-008）。
 */

interface RateLimitWindow {
  used: number
  resets_at: number
}

/** 解析 RateLimitSnapshot（含 primary/secondary）→ UsageInfo */
export function parseRateLimitsSnapshot(snapshot: unknown, emittedAtMs: number): UsageInfo {
  if (!isObj(snapshot)) return {}
  const out: UsageInfo = {}
  const five = parseWindow(snapshot['primary'], emittedAtMs)
  if (five) out.fiveHour = five
  const seven = parseWindow(snapshot['secondary'], emittedAtMs)
  if (seven) out.sevenDay = seven
  return out
}

/**
 * 从一条 rollout/exec 记录里挖出 rate_limits 快照与它的发生时刻。
 * 兼容多层嵌套：record.rate_limits / record.msg.rate_limits /
 * record.payload.rate_limits / record.payload.info.rate_limits。
 */
export function extractRateLimits(
  record: Record<string, unknown>,
  fallbackNowMs: number,
): { snapshot: Record<string, unknown>; emittedAtMs: number } | undefined {
  const emittedAtMs = parseTimestamp(record['timestamp']) ?? fallbackNowMs
  const msg = isObj(record['msg']) ? record['msg'] : undefined
  const payload = isObj(record['payload']) ? record['payload'] : undefined
  const info = isObj(record['info']) ? record['info'] : undefined
  const payloadInfo = payload && isObj(payload['info']) ? payload['info'] : undefined

  const sources: unknown[] = [
    record['rate_limits'],
    msg?.['rate_limits'],
    payload?.['rate_limits'],
    info?.['rate_limits'],
    payloadInfo?.['rate_limits'],
  ]
  for (const s of sources) {
    if (isObj(s)) return { snapshot: s, emittedAtMs }
  }
  return undefined
}

/** 倒序扫描 rollout 全部行，返回最后一条 rate_limits 解析出的 UsageInfo */
export function parseLatestUsage(lines: string[], nowMs: number): UsageInfo {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(obj)) continue
    const found = extractRateLimits(obj, nowMs)
    if (found) {
      const usage = parseRateLimitsSnapshot(found.snapshot, found.emittedAtMs)
      if (usage.fiveHour || usage.sevenDay) return usage
    }
  }
  return {}
}

export interface CodexUsageDeps {
  readLatestRollout?: () => string | undefined
  now?: () => number
}

/** 读最新 rollout，解析最后的 rate_limits → UsageInfo；任何失败回退 {} */
export async function getUsage(deps: CodexUsageDeps = {}): Promise<UsageInfo> {
  try {
    const raw = (deps.readLatestRollout ?? defaultReadLatestRollout)()
    if (!raw) return {}
    const now = (deps.now ?? Date.now)()
    return parseLatestUsage(raw.split('\n'), now)
  } catch {
    return {}
  }
}

// ── 内部 ──────────────────────────────────────────────────────────────────────

function defaultReadLatestRollout(): string | undefined {
  const file = resolveLatestRollout(sessionsDir())
  if (!file) return undefined
  try {
    return readFileSync(file, 'utf-8')
  } catch {
    return undefined
  }
}

function parseWindow(w: unknown, emittedAtMs: number): RateLimitWindow | undefined {
  if (!isObj(w)) return undefined
  const resets = readResetsAt(w, emittedAtMs)
  if (resets === undefined) return undefined
  const used = numberOf(w['used_percent']) ?? numberOf(w['used']) ?? 0
  return { used, resets_at: resets }
}

function readResetsAt(w: Record<string, unknown>, emittedAtMs: number): number | undefined {
  // 相对秒数（Codex 主形态）
  const rel = numberOf(w['resets_in_seconds']) ?? numberOf(w['reset_after_seconds'])
  if (rel !== undefined) return emittedAtMs + rel * 1000
  // 绝对时间兜底
  for (const key of ['resets_at', 'reset'] as const) {
    const v = w[key]
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
    if (typeof v === 'string') {
      const t = Date.parse(v)
      if (!Number.isNaN(t)) return t
    }
  }
  return undefined
}

function parseTimestamp(v: unknown): number | undefined {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return t
  }
  return undefined
}

function numberOf(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
