import { describe, test, expect } from 'vitest'
import { getProfile, isToolId, parseToolFlag } from '../src/tools'

// ── getProfile ───────────────────────────────────────────────────────────────
describe('getProfile()', () => {
  test('默认 claude', () => {
    expect(getProfile().id).toBe('claude')
  })

  test('claude：buildArgs 走 --session-id / --resume', () => {
    const p = getProfile('claude')
    expect(p.buildArgs({ sessionId: 's', resume: false })).toEqual(['--session-id', 's'])
    expect(p.buildArgs({ sessionId: 's', resume: true })).toEqual(['--resume', 's'])
    expect(p.sessionIdForLog).toBeUndefined() // Claude 弱通道无法从文件名归因
  })

  test('codex：fresh 仅 extra，resume 走 resume --last（不预设 session id）', () => {
    const p = getProfile('codex')
    expect(p.buildArgs({ sessionId: 's', resume: false })).toEqual([])
    expect(p.buildArgs({ sessionId: 's', resume: true })).toEqual(['resume', '--last'])
    expect(p.buildArgs({ sessionId: 's', resume: false, extraArgs: ['--model', 'gpt-5'] })).toEqual([
      '--model',
      'gpt-5',
    ])
  })

  test('codex：弱通道目录指向 sessions，且能从 rollout 文件名归因 session', () => {
    const p = getProfile('codex')
    expect(p.defaultLogDir('/home/x').endsWith('/.codex/sessions')).toBe(true)
    expect(p.sessionIdForLog?.('/x/rollout-2026-06-14T00-00-00-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.jsonl')).toBe(
      '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
    )
  })

  test('codex：classifyStreamLine 识别套餐用量上限', () => {
    expect(getProfile('codex').classifyStreamLine('You have hit your usage limit')).toMatchObject({
      type: 'RateLimited',
    })
  })
})

// ── isToolId ─────────────────────────────────────────────────────────────────
describe('isToolId()', () => {
  test('claude / codex 为真，其余为假', () => {
    expect(isToolId('claude')).toBe(true)
    expect(isToolId('codex')).toBe(true)
    expect(isToolId('gpt')).toBe(false)
    expect(isToolId(undefined)).toBe(false)
  })
})

// ── parseToolFlag ────────────────────────────────────────────────────────────
describe('parseToolFlag()', () => {
  test('无 --tool → claude，参数原样保留', () => {
    expect(parseToolFlag(['--model', 'opus'])).toEqual({ tool: 'claude', rest: ['--model', 'opus'] })
    expect(parseToolFlag([])).toEqual({ tool: 'claude', rest: [] })
  })

  test('--tool codex 被消费，其余透传', () => {
    expect(parseToolFlag(['--tool', 'codex', '--', '--model', 'x'])).toEqual({
      tool: 'codex',
      rest: ['--', '--model', 'x'],
    })
  })

  test('--tool=codex 形式', () => {
    expect(parseToolFlag(['--tool=codex'])).toEqual({ tool: 'codex', rest: [] })
  })

  test('非法工具值被消费但回退 claude（不误传给 CLI）', () => {
    expect(parseToolFlag(['--tool', 'bogus'])).toEqual({ tool: 'claude', rest: [] })
  })

  test('`--` 之后的 --tool 属于底层 CLI，不解析', () => {
    expect(parseToolFlag(['--', '--tool', 'codex'])).toEqual({
      tool: 'claude',
      rest: ['--', '--tool', 'codex'],
    })
  })
})
