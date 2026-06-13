import { describe, test, expect } from 'vitest'
import { Watchdog } from '../src/watchdog'

describe('Watchdog', () => {
  test('未超时不算停滞', () => {
    let now = 1_000
    const wd = new Watchdog({ now: () => now, timeoutMs: 100 })
    wd.record('S')
    now = 1_050 // 50ms < 100ms
    expect(wd.stalled()).toEqual([])
  })

  test('超时算停滞', () => {
    let now = 1_000
    const wd = new Watchdog({ now: () => now, timeoutMs: 100 })
    wd.record('S')
    now = 1_200 // 200ms > 100ms
    expect(wd.stalled()).toEqual(['S'])
  })

  test('record 刷新活跃时间', () => {
    let now = 1_000
    const wd = new Watchdog({ now: () => now, timeoutMs: 100 })
    wd.record('S')
    now = 1_080
    wd.record('S') // 刷新
    now = 1_150 // 距上次 record 70ms < 100ms
    expect(wd.stalled()).toEqual([])
  })

  test('forget 后不再跟踪', () => {
    let now = 1_000
    const wd = new Watchdog({ now: () => now, timeoutMs: 100 })
    wd.record('S')
    wd.forget('S')
    now = 5_000
    expect(wd.stalled()).toEqual([])
    expect(wd.isTracking('S')).toBe(false)
  })

  test('多 session 独立判定', () => {
    let now = 1_000
    const wd = new Watchdog({ now: () => now, timeoutMs: 100 })
    wd.record('A')
    now = 1_080
    wd.record('B')
    now = 1_150 // A 距今 150ms 停滞；B 距今 70ms 未停滞
    expect(wd.stalled()).toEqual(['A'])
  })
})
