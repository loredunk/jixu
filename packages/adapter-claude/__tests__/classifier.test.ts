import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyHookPayload, classifyLogLine } from '../src/classifier'

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf-8').trim()
}

// ── classifyHookPayload ────────────────────────────────────────────────────
describe('classifyHookPayload()', () => {
  test('overloaded_error → ApiError{overloaded}', () => {
    const event = classifyHookPayload(fixture('cc-overloaded.txt'))
    expect(event).toMatchObject({ type: 'ApiError', reason: 'overloaded' })
  })

  test('rate_limit_error → RateLimited，携带 resets_at', () => {
    const event = classifyHookPayload(fixture('cc-rate-limit.txt'))
    expect(event).toMatchObject({ type: 'RateLimited', resets_at: 1718000000000 })
  })

  test('authentication_error → ApiError{auth_failed}', () => {
    const event = classifyHookPayload(fixture('cc-auth-failed.txt'))
    expect(event).toMatchObject({ type: 'ApiError', reason: 'auth_failed' })
  })

  test('无法识别的 payload → null', () => {
    expect(classifyHookPayload('{"type":"unknown_thing"}')).toBeNull()
  })

  test('空字符串 → null', () => {
    expect(classifyHookPayload('')).toBeNull()
  })

  test('非 JSON 字符串中含 overloaded 关键字 → ApiError{overloaded}', () => {
    const event = classifyHookPayload('error: Overloaded, please retry')
    expect(event).toMatchObject({ type: 'ApiError', reason: 'overloaded' })
  })
})

// ── classifyLogLine ────────────────────────────────────────────────────────
describe('classifyLogLine()', () => {
  test('ECONNRESET 行 → ConnDead', () => {
    const line = fixture('cc-econnreset.txt')
    expect(classifyLogLine(line)).toMatchObject({ type: 'ConnDead' })
  })

  test('socket hang up 行 → ConnDead', () => {
    const line = fixture('cc-socket-closed.txt')
    expect(classifyLogLine(line)).toMatchObject({ type: 'ConnDead' })
  })

  test('普通 info 日志 → null', () => {
    expect(classifyLogLine('2024-06-10T08:00:00Z [info] session started')).toBeNull()
  })

  test('connection reset 变体 → ConnDead', () => {
    expect(classifyLogLine('Error: connection reset by peer')).toMatchObject({ type: 'ConnDead' })
  })
})
