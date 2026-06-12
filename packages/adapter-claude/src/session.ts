import { readFileSync } from 'node:fs'
import type { JobFile } from '@jixu/core'

/**
 * 从 job 文件中读取 session_id。
 * 用于 waiter 在收到 hook 写入的 job 文件后，确定要续接哪个会话。
 */
export function readJobFile(path: string): JobFile {
  const raw = readFileSync(path, 'utf-8')
  return JSON.parse(raw) as JobFile
}

/**
 * 从 CC transcript 路径推断 session_id。
 * 路径格式：~/.claude/projects/<project>/<session_id>.jsonl
 */
export function sessionIdFromTranscriptPath(transcriptPath: string): string | null {
  const m = transcriptPath.match(/([a-f0-9-]{36})\.jsonl$/)
  return m?.[1] ?? null
}
