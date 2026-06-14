import { describe, test, expect } from 'vitest'
import { CodexAdapter } from '../src/adapter'
import type { IToolAdapter } from '@jixu/core'
import type { PtySpawner, PtyHandle } from '../src/pty'

/** 可注入的 mock spawner，断言 resume('pty') 的启动参数与退出处理 */
function fakeSpawner(): {
  spawner: PtySpawner
  calls: Array<{ file: string; args: string[] }>
  fire: (code: number) => void
} {
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

describe('CodexAdapter', () => {
  test('满足 IToolAdapter 形状，能力位 weak/true/true', () => {
    const adapter: IToolAdapter = new CodexAdapter()
    expect(adapter.id).toBe('codex')
    expect(adapter.capabilities).toEqual({
      errorDetect: 'weak',
      resetTime: true,
      forceContinue: true,
    })
  })

  test('resume("pty") 用 codex resume <sid> 起进程，退出码 0 → resolve', async () => {
    const { spawner, calls, fire } = fakeSpawner()
    const adapter = new CodexAdapter({ ptySpawner: spawner })
    const p = adapter.resume('pty', 'sid-1')
    expect(calls).toEqual([{ file: 'codex', args: ['resume', 'sid-1'] }])
    fire(0)
    await expect(p).resolves.toBeUndefined()
  })

  test('resume("pty") 退出码非 0 → reject', async () => {
    const { spawner, fire } = fakeSpawner()
    const adapter = new CodexAdapter({ ptySpawner: spawner })
    const p = adapter.resume('pty', 'sid-1')
    fire(1)
    await expect(p).rejects.toThrow('退出码 1')
  })

  test('kill 不存在的 pid → resolve（ESRCH 视为已退出）', async () => {
    const adapter = new CodexAdapter()
    await expect(adapter.kill(2_000_000_000)).resolves.toBeUndefined()
  })

  test('usage() 不抛错，返回对象（无 rollout 时为空）', async () => {
    const adapter = new CodexAdapter()
    const usage = await adapter.usage()
    expect(typeof usage).toBe('object')
  })
})
