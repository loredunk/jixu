import { describe, test, expect } from 'vitest'
import {
  Supervisor,
  createContinueNudger,
  type SupervisorIo,
  type SupervisedPty,
  type UsageLike,
} from '../src/supervisor'

/** 手动可控的定时器：支持多个并存（nudge + stall），按 ms 触发指定的那个 */
function timerHarness(): {
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (h: unknown) => void
  fire: () => void
  fireMs: (ms: number) => void
  hasLive: () => boolean
} {
  const live = new Map<number, { fn: () => void; ms: number }>()
  let id = 0
  return {
    setTimer: (fn, ms) => {
      const i = ++id
      live.set(i, { fn, ms })
      return i
    },
    clearTimer: (h) => {
      live.delete(h as number)
    },
    fire: () => {
      for (const [i, t] of [...live]) {
        live.delete(i)
        t.fn()
      }
    },
    fireMs: (ms) => {
      for (const [i, t] of [...live]) {
        if (t.ms === ms) {
          live.delete(i)
          t.fn()
        }
      }
    },
    hasLive: () => live.size > 0,
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

  test('静默挂起：长时间无输出 → 判定 Stalled → kill 重启续接', async () => {
    const launches: Array<{ resume: boolean }> = []
    const timers = timerHarness()
    const launch: LaunchFn = (_sid, resume) => {
      launches.push({ resume })
      let dataCb: ((d: string) => void) | undefined
      let exitCb: ((e: { exitCode: number }) => void) | undefined
      if (launches.length === 1) {
        // fresh：吐一行后静默挂起，不退出；被 kill 才退出
        setImmediate(() => dataCb?.('thinking...\n'))
        return {
          onData: (cb) => void (dataCb = cb),
          onExit: (cb) => void (exitCb = cb),
          write: () => {},
          resize: () => {},
          kill: () => exitCb?.({ exitCode: 143 }),
        }
      }
      // resume：正常跑完
      setImmediate(() => {
        dataCb?.('ok\n')
        exitCb?.({ exitCode: 0 })
      })
      return {
        onData: (cb) => void (dataCb = cb),
        onExit: (cb) => void (exitCb = cb),
        write: () => {},
        resize: () => {},
        kill: () => exitCb?.({ exitCode: 0 }),
      }
    }
    const io = fakeIo()
    const sup = new Supervisor({
      launch,
      io,
      sleep: () => Promise.resolve(),
      now: () => NOW,
      newSessionId: () => 'S',
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      stallMs: 5_000,
      continuePrompt: '', // 关掉「继续」注入，隔离停滞计时
    })
    const p = sup.run()
    await new Promise((r) => setImmediate(r)) // 等 fresh 启动 emit
    timers.fireMs(5_000) // 触发停滞看门狗
    expect(await p).toBe(0)
    expect(launches.map((l) => l.resume)).toEqual([false, true])
    expect(io.statuses.join(' ')).toMatch(/停滞.*续接/)
  })
})

// ── 同会话试探（ConnDead 混合续接） ──────────────────────────────────────────
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/** 可控 launch：检测后不自动退出、捕获 write、可手动 emit/exit（驱动试探流程） */
function controllableLaunch(): {
  launch: LaunchFn
  launches: Array<{ resume: boolean }>
  writes: string[]
  emit: (line: string) => void
  exit: (code: number) => void
  killed: () => boolean
} {
  const launches: Array<{ resume: boolean }> = []
  const writes: string[] = []
  let dataCb: ((d: string) => void) | undefined
  let exitCb: ((e: { exitCode: number }) => void) | undefined
  let wasKilled = false
  const launch: LaunchFn = (_sid, resume) => {
    launches.push({ resume })
    dataCb = undefined
    exitCb = undefined
    wasKilled = false
    return {
      onData: (cb) => void (dataCb = cb),
      onExit: (cb) => void (exitCb = cb),
      write: (d) => void writes.push(d),
      resize: () => {},
      kill: () => {
        wasKilled = true
        exitCb?.({ exitCode: 143 })
      },
    }
  }
  return {
    launch,
    launches,
    writes,
    emit: (line) => dataCb?.(line.endsWith('\n') ? line : line + '\n'),
    exit: (code) => exitCb?.({ exitCode: code }),
    killed: () => wasKilled,
  }
}

function makeProbeSupervisor(ctrl: ReturnType<typeof controllableLaunch>): {
  run: () => Promise<number>
  io: ReturnType<typeof fakeIo>
  timers: ReturnType<typeof timerHarness>
  logs: string[]
} {
  const io = fakeIo()
  const timers = timerHarness()
  const logs: string[] = []
  const sup = new Supervisor({
    launch: ctrl.launch,
    io,
    sleep: () => Promise.resolve(),
    now: () => NOW,
    newSessionId: () => 'S',
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    nudgeQuietMs: 800,
    probeEscalateMs: 8_000,
    stallMs: 100_000, // 高到不在用例里触发
    logger: (m) => logs.push(m),
  })
  return { run: () => sup.run(), io, timers, logs }
}

const NET_ERR = 'API Error: Unable to connect to API (ConnectionRefused)'

describe('Supervisor 同会话试探（ConnDead）', () => {
  test('检测到 ConnDead → 同会话注入「继续」、不重启；窗口内无报错 → 恢复', async () => {
    const ctrl = controllableLaunch()
    const { run, io, timers, logs } = makeProbeSupervisor(ctrl)
    const p = run()
    await tick() // 等 fresh 启动
    ctrl.emit(NET_ERR) // 命中 ConnDead → 进入试探
    timers.fireMs(800) // 试探去抖到点 → 注入「继续」

    expect(ctrl.writes).toEqual(['继续\r']) // 向当前会话补发了一次
    expect(ctrl.killed()).toBe(false) // 没有 kill
    expect(ctrl.launches).toHaveLength(1) // 没有重启
    expect(io.statuses.join(' ')).toMatch(/补发「继续」试探/)

    timers.fireMs(8_000) // 恢复观察窗口到点 → 判定恢复
    expect(logs.join('\n')).toMatch(/试探成功/)

    ctrl.exit(0) // 会话随后正常结束
    expect(await p).toBe(0)
    expect(ctrl.launches).toHaveLength(1) // 全程只启动一次
  })

  test('试探后再报错 → 升级 kill 重启，并在新进程注入「继续」', async () => {
    const ctrl = controllableLaunch()
    const { run, timers, logs } = makeProbeSupervisor(ctrl)
    const p = run()
    await tick()
    ctrl.emit(NET_ERR) // 进入试探
    timers.fireMs(800) // 注入试探「继续」
    expect(ctrl.writes).toEqual(['继续\r'])

    ctrl.emit(NET_ERR) // 试探后又报错 → escalate → kill → onExit → 决策 kill_resume
    await tick() // 等 run() 循环起新进程（resume=true）
    expect(ctrl.launches.map((l) => l.resume)).toEqual([false, true])

    timers.fireMs(800) // 新进程续接就绪 → 注入「继续」
    expect(ctrl.writes).toEqual(['继续\r', '继续\r']) // 试探 + 续接各一次
    expect(logs.join('\n')).toMatch(/试探无效/)

    ctrl.exit(0)
    expect(await p).toBe(0)
  })

  test('continuePrompt 为空 → 禁用试探，ConnDead 直接 kill 重启', async () => {
    const ctrl = controllableLaunch()
    const io = fakeIo()
    const timers = timerHarness()
    const sup = new Supervisor({
      launch: ctrl.launch,
      io,
      sleep: () => Promise.resolve(),
      now: () => NOW,
      newSessionId: () => 'S',
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      continuePrompt: '', // 关掉「继续」=> 关掉试探
      stallMs: 100_000,
    })
    const p = sup.run()
    await tick()
    ctrl.emit(NET_ERR) // 试探禁用 → 直接 kill
    expect(ctrl.killed()).toBe(true)
    await tick()
    expect(ctrl.launches.map((l) => l.resume)).toEqual([false, true]) // 直接重启续接
    ctrl.exit(0)
    expect(await p).toBe(0)
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
