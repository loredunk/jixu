import { describe, test, expect } from 'vitest'
import {
  Supervisor,
  createContinueNudger,
  type SupervisorIo,
  type SupervisedPty,
  type UsageLike,
} from '../src/supervisor'

/** 手动可控的定时器：去抖会 clear+set，故任意时刻只有一个 live */
function timerHarness(): {
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (h: unknown) => void
  fire: () => void
  hasLive: () => boolean
} {
  let live: (() => void) | undefined
  return {
    setTimer: (fn) => {
      live = fn
      return {}
    },
    clearTimer: () => {
      live = undefined
    },
    fire: () => {
      const f = live
      live = undefined
      f?.()
    },
    hasLive: () => live !== undefined,
  }
}

type LaunchFn = (sessionId: string, resume: boolean, size: { cols: number; rows: number }) => SupervisedPty

const NOW = 1_000_000

/** 记录 status/write 的假 io */
function fakeIo(): SupervisorIo & { statuses: string[]; output: string } {
  const state = { statuses: [] as string[], output: '' }
  return {
    statuses: state.statuses,
    get output() {
      return state.output
    },
    write(d) {
      state.output += d
    },
    status(m) {
      state.statuses.push(m)
    },
    onUserInput() {},
    onResize() {},
    size: () => ({ cols: 80, rows: 30 }),
  }
}

interface Script {
  lines: string[]
  exitCode: number
}

/**
 * 脚本化 launch：每次启动按脚本异步 emit 行、然后（若没被 kill）退出。
 * 命中错误行时 supervisor 会 kill → 立即触发退出。
 * 配合 instant sleep + 常量 now，run() 自驱动到结束。
 */
function scriptedLaunch(scripts: Script[]): {
  launch: LaunchFn
  launches: Array<{ sessionId: string; resume: boolean }>
} {
  const launches: Array<{ sessionId: string; resume: boolean }> = []
  let i = 0
  const launch: LaunchFn = (sessionId, resume) => {
    launches.push({ sessionId, resume })
    const script = scripts[Math.min(i, scripts.length - 1)] as Script
    i++
    let dataCb: ((d: string) => void) | undefined
    let exitCb: ((e: { exitCode: number }) => void) | undefined
    let exited = false
    let killed = false
    const fireExit = (code: number): void => {
      if (!exited) {
        exited = true
        exitCb?.({ exitCode: code })
      }
    }
    setImmediate(() => {
      for (const l of script.lines) dataCb?.(l + '\n')
      if (!killed) fireExit(script.exitCode)
    })
    return {
      onData: (cb) => {
        dataCb = cb
      },
      onExit: (cb) => {
        exitCb = cb
      },
      write: () => {},
      resize: () => {},
      kill: () => {
        killed = true
        fireExit(script.exitCode)
      },
    }
  }
  return { launch, launches }
}

function makeSupervisor(
  scripts: Script[],
  opts: { maxRetries?: number; usage?: () => Promise<UsageLike> } = {},
): { run: () => Promise<number>; io: ReturnType<typeof fakeIo>; launches: Array<{ sessionId: string; resume: boolean }> } {
  const io = fakeIo()
  const { launch, launches } = scriptedLaunch(scripts)
  const sup = new Supervisor({
    launch,
    io,
    sleep: () => Promise.resolve(),
    now: () => NOW,
    newSessionId: () => 'S',
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.usage ? { usage: opts.usage } : {}),
  })
  return { run: () => sup.run(), io, launches }
}

describe('Supervisor.run()', () => {
  test('正常会话：fresh 启动，干净退出 → 返回 0，只启动一次', async () => {
    const { run, launches } = makeSupervisor([{ lines: ['> hi', 'done'], exitCode: 0 }])
    expect(await run()).toBe(0)
    expect(launches).toEqual([{ sessionId: 'S', resume: false }])
  })

  test('overloaded → 同窗口自动续接（--resume），再干净退出', async () => {
    const { run, io, launches } = makeSupervisor([
      { lines: ['working', 'API Error: Overloaded'], exitCode: 1 },
      { lines: ['recovered', 'ok'], exitCode: 0 },
    ])
    expect(await run()).toBe(0)
    expect(launches).toEqual([
      { sessionId: 'S', resume: false }, // 首次
      { sessionId: 'S', resume: true }, // 自动续接
    ])
    expect(io.statuses.join(' ')).toMatch(/API 错误\(overloaded\).*续接/)
  })

  test('连续失败超过 maxRetries → 停手返回 1', async () => {
    const { run, io, launches } = makeSupervisor([{ lines: ['read ECONNRESET'], exitCode: 1 }], {
      maxRetries: 2,
    })
    expect(await run()).toBe(1)
    expect(launches).toHaveLength(3) // 首次 + 续 2 次后第 3 次决策 guard_exceeded
    expect(io.statuses.join(' ')).toMatch(/停手/)
  })

  test('非零退出但无可识别错误 → 当作可重启续接', async () => {
    const { run, launches } = makeSupervisor([
      { lines: ['crash'], exitCode: 137 },
      { lines: ['ok'], exitCode: 0 },
    ])
    expect(await run()).toBe(0)
    expect(launches.map((l) => l.resume)).toEqual([false, true])
  })

  test('rate limit 无 resets_at → 调 usage 补，再 sleep 续接', async () => {
    let usageCalls = 0
    const { run, io, launches } = makeSupervisor(
      [
        { lines: ['hit the rate limit'], exitCode: 1 },
        { lines: ['ok'], exitCode: 0 },
      ],
      {
        usage: async () => {
          usageCalls++
          return { fiveHour: { resets_at: NOW + 5_000 } }
        },
      },
    )
    expect(await run()).toBe(0)
    expect(usageCalls).toBe(1)
    expect(launches.map((l) => l.resume)).toEqual([false, true])
    expect(io.statuses.join(' ')).toMatch(/限额.*续接/)
  })
})

// ── createContinueNudger ─────────────────────────────────────────────────────
describe('createContinueNudger()', () => {
  function setup(prompt = '继续') {
    const writes: string[] = []
    const timers = timerHarness()
    const nudger = createContinueNudger({
      write: (d) => writes.push(d),
      prompt,
      quietMs: 800,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    return { writes, timers, nudger }
  }

  test('安静到点 → 注入一次 prompt + 回车', () => {
    const { writes, timers, nudger } = setup()
    nudger.bump()
    timers.fire()
    expect(writes).toEqual(['继续\r'])
  })

  test('去抖：连续 bump 只有最后一个计时器生效，仍只注入一次', () => {
    const { writes, timers, nudger } = setup()
    nudger.bump()
    nudger.bump()
    nudger.bump()
    timers.fire()
    expect(writes).toEqual(['继续\r'])
  })

  test('注入后再 bump 不会二次注入', () => {
    const { writes, timers, nudger } = setup()
    nudger.bump()
    timers.fire()
    nudger.bump()
    timers.fire()
    expect(writes).toEqual(['继续\r'])
  })

  test('cancel 后到点不注入', () => {
    const { writes, timers, nudger } = setup()
    nudger.bump()
    nudger.cancel()
    timers.fire()
    expect(writes).toEqual([])
    expect(timers.hasLive()).toBe(false)
  })

  test('prompt 为空串 → 禁用，不武装、不注入', () => {
    const { writes, timers, nudger } = setup('')
    nudger.bump()
    expect(timers.hasLive()).toBe(false)
    timers.fire()
    expect(writes).toEqual([])
  })
})
