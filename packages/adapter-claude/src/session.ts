import { readFileSync } from 'node:fs'
import type { DiskJobFile } from '@jixu/core'

/**
 * 读取磁盘上的 job 文件。可能是 hook 写的 RawHookJobFile（含 rawPayload）
 * 或 log-tailer 写的 JobFile（含 event），调用方据字段区分。
 */
export function readJobFile(path: string): DiskJobFile {
  const raw = readFileSync(path, 'utf-8')
  return JSON.parse(raw) as DiskJobFile
}

/**
 * 从 CC transcript 路径推断 session_id。
 * 路径格式：~/.claude/projects/<project>/<session_id>.jsonl
 */
export function sessionIdFromTranscriptPath(transcriptPath: string): string | null {
  const m = transcriptPath.match(/([a-f0-9-]{36})\.jsonl$/)
  return m?.[1] ?? null
}
