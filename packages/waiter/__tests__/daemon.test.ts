import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon'
import { readState } from '../src/state'
import { stateFilePath } from '../src/paths'
import { makeMockAdapter, instantSleep, type MockAdapter } from './helpers'

const NOW = 1_000_000

const created: string[] = []
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(maxRetries?: number): { daemon: Daemon; adapter: MockAdapter; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'jixu-daemon-'))
  created.push(home)
  const adapter = makeMockAdapter()
  const daemon = new Daemon({
    adapter,
    home,
    now: () => NOW,
    sleep: instantSleep,
    logDir: join(home, 'no-such-logs'), // 弱通道不可用
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  })
  return { daemon, adapter, home }
}

const counts = (home: string): Record<string, number> =>
  readState(stateFilePath(home))?.guardCounts ?? {}
const halted = (home: string): string[] => readState(stateFilePath(home))?.haltedSessions ?? []

describe('Daemon.handleEvent()', () => {
  test('RateLimited(有 resets_at) → headless resume，guard+1', async () => {
    const { daemon, adapter, home } = setup()
    await daemon.handleEvent({ type: 'RateLimited', resets_at: NOW + 10_000 }, 'S')
    expect(adapter.calls.resume).toEqual([{ mode: 'headless', sessionId: 'S' }])
    expect(counts(home)['S']).toBe(1)
  })

  test('ConnDead 带 pid → kill 后 resume，guard+1', async () => {
    const { daemon, adapter, home } = setup()
    await daemon.handleEvent({ type: 'ConnDead' }, 'S', 8888)
    expect(adapter.calls.kill).toEqual([8888])
    expect(adapter.calls.resume).toHaveLength(1)
    expect(counts(home)['S']).toBe(1)
  })

  test('连续失败超过 maxRetries → 停手（halt），后续事件被忽略', async () => {
    const { daemon, adapter, home } = setup(2)
    await daemon.handleEvent({ type: 'ConnDead' }, 'S', 1)
    await daemon.handleEvent({ type: 'ConnDead' }, 'S', 1)
    await daemon.handleEvent({ type: 'ConnDead' }, 'S', 1) // 此次 guard_exceeded
    expect(adapter.calls.resume).toHaveLength(2) // 只续了两次
    expect(halted(home)).toContain('S')

    // halt 后再来事件不触发任何动作
    await daemon.handleEvent({ type: 'ConnDead' }, 'S', 1)
    expect(adapter.calls.resume).toHaveLength(2)
  })

  test('TurnEnded → guard 清零，不 resume', async () => {
    const { daemon, adapter, home } = setup()
    await daemon.handleEvent({ type: 'ConnDead' }, 'S', 1) // guard → 1
    expect(counts(home)['S']).toBe(1)
    await daemon.handleEvent({ type: 'TurnEnded', sessionId: 'S' }, 'S')
    expect(counts(home)['S']).toBeUndefined() // 清零
    expect(adapter.calls.resume).toHaveLength(1) // TurnEnded 不触发 resume
  })

  test('FATAL（auth_failed）→ 停手，不 resume', async () => {
    const { daemon, adapter, home } = setup()
    await daemon.handleEvent({ type: 'ApiError', reason: 'auth_failed' }, 'S')
    expect(adapter.calls.resume).toEqual([])
    expect(halted(home)).toContain('S')
  })
})
