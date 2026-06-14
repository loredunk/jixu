import { describe, test, expect } from 'vitest'
import { buildClaudeArgs, claudeBin, newSessionId, type PtySpawner, type PtyHandle } from '../src/pty'
import { classifyStreamLine } from '../src/classifier'
import { ClaudeCodeAdapter } from '../src/adapter'

// ── buildClaudeArgs ──────────────────────────────────────────────────────────
describe('buildClaudeArgs()', () => {
  test('fresh → --session-id', () => {
    expect(buildClaudeArgs({ sessionId: 'sid', resume: false })).toEqual(['--session-id', 'sid'])
  })
  test('resume → --resume', () => {
    expect(buildClaudeArgs({ sessionId: 'sid', resume: true })).toEqual(['--resume', 'sid'])
  })
  test('附加额外参数', () => {
    expect(buildClaudeArgs({ sessionId: 'sid', resume: true, extraArgs: ['--model', 'opus'] })).toEqual([
      '--resume',
      'sid',
      '--model',
      'opus',
    ])
  })
})

describe('claudeBin() / newSessionId()', () => {
  test('默认 claude，可被 JIXU_CLAUDE_BIN 覆盖', () => {
    const prev = process.env['JIXU_CLAUDE_BIN']
    delete process.env['JIXU_CLAUDE_BIN']
    expect(claudeBin()).toBe('claude')
    process.env['JIXU_CLAUDE_BIN'] = '/opt/claude'
    try {
      expect(claudeBin()).toBe('/opt/claude')
    } finally {
      if (prev === undefined) delete process.env['JIXU_CLAUDE_BIN']
      else process.env['JIXU_CLAUDE_BIN'] = prev
    }
  })
  test('newSessionId 返回 UUID', () => {
    expect(newSessionId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

// ── classifyStreamLine ───────────────────────────────────────────────────────
describe('classifyStreamLine()', () => {
  test('连接层错误（复用 classifyLogLine）→ ConnDead', () => {
    expect(classifyStreamLine('Error: read ECONNRESET')).toMatchObject({ type: 'ConnDead' })
  })
  test('overloaded → ApiError{overloaded}', () => {
    expect(classifyStreamLine('API Error: 529 Overloaded')).toMatchObject({
      type: 'ApiError',
      reason: 'overloaded',
    })
  })
  test('rate limit → RateLimited（无 resets_at）', () => {
    const ev = classifyStreamLine('You have hit the rate limit')
    expect(ev).toMatchObject({ type: 'RateLimited' })
    expect((ev as { resets_at?: number }).resets_at).toBeUndefined()
  })
  test('401 → auth_failed', () => {
    expect(classifyStreamLine('Error 401 Unauthorized')).toMatchObject({
      type: 'ApiError',
      reason: 'auth_failed',
    })
  })
  test('普通输出 → null', () => {
    expect(classifyStreamLine('> 正在思考…')).toBeNull()
  })
})

// ── 可注入 mock spawner 的 fake，便于测 resume('pty') ───────────────────────
function fakeSpawner(): { spawner: PtySpawner; calls: Array<{ file: string; args: string[] }>; fire: (code: number) => void } {
  const calls: Array<{ file: string; args: string[] }> = []
  let exitCb: ((e: { exitCode: number }) => void) | undefined
  const spawner: PtySpawner = {
    spawn(file, args) {
      calls.push({ file, args })
      const handle: PtyHandle = {
        pid: 4242,
        onData: () => {},
        onExit: (cb) => {
          exitCb = cb
        },
        write: () => {},
        resize: () => {},
        kill: () => {},
      }
      return handle
    },
  }
  return { spawner, calls, fire: (code) => exitCb?.({ exitCode: code }) }
}

describe('ClaudeCodeAdapter.resume("pty")', () => {
  test('用 --resume 起 claude，退出码 0 → resolve', async () => {
    const { spawner, calls, fire } = fakeSpawner()
    const adapter = new ClaudeCodeAdapter({ ptySpawner: spawner })
    const p = adapter.resume('pty', 'sid-1')
    expect(calls).toEqual([{ file: 'claude', args: ['--resume', 'sid-1'] }])
    fire(0)
    await expect(p).resolves.toBeUndefined()
  })

  test('退出码非 0 → reject', async () => {
    const { spawner, fire } = fakeSpawner()
    const adapter = new ClaudeCodeAdapter({ ptySpawner: spawner })
    const p = adapter.resume('pty', 'sid-1')
    fire(1)
    await expect(p).rejects.toThrow('退出码 1')
  })

  test('capabilities.forceContinue = true', () => {
    expect(new ClaudeCodeAdapter().capabilities.forceContinue).toBe(true)
  })
})
