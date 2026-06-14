import { readFileSync } from 'node:fs'

/**
 * 从 Codex rollout 路径/内容推断 session id。
 *
 * Codex 与 Claude 的关键差异：不支持预设 session id（无 --session-id 等价物）。
 * id 在会话启动时自动生成，出现在 rollout 文件名
 * （rollout-<ISO8601>-<uuid>.jsonl）与文件内的 SessionMeta 记录里。
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** 从 rollout 文件名提取 uuid：rollout-2026-06-14T10-30-00-<uuid>.jsonl */
export function sessionIdFromRolloutPath(path: string): string | null {
  const m = path.match(UUID_RE)
  return m?.[0] ?? null
}

/**
 * 从 rollout 单行 JSON 提取 session id。兼容多种形态：
 *   - {"type":"session_meta","payload":{"id":"<uuid>",...}}
 *   - {"type":"thread.started","thread_id":"<id>"}
 *   - {"session_id":"<id>"} / {"id":"<uuid>"}
 */
export function sessionIdFromRolloutLine(line: string): string | null {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  const payload = isObj(obj['payload']) ? obj['payload'] : undefined
  const candidates = [
    obj['session_id'],
    obj['thread_id'],
    obj['id'],
    payload?.['id'],
    payload?.['session_id'],
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
  }
  return null
}

/** 读取 rollout 文件，先用文件名、再逐行找出第一个可解析的 session id */
export function readSessionId(path: string): string | null {
  const fromName = sessionIdFromRolloutPath(path)
  if (fromName) return fromName
  try {
    const raw = readFileSync(path, 'utf-8')
    for (const line of raw.split('\n')) {
      const sid = sessionIdFromRolloutLine(line)
      if (sid) return sid
    }
  } catch {
    // 读不到
  }
  return null
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
