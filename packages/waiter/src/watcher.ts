import { watch, readFileSync, rmSync, mkdirSync, readdirSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { DiskJobFile, JixuEvent } from '@jixu/core'
import { classifyHookPayload } from '@jixu/adapter-claude'

/**
 * 监听 job 文件目录（ADR-003 的唯一 hook→waiter 通道）。
 * 把磁盘上的两种形态（强通道 rawPayload / 弱通道 event）归一化为 NormalizedJob，
 * 并按 ADR-004 去重（同 session 不重复处理更旧/同时刻的事件）。
 *
 * 解析与去重是纯逻辑（normalizeJob / JobDedup），fs.watch 部分薄封装。
 */

export interface NormalizedJob {
  event: JixuEvent
  sessionId: string
  pid?: number
  timestamp: number
}

export const JOB_FILE_SUFFIX = '.job.json'

/** 把磁盘 job 文件归一化为带 event 的 NormalizedJob；无法识别返回 null */
export function normalizeJob(disk: unknown): NormalizedJob | null {
  if (typeof disk !== 'object' || disk === null) return null
  const obj = disk as Record<string, unknown>

  const sessionId = obj['sessionId']
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null

  const timestamp = typeof obj['timestamp'] === 'number' ? obj['timestamp'] : Date.now()
  const pid = typeof obj['pid'] === 'number' && obj['pid'] > 0 ? obj['pid'] : undefined

  // 弱通道：已分类，直接带 event
  if ('event' in obj && obj['event'] && typeof obj['event'] === 'object') {
    const event = obj['event'] as JixuEvent
    if (typeof event.type !== 'string') return null
    return build(event, sessionId, timestamp, pid)
  }

  // 强通道（hook）：rawPayload 未分类，交给 classifyHookPayload
  if ('rawPayload' in obj) {
    const rp = obj['rawPayload']
    const raw = typeof rp === 'string' ? rp : JSON.stringify(rp)
    const event = classifyHookPayload(raw)
    if (!event) return null
    return build(event, sessionId, timestamp, pid)
  }

  return null
}

function build(
  event: JixuEvent,
  sessionId: string,
  timestamp: number,
  pid: number | undefined,
): NormalizedJob {
  // exactOptionalPropertyTypes：pid 缺失时不写该键
  return pid !== undefined ? { event, sessionId, timestamp, pid } : { event, sessionId, timestamp }
}

export function parseJobFileContent(content: string): NormalizedJob | null {
  let parsed: DiskJobFile
  try {
    parsed = JSON.parse(content) as DiskJobFile
  } catch {
    return null
  }
  return normalizeJob(parsed)
}

/**
 * 按 sessionId 去重：只接受比上次已处理时间戳更新的事件。
 * 两通道对同一 session 同一时刻产出时，先到先得，后到的（更旧或同时刻）被丢弃。
 */
export class JobDedup {
  private readonly last = new Map<string, number>()

  isDuplicate(job: NormalizedJob): boolean {
    const prev = this.last.get(job.sessionId)
    return prev !== undefined && job.timestamp <= prev
  }

  mark(job: NormalizedJob): void {
    this.last.set(job.sessionId, job.timestamp)
  }
}

export interface JobWatcherOptions {
  jobsDir: string
  onJob: (job: NormalizedJob) => void | Promise<void>
  /** 处理后是否删除 job 文件，默认 true */
  consume?: boolean
  onError?: (err: unknown, file: string) => void
}

export class JobWatcher {
  private readonly opts: JobWatcherOptions
  private readonly dedup = new JobDedup()
  private fsw: FSWatcher | undefined

  constructor(opts: JobWatcherOptions) {
    this.opts = opts
  }

  start(): void {
    mkdirSync(this.opts.jobsDir, { recursive: true })
    // 先处理启动前积压的 job 文件
    for (const name of this.safeReaddir()) {
      if (name.endsWith(JOB_FILE_SUFFIX)) void this.handleFile(join(this.opts.jobsDir, name))
    }
    this.fsw = watch(this.opts.jobsDir, (_evt, filename) => {
      if (filename && filename.endsWith(JOB_FILE_SUFFIX)) {
        void this.handleFile(join(this.opts.jobsDir, filename))
      }
    })
  }

  stop(): void {
    this.fsw?.close()
    this.fsw = undefined
  }

  /** 读取、解析、去重、回调、消费单个 job 文件。供单测直接调用。 */
  async handleFile(path: string): Promise<void> {
    let content: string
    try {
      content = readFileSync(path, 'utf-8')
    } catch {
      return // 文件正在写 / 已被删，fs.watch 常重复触发，忽略
    }

    const job = parseJobFileContent(content)
    if (!job) {
      this.consume(path)
      return
    }
    if (this.dedup.isDuplicate(job)) {
      this.consume(path)
      return
    }
    this.dedup.mark(job)

    try {
      await this.opts.onJob(job)
    } catch (err) {
      this.opts.onError?.(err, path)
    } finally {
      this.consume(path)
    }
  }

  private consume(path: string): void {
    if (this.opts.consume === false) return
    try {
      rmSync(path, { force: true })
    } catch {
      /* ignore */
    }
  }

  private safeReaddir(): string[] {
    try {
      return readdirSync(this.opts.jobsDir)
    } catch {
      return []
    }
  }
}
