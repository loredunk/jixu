import { mkdirSync } from 'node:fs'
import {
  decide,
  freshGuardState,
  guardIncrement,
  guardReset,
  type GuardState,
  type JixuEvent,
  type IToolAdapter,
} from '@jixu/core'
import {
  ClaudeCodeAdapter,
  LogTailer,
  resolveLatestLog,
  defaultLogDir,
} from '@jixu/adapter-claude'
import { jobsDir, logFilePath, stateFilePath } from './paths.js'
import { JobWatcher } from './watcher.js'
import { Watchdog, DEFAULT_STALL_TIMEOUT_MS } from './watchdog.js'
import { executeDecision } from './executor.js'
import { createLogger, type Logger } from './log.js'
import { initialState, writeState, type WaiterState } from './state.js'

export interface DaemonOptions {
  adapter?: IToolAdapter
  home?: string
  maxRetries?: number
  stallTimeoutMs?: number
  /** 看门狗轮询间隔，默认 min(stallTimeout/4, 30s) */
  stallCheckMs?: number
  /** CC debug log 目录，默认 ~/.claude/logs（pending：真实路径待确认） */
  logDir?: string
  echoStderr?: boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Waiter 守护进程编排：把 watcher / log-tailer / watchdog 的事件汇流到
 * 决策引擎，再交 executor 落地，并维护 guard / halted / 状态文件。
 * 所有事件经 enqueue 串行处理，避免并发改 guardState。
 */
export class Daemon {
  private readonly adapter: IToolAdapter
  private readonly home: string | undefined
  private readonly maxRetries: number | undefined
  private readonly stallTimeoutMs: number
  private readonly stallCheckMs: number
  private readonly logDir: string
  private readonly now: () => number
  private readonly sleep: ((ms: number) => Promise<void>) | undefined
  private readonly log: Logger

  private guard: GuardState = freshGuardState()
  private readonly halted = new Set<string>()
  private readonly sessionPids = new Map<string, number>()
  private lastActiveSession: string | undefined
  private chain: Promise<void> = Promise.resolve()
  private state: WaiterState

  private watcher: JobWatcher
  private tailer: LogTailer | undefined
  private watchdog: Watchdog
  private stallTimer: ReturnType<typeof setInterval> | undefined

  constructor(opts: DaemonOptions = {}) {
    this.adapter = opts.adapter ?? new ClaudeCodeAdapter()
    this.home = opts.home
    this.maxRetries = opts.maxRetries
    this.stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
    this.stallCheckMs = opts.stallCheckMs ?? Math.min(Math.floor(this.stallTimeoutMs / 4), 30_000)
    this.logDir = opts.logDir ?? defaultLogDir(opts.home)
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep

    this.log = createLogger(logFilePath(this.home), opts.echoStderr ?? false)
    this.state = initialState(process.pid, jobsDir(this.home), this.now())

    this.watchdog = new Watchdog({ now: this.now, timeoutMs: this.stallTimeoutMs })
    this.watcher = new JobWatcher({
      jobsDir: jobsDir(this.home),
      onJob: (job) =>
        this.enqueue(() => this.handleEvent(job.event, job.sessionId, job.pid)),
      onError: (err) => this.log(`[watcher] 处理 job 出错：${String(err)}`),
    })
  }

  start(): void {
    mkdirSync(jobsDir(this.home), { recursive: true })
    this.flushState()
    this.log(`守护进程启动 pid=${process.pid} jobsDir=${jobsDir(this.home)}`)

    this.watcher.start()
    this.startLogTailer()

    this.stallTimer = setInterval(() => this.checkStalls(), this.stallCheckMs)
    this.stallTimer.unref?.()
  }

  async stop(): Promise<void> {
    this.watcher.stop()
    this.tailer?.stop()
    if (this.stallTimer) clearInterval(this.stallTimer)
    await this.chain // 等在途事件处理完
    this.log('守护进程停止')
  }

  /** 串行化所有事件处理，避免并发改 guardState；单个事件出错只记日志，不断链 */
  enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(() =>
      fn().catch((err: unknown) => this.log(`[handler] 事件处理出错：${String(err)}`)),
    )
    return this.chain
  }

  /** 处理单个归一化事件：决策 → 落地 → 更新 guard / halted / 状态。供单测调用。 */
  async handleEvent(event: JixuEvent, sessionId: string, pid?: number): Promise<void> {
    if (this.halted.has(sessionId)) {
      this.log(`[${sessionId}] 已 halt，忽略 ${event.type}`)
      return
    }
    if (pid !== undefined) this.sessionPids.set(sessionId, pid)
    this.watchdog.record(sessionId)
    this.lastActiveSession = sessionId

    const decision = decide(event, sessionId, this.guard, this.maxRetriesOpt())
    this.state.lastEventAt = this.now()
    this.state.lastDecision = `${event.type} → ${decision.action}`
    this.log(`[${sessionId}] ${event.type} → ${JSON.stringify(decision)}`)

    const result = await executeDecision(
      decision,
      pid !== undefined ? { sessionId, pid } : { sessionId },
      { adapter: this.adapter, log: this.log, ...(this.sleep ? { sleep: this.sleep } : {}), now: this.now },
    )

    if (result.resumed) {
      this.guard = guardIncrement(this.guard, sessionId)
    }
    if (result.stopped) {
      if (result.stopReason === 'turn_ended') {
        this.guard = guardReset(this.guard, sessionId)
        this.watchdog.forget(sessionId)
        this.sessionPids.delete(sessionId)
      } else {
        // guard_exceeded / fatal_error：停手并通知，不再自动处理该 session
        this.halt(sessionId, result.stopReason ?? 'fatal_error')
      }
    }

    this.flushState()
  }

  private halt(sessionId: string, reason: string): void {
    this.halted.add(sessionId)
    this.watchdog.forget(sessionId)
    this.log(`⚠️  [${sessionId}] 停手（${reason}）：需要人工介入，jixu 不再自动续接此会话`)
  }

  private maxRetriesOpt(): { maxRetries?: number } {
    return this.maxRetries !== undefined ? { maxRetries: this.maxRetries } : {}
  }

  /** 看门狗周期检查：对停滞 session 注入 Stalled 事件 */
  private checkStalls(): void {
    for (const sid of this.watchdog.stalled()) {
      if (this.halted.has(sid)) continue
      const pid = this.sessionPids.get(sid)
      this.log(`[${sid}] 停滞超过 ${Math.round(this.stallTimeoutMs / 1000)}s → Stalled`)
      void this.enqueue(() => this.handleEvent({ type: 'Stalled' }, sid, pid))
    }
  }

  /**
   * 弱通道：tail 最新 CC debug log。命中 ConnDead 时归因到「最近活跃的 session」
   * （pending：日志到 session 的精确映射待真实环境确认）。每行作为活跃信号。
   */
  private startLogTailer(): void {
    const file = resolveLatestLog(this.logDir)
    if (!file) {
      this.log(`未发现 CC debug log（${this.logDir}），弱通道暂不可用`)
      return
    }
    this.tailer = new LogTailer({
      filePath: file,
      onLine: () => {
        if (this.lastActiveSession) this.watchdog.record(this.lastActiveSession)
      },
      onEvent: (event) => {
        const sid = this.lastActiveSession
        if (!sid) {
          this.log(`log 命中 ${event.type} 但无活跃 session，无法归因，已忽略`)
          return
        }
        const pid = this.sessionPids.get(sid)
        void this.enqueue(() => this.handleEvent(event, sid, pid))
      },
    })
    this.tailer.start()
    this.log(`弱通道 tail：${file}`)
  }

  private flushState(): void {
    this.state.guardCounts = { ...this.guard.counts }
    this.state.haltedSessions = [...this.halted]
    try {
      writeState(stateFilePath(this.home), this.state)
    } catch {
      /* 状态写失败不影响运行 */
    }
  }
}
