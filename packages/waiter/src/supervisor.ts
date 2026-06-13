import {
  decide,
  freshGuardState,
  guardIncrement,
  guardReset,
  type GuardState,
  type JixuEvent,
} from '@jixu/core'
import { createLineScanner, classifyStreamLine } from '@jixu/adapter-claude'

/**
 * `jixu run` 的前台托管核心（M3）。
 *
 * jixu 用 PTY 在用户当前终端里启动 Claude Code：输出转发给用户、用户输入转发给
 * CC（看起来就是普通 claude 会话）。同时扫描输出流，命中中断时按决策引擎在
 * **同一个窗口里**自动续接，连续失败超限则停手。
 *
 * 循环逻辑（launch→监控→决策→续接）可注入 launch/io/clock 单测；终端裸模式、
 * stdin 透传、SIGWINCH 等真实 IO 留在 cmdRun 的薄封装里。
 */

export interface SupervisorIo {
  /** CC 输出 → 用户 stdout */
  write(data: string): void
  /** jixu 自己的状态行（与 CC 输出区分） */
  status(msg: string): void
  /** 用户 stdin → 当前 PTY（只注册一次，路由到当前进程） */
  onUserInput(cb: (data: string) => void): void
  /** 终端尺寸变化 → 当前 PTY */
  onResize(cb: (cols: number, rows: number) => void): void
  size(): { cols: number; rows: number }
}

export interface SupervisedPty {
  onData(cb: (d: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(d: string): void
  resize(c: number, r: number): void
  kill(): void
}

export interface UsageLike {
  fiveHour?: { resets_at: number }
  sevenDay?: { resets_at: number }
}

export interface SupervisorDeps {
  launch: (sessionId: string, resume: boolean, size: { cols: number; rows: number }) => SupervisedPty
  io: SupervisorIo
  /** RateLimited 无 resets_at 时用它补（通常接 adapter.usage） */
  usage?: () => Promise<UsageLike>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  newSessionId?: () => string
  maxRetries?: number
  /** 健康运行超过此时长后清零失败计数（视为已恢复），默认 60s */
  recoverMs?: number
}

type Outcome =
  | { kind: 'clean'; exitCode: number }
  | { kind: 'fail'; event: JixuEvent; exitCode: number }

export class Supervisor {
  private readonly deps: SupervisorDeps
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly recoverMs: number
  private current: SupervisedPty | undefined

  constructor(deps: SupervisorDeps) {
    this.deps = deps
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.now = deps.now ?? Date.now
    this.recoverMs = deps.recoverMs ?? 60_000
  }

  /** 跑到 CC 正常退出（返回其退出码）或停手（返回 1）。 */
  async run(): Promise<number> {
    const sessionId = (this.deps.newSessionId ?? (() => 'jixu-session'))()
    // stdin / resize 只注册一次，始终路由到当前 PTY
    this.deps.io.onUserInput((d) => this.current?.write(d))
    this.deps.io.onResize((c, r) => this.current?.resize(c, r))

    let guard: GuardState = freshGuardState()
    let resume = false

    for (;;) {
      const start = this.now()
      const outcome = await this.runOnce(sessionId, resume)
      const ranMs = this.now() - start

      if (outcome.kind === 'clean') return outcome.exitCode // 用户正常退出

      // 健康运行足够久才失败 → 视为已恢复，之前的失败计数清零
      if (ranMs >= this.recoverMs) guard = guardReset(guard, sessionId)

      const event = await this.enrich(outcome.event)
      const decision = decide(event, sessionId, guard, this.maxRetriesOpt())

      switch (decision.action) {
        case 'stop':
          if (decision.reason === 'turn_ended') return 0
          this.deps.io.status(
            decision.reason === 'guard_exceeded'
              ? '连续自动续接已达上限，停手。请手动检查后再 jixu run。'
              : `遇到不可自动恢复的错误（${describe(event)}），停手。`,
          )
          return 1
        case 'sleep': {
          const waitMs = Math.max(decision.until - this.now(), 0)
          this.deps.io.status(`检测到限额，${fmtMs(waitMs)} 后在本窗口自动续接…`)
          await this.sleep(waitMs)
          break
        }
        case 'backoff_resume':
          this.deps.io.status(`${describe(event)}，${fmtMs(decision.delayMs)} 后自动续接…`)
          await this.sleep(decision.delayMs)
          break
        case 'kill_resume':
          this.deps.io.status(`${describe(event)}，立即重启并续接…`)
          break
        case 'noop':
        default:
          return 0
      }

      guard = guardIncrement(guard, sessionId)
      resume = true
    }
  }

  /** 启动一次 CC，转发 IO，扫描输出；返回本次的结局（正常退出 / 失败事件）。 */
  private runOnce(sessionId: string, resume: boolean): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      const handle = this.deps.launch(sessionId, resume, this.deps.io.size())
      this.current = handle

      let detected: JixuEvent | null = null
      const scanner = createLineScanner((line) => {
        if (detected) return
        const ev = classifyStreamLine(line)
        if (ev) {
          detected = ev
          // 命中中断：CC 可能仍挂着，主动 kill 触发干净重启（ADR-006）
          handle.kill()
        }
      })

      handle.onData((d) => {
        this.deps.io.write(d)
        scanner.push(d)
      })
      handle.onExit(({ exitCode }) => {
        this.current = undefined
        if (detected) resolve({ kind: 'fail', event: detected, exitCode })
        else if (exitCode === 0) resolve({ kind: 'clean', exitCode })
        else resolve({ kind: 'fail', event: { type: 'ConnDead', raw: `claude 退出码 ${exitCode}` }, exitCode })
      })
    })
  }

  /** RateLimited 无 resets_at → 调 usage API 补；其余原样返回 */
  private async enrich(event: JixuEvent): Promise<JixuEvent> {
    if (event.type !== 'RateLimited' || event.resets_at !== undefined || !this.deps.usage) {
      return event
    }
    try {
      const usage = await this.deps.usage()
      const resets_at = usage.fiveHour?.resets_at ?? usage.sevenDay?.resets_at
      if (resets_at !== undefined) {
        return event.raw !== undefined
          ? { type: 'RateLimited', resets_at, raw: event.raw }
          : { type: 'RateLimited', resets_at }
      }
    } catch {
      // usage 失败 → 维持无 resets_at，决策引擎走退避
    }
    return event
  }

  private maxRetriesOpt(): { maxRetries?: number } {
    return this.deps.maxRetries !== undefined ? { maxRetries: this.deps.maxRetries } : {}
  }
}

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`
}

function describe(event: JixuEvent): string {
  switch (event.type) {
    case 'RateLimited':
      return '速率限制'
    case 'ConnDead':
      return '连接中断'
    case 'Stalled':
      return '会话停滞'
    case 'ApiError':
      return `API 错误(${event.reason})`
    case 'TurnEnded':
      return '回合结束'
  }
}
