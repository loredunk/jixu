import { describe, test, expect } from 'vitest'
import {
  freshGuardState,
  guardIncrement,
  guardReset,
  guardCount,
  guardExceeded,
  MAX_RETRIES,
} from '../src/guard'

describe('freshGuardState()', () => {
  test('初始计数为空', () => {
    expect(freshGuardState().counts).toEqual({})
  })
})

describe('guardIncrement()', () => {
  test('首次递增 → 1', () => {
    const s = guardIncrement(freshGuardState(), 'sess-a')
    expect(guardCount(s, 'sess-a')).toBe(1)
  })

  test('连续递增三次 → 3', () => {
    let s = freshGuardState()
    s = guardIncrement(s, 'sess-a')
    s = guardIncrement(s, 'sess-a')
    s = guardIncrement(s, 'sess-a')
    expect(guardCount(s, 'sess-a')).toBe(3)
  })

  test('不修改原状态（不可变）', () => {
    const orig = freshGuardState()
    guardIncrement(orig, 'sess-a')
    expect(guardCount(orig, 'sess-a')).toBe(0)
  })

  test('不同 session 互不干扰', () => {
    let s = freshGuardState()
    s = guardIncrement(s, 'sess-a')
    s = guardIncrement(s, 'sess-a')
    s = guardIncrement(s, 'sess-b')
    expect(guardCount(s, 'sess-a')).toBe(2)
    expect(guardCount(s, 'sess-b')).toBe(1)
  })
})

describe('guardReset()', () => {
  test('重置后计数归零', () => {
    let s = freshGuardState()
    s = guardIncrement(s, 'sess-a')
    s = guardIncrement(s, 'sess-a')
    s = guardReset(s, 'sess-a')
    expect(guardCount(s, 'sess-a')).toBe(0)
  })

  test('重置不影响其他 session', () => {
    let s = freshGuardState()
    s = guardIncrement(s, 'sess-a')
    s = guardIncrement(s, 'sess-b')
    s = guardReset(s, 'sess-a')
    expect(guardCount(s, 'sess-b')).toBe(1)
  })
})

describe('guardExceeded()', () => {
  test('count < MAX_RETRIES → false', () => {
    let s = freshGuardState()
    for (let i = 0; i < MAX_RETRIES - 1; i++) s = guardIncrement(s, 'sess-a')
    expect(guardExceeded(s, 'sess-a')).toBe(false)
  })

  test('count === MAX_RETRIES → true', () => {
    let s = freshGuardState()
    for (let i = 0; i < MAX_RETRIES; i++) s = guardIncrement(s, 'sess-a')
    expect(guardExceeded(s, 'sess-a')).toBe(true)
  })

  test('count > MAX_RETRIES → true', () => {
    let s = freshGuardState()
    for (let i = 0; i < MAX_RETRIES + 2; i++) s = guardIncrement(s, 'sess-a')
    expect(guardExceeded(s, 'sess-a')).toBe(true)
  })

  test('空 session → false', () => {
    expect(guardExceeded(freshGuardState(), 'sess-x')).toBe(false)
  })

  test('自定义 max=1 → 递增一次即超', () => {
    const s = guardIncrement(freshGuardState(), 'sess-a')
    expect(guardExceeded(s, 'sess-a', 1)).toBe(true)
  })
})
