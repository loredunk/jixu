import type { Decision, IToolAdapter, StopReason } from '@jixu/core'
import type { Logger } from './log.js'

/**
 * 把决策引擎的 Decision 落地为对 adapter 的实际调用。
 * sleep / 退避用注入的 sleep()，便于单测不真实等待。
 * guard 计数更新由调用方（daemon）根据返回结果处理。
 */

export interface ExecuteContext {
  sessionId: string
  pid?: number
}

export interface ExecutorDeps {
  adapter: IToolAdapter
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: Logger
}

export interface ExecResult {
  /** 是否触发了 resume（daemon 据此 guardIncrement） */
  resumed: boolean
  /** 是否决定停手 */
  stopped: boolean
  stopReason?: StopReason
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * resume 失败（如 claude 进程非零退出）只记日志、不抛出：
 * 这一次仍算一次「续接尝试」，由 guard 计数兜底，避免对坏掉的会话无限重试。
 */
async function tryResume(
  adapter: IToolAdapter,
  sessionId: string,
  log: Logger,
): Promise<void> {
  try {
    await adapter.resume('headless', sessionId)
  } catch (err) {
    log(`[${sessionId}] resume 失败：${String(err)}`)
  }
}

export async function executeDecision(
  decision: Decision,
  ctx: ExecuteContext,
  deps: ExecutorDeps,
): Promise<ExecResult> {
  const sleep = deps.sleep ?? realSleep
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const { adapter } = deps

  switch (decision.action) {
    case 'sleep': {
      const waitMs = Math.max(decision.until - now(), 0)
      log(`[${ctx.sessionId}] sleep ${Math.round(waitMs / 1000)}s 后 resume（限额重置）`)
      await sleep(waitMs)
      await tryResume(adapter, ctx.sessionId, log)
      return { resumed: true, stopped: false }
    }

    case 'backoff_resume': {
      log(`[${ctx.sessionId}] 退避 ${Math.round(decision.delayMs / 1000)}s 后 resume`)
      await sleep(decision.delayMs)
      await tryResume(adapter, ctx.sessionId, log)
      return { resumed: true, stopped: false }
    }

    case 'kill_resume': {
      // ADR-006：死连接/停滞必须先 kill 原进程再起新进程
      if (ctx.pid !== undefined) {
        log(`[${ctx.sessionId}] kill pid ${ctx.pid} 后新进程 resume`)
        try {
          await adapter.kill(ctx.pid)
        } catch (err) {
          log(`[${ctx.sessionId}] kill 失败：${String(err)}`)
        }
      } else {
        log(`[${ctx.sessionId}] 无 pid，跳过 kill 直接 resume`)
      }
      await tryResume(adapter, ctx.sessionId, log)
      return { resumed: true, stopped: false }
    }

    case 'stop': {
      log(`[${ctx.sessionId}] stop（${decision.reason}）`)
      return { resumed: false, stopped: true, stopReason: decision.reason }
    }

    case 'noop':
    default:
      return { resumed: false, stopped: false }
  }
}
