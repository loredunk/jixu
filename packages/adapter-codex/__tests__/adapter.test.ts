import { describe, test, expect } from 'vitest'
import { CodexAdapter, NotImplementedError } from '../src/adapter'
import type { IToolAdapter } from '@jixu/core'

/**
 * Codex 本期只留占位（PRD 非目标）。这里证明：实现 IToolAdapter 即可接入新工具，
 * 无需改 @jixu/core 或 waiter——架构可扩展性的回归测试。
 */
describe('CodexAdapter（占位）', () => {
  // 赋值给 IToolAdapter 类型即编译期证明契约一致
  const adapter: IToolAdapter = new CodexAdapter()

  test('满足 IToolAdapter 形状', () => {
    expect(adapter.id).toBe('codex')
    expect(adapter.capabilities).toMatchObject({
      errorDetect: expect.any(String),
      resetTime: expect.any(Boolean),
      forceContinue: expect.any(Boolean),
    })
  })

  test('resume / usage / kill 均抛 NotImplementedError', async () => {
    expect(() => adapter.resume('headless', 's')).toThrow(NotImplementedError)
    expect(() => adapter.usage()).toThrow(NotImplementedError)
    expect(() => adapter.kill(123)).toThrow(NotImplementedError)
  })
})
