import { statSync, openSync, readSync, closeSync, watchFile, unwatchFile } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { JixuEvent } from '@jixu/core'
import { classifyRolloutLine } from './classifier.js'

/**
 * 弱通道（ADR-004 的 Codex 对应）：tail Codex 的 rollout jsonl，逐行经
 * classifyRolloutLine 解析错误/连接事件。
 *
 * 与 @jixu/adapter-claude 的 LogTailer 同形（含自带 createLineScanner），
 * 刻意各自独立以保持适配器解耦——adapter-codex 不依赖 adapter-claude。
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

export interface RolloutTailerOptions {
  filePath: string
  /** 命中事件时回调（daemon 据此喂决策引擎） */
  onEvent: (event: JixuEvent, line: string) => void
  /** 每读到一行都回调（daemon 用作 watchdog 的活跃信号） */
  onLine?: (line: string) => void
  pollIntervalMs?: number
  /** true 时从文件头开始扫描；默认 false 只关注启动后新增的行 */
  fromStart?: boolean
}

/**
 * tail 单个 rollout 文件，新增行经 classifyRolloutLine 命中事件时回调 onEvent。
 * 处理文件被截断/轮转（size < pos 时重置到 0）。
 */
export class RolloutTailer {
  private readonly filePath: string
  private readonly onEvent: (event: JixuEvent, line: string) => void
  private readonly onLine: ((line: string) => void) | undefined
  private readonly pollIntervalMs: number
  private readonly decoder = new StringDecoder('utf8')
  private readonly scanner: LineScanner
  private pos = 0
  private watching = false

  constructor(opts: RolloutTailerOptions) {
    this.filePath = opts.filePath
    this.onEvent = opts.onEvent
    this.onLine = opts.onLine
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.scanner = createLineScanner((line) => {
      this.onLine?.(line)
      const event = classifyRolloutLine(line)
      if (event) this.onEvent(event, line)
    })
    if (!opts.fromStart) {
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
    this.poll()
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
      this.scanner.push(this.decoder.write(buf.subarray(0, bytesRead)))
    } finally {
      closeSync(fd)
    }
  }
}
