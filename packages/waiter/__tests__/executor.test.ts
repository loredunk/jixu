import { describe, test, expect } from 'vitest'
import type { Decision } from '@jixu/core'
import { executeDecision } from '../src/executor'
import { makeMockAdapter } from './helpers'

describe('executeDecision()', () => {
  test('sleep → 等到 until 后 headless resume，resumed', async () => {
    const adapter = makeMockAdapter()
    const slept: number[] = []
    const decision: Decision = { action: 'sleep', until: 5_000, then: 'resume' }
    const result = await executeDecision(decision, { sessionId: 'S' }, {
      adapter,
      now: () => 1_000,
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    expect(slept).toEqual([4_000]) // until - now
    expect(adapter.calls.resume).toEqual([{ mode: 'headless', sessionId: 'S' }])
    expect(result).toEqual({ resumed: true, stopped: false })
  })

  test('sleep 的 until 已过 → 等 0ms', async () => {
    const adapter = makeMockAdapter()
    const slept: number[] = []
    await executeDecision({ action: 'sleep', until: 500, then: 'resume' }, { sessionId: 'S' }, {
      adapter,
      now: () => 1_000,
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    expect(slept).toEqual([0])
  })

  test('backoff_resume → 等 delayMs 后 resume', async () => {
    const adapter = makeMockAdapter()
    const slept: number[] = []
    const result = await executeDecision({ action: 'backoff_resume', delayMs: 8_000 }, { sessionId: 'S' }, {
      adapter,
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    expect(slept).toEqual([8_000])
    expect(adapter.calls.resume).toHaveLength(1)
    expect(result.resumed).toBe(true)
  })

  test('kill_resume 带 pid → 先 kill 再 resume', async () => {
    const adapter = makeMockAdapter()
    const result = await executeDecision({ action: 'kill_resume' }, { sessionId: 'S', pid: 4242 }, {
      adapter,
      sleep: async () => {},
    })
    expect(adapter.calls.kill).toEqual([4242])
    expect(adapter.calls.resume).toEqual([{ mode: 'headless', sessionId: 'S' }])
    expect(result.resumed).toBe(true)
  })

  test('kill_resume 无 pid → 跳过 kill，仍 resume', async () => {
    const adapter = makeMockAdapter()
    await executeDecision({ action: 'kill_resume' }, { sessionId: 'S' }, { adapter })
    expect(adapter.calls.kill).toEqual([])
    expect(adapter.calls.resume).toHaveLength(1)
  })

  test('stop → 不 resume，返回 stopReason', async () => {
    const adapter = makeMockAdapter()
    const result = await executeDecision(
      { action: 'stop', reason: 'guard_exceeded' },
      { sessionId: 'S' },
      { adapter },
    )
    expect(adapter.calls.resume).toEqual([])
    expect(result).toEqual({ resumed: false, stopped: true, stopReason: 'guard_exceeded' })
  })

  test('noop → 什么都不做', async () => {
    const adapter = makeMockAdapter()
    const result = await executeDecision({ action: 'noop' }, { sessionId: 'S' }, { adapter })
    expect(adapter.calls.resume).toEqual([])
    expect(adapter.calls.kill).toEqual([])
    expect(result).toEqual({ resumed: false, stopped: false })
  })
})
