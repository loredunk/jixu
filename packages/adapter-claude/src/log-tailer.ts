import { statSync, openSync, readSync, closeSync, watchFile, unwatchFile } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import type { JixuEvent } from '@jixu/core'
import { classifyLogLine } from './classifier.js'

/**
 * 弱通道（ADR-004）：tail CC debug log，逐行匹配 ECONNRESET 等连接层错误。
 *
 * 切分关注点：
 *   - createLineScanner：纯粹的「字节流 → 完整行」累积器，无 fs，可单测
 *   - LogTailer：fs.watchFile + StringDecoder + scanner，只读新增字节
 */

export interface LineScanner {
  push(chunk: string): void
  /** 把残留的不完整行也作为一行吐出（文件读到末尾时调用） */
  flush(): void
}

/** 把任意分块的字符串流按 \n 切成完整行；跨 chunk 的半行会被缓存 */
export function createLineScanner(onLine: (line: string) => void): LineScanner {
  let buf = ''
  return {
    push(chunk: string): void {
      buf += chunk
      let idx = buf.indexOf('\n')
      while (idx !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        onLine(line)
        idx = buf.indexOf('\n')
      }
    },
    flush(): void {
      if (buf.length > 0) {
        onLine(buf)
        buf = ''
      }
    },
  }
}

export const DEFAULT_POLL_INTERVAL_MS = 1_000

/** CC debug log 默认目录（pending：真实环境路径待确认，可由调用方覆盖） */
export function defaultLogDir(home: string = homedir()): string {
  return join(home, '.claude', 'logs')
}

/** 在目录中找最新修改的 *.log 文件 */
export function resolveLatestLog(dir: string): string | undefined {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  let newest: { path: string; mtime: number } | undefined
  for (const name of entries) {
    if (!name.endsWith('.log')) continue
    const path = join(dir, name)
    try {
      const mtime = statSync(path).mtimeMs
      if (!newest || mtime > newest.mtime) newest = { path, mtime }
    } catch {
      // 文件刚被删，忽略
    }
  }
  return newest?.path
}

export interface LogTailerOptions {
  filePath: string
  /** 命中连接层错误时回调（waiter 据此写 job 文件或直接喂决策引擎） */
  onEvent: (event: JixuEvent, line: string) => void
  /** 每读到一行都回调（waiter 用作 watchdog 的活跃信号） */
  onLine?: (line: string) => void
  pollIntervalMs?: number
  /** true 时从文件头开始扫描；默认 false 只关注启动后新增的行 */
  fromStart?: boolean
}

/**
 * tail 单个日志文件，新增行经 classifyLogLine 命中 ConnDead 时回调 onEvent。
 * 处理文件被截断/轮转（size < pos 时重置到 0）。
 */
export class LogTailer {
  private readonly filePath: string
  private readonly onEvent: (event: JixuEvent, line: string) => void
  private readonly onLine: ((line: string) => void) | undefined
  private readonly pollIntervalMs: number
  private readonly decoder = new StringDecoder('utf8')
  private readonly scanner: LineScanner
  private pos = 0
  private watching = false

  constructor(opts: LogTailerOptions) {
    this.filePath = opts.filePath
    this.onEvent = opts.onEvent
    this.onLine = opts.onLine
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.scanner = createLineScanner((line) => {
      this.onLine?.(line)
      const event = classifyLogLine(line)
      if (event) this.onEvent(event, line)
    })
    if (!opts.fromStart) {
      // 从当前文件末尾开始，忽略历史日志
      try {
        this.pos = statSync(this.filePath).size
      } catch {
        this.pos = 0
      }
    }
  }

  start(): void {
    if (this.watching) return
    this.watching = true
    this.poll() // 立即扫一次启动前可能已写入的新行
    watchFile(this.filePath, { interval: this.pollIntervalMs }, () => this.poll())
  }

  stop(): void {
    if (!this.watching) return
    unwatchFile(this.filePath)
    this.watching = false
  }

  /** 读取 pos..size 的新增字节并扫描（watchFile 回调与单测都走这里） */
  poll(): void {
    let size: number
    try {
      size = statSync(this.filePath).size
    } catch {
      return // 文件暂不存在
    }
    if (size < this.pos) this.pos = 0 // 截断/轮转，重新从头读
    if (size === this.pos) return

    const fd = openSync(this.filePath, 'r')
    try {
      const len = size - this.pos
      const buf = Buffer.allocUnsafe(len)
      const bytesRead = readSync(fd, buf, 0, len, this.pos)
      this.pos += bytesRead
      // StringDecoder 处理跨读取边界的多字节字符
      this.scanner.push(this.decoder.write(buf.subarray(0, bytesRead)))
    } finally {
      closeSync(fd)
    }
  }
}
