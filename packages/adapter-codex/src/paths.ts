import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Codex CLI 运行时路径。Codex 把配置/会话放在 $CODEX_HOME（默认 ~/.codex）。
 * 所有函数接受可选 home，便于单测注入临时目录。
 */

/** Codex 配置目录（尊重 CODEX_HOME），默认 ~/.codex */
export function codexHome(home: string = homedir()): string {
  return process.env['CODEX_HOME'] ?? join(home, '.codex')
}

/** 会话 rollout 根目录：$CODEX_HOME/sessions（其下按 YYYY/MM/DD 分层） */
export function sessionsDir(home: string = homedir()): string {
  return join(codexHome(home), 'sessions')
}

/** ChatGPT 登录凭据 / API key 文件：$CODEX_HOME/auth.json */
export function authFilePath(home: string = homedir()): string {
  return join(codexHome(home), 'auth.json')
}

/**
 * 在 sessions 目录树（YYYY/MM/DD/rollout-*.jsonl）中找最新修改的 rollout 文件。
 * Codex 不允许预设 session id，会话启动后即出现新 rollout——取 mtime 最大者
 * 即「最近活跃会话」。有界递归（按日期固定层数下探）。
 */
export function resolveLatestRollout(dir: string = sessionsDir()): string | undefined {
  let newest: { path: string; mtime: number } | undefined

  const walk = (cur: string, depth: number): void => {
    let entries: string[]
    try {
      entries = readdirSync(cur)
    } catch {
      return
    }
    for (const name of entries) {
      const p = join(cur, name)
      let isDir: boolean
      let mtime: number
      try {
        const st = statSync(p)
        isDir = st.isDirectory()
        mtime = st.mtimeMs
      } catch {
        continue // 文件刚被删
      }
      if (isDir) {
        if (depth > 0) walk(p, depth - 1)
      } else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
        if (!newest || mtime > newest.mtime) newest = { path: p, mtime }
      }
    }
  }

  walk(dir, 3) // sessions/YYYY/MM/DD → 最多下探 3 层
  return newest?.path
}
