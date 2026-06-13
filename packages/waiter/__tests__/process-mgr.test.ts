import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  isProcessAlive,
  readPidFile,
  readLivePid,
  acquireLock,
  releaseLock,
  killAndWait,
  DaemonAlreadyRunningError,
} from '../src/process-mgr'

const created: string[] = []
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmpFile(name = 'waiter.pid'): string {
  const dir = mkdtempSync(join(tmpdir(), 'jixu-pm-'))
  created.push(dir)
  return join(dir, name)
}

describe('isProcessAlive()', () => {
  test('当前进程存活', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })
  test('不可能的 pid → false', () => {
    expect(isProcessAlive(2_147_483_646)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
  })
})

describe('readPidFile() / readLivePid()', () => {
  test('合法 pid 文件', () => {
    const f = tmpFile()
    writeFileSync(f, `${process.pid}\n`)
    expect(readPidFile(f)).toBe(process.pid)
    expect(readLivePid(f)).toBe(process.pid)
  })
  test('文件不存在 → null', () => {
    expect(readPidFile(tmpFile())).toBeNull()
  })
  test('垃圾内容 → null', () => {
    const f = tmpFile()
    writeFileSync(f, 'not-a-pid')
    expect(readPidFile(f)).toBeNull()
  })
  test('指向死进程 → readLivePid null（陈旧锁）', () => {
    const f = tmpFile()
    writeFileSync(f, '2147483646')
    expect(readPidFile(f)).toBe(2_147_483_646)
    expect(readLivePid(f)).toBeNull()
  })
})

describe('acquireLock() / releaseLock()', () => {
  test('抢锁写入自身 pid，释放后删除', () => {
    const f = tmpFile()
    acquireLock(f)
    expect(readLivePid(f)).toBe(process.pid)
    releaseLock(f)
    expect(existsSync(f)).toBe(false)
  })

  test('陈旧锁（死进程）→ 直接覆盖', () => {
    const f = tmpFile()
    writeFileSync(f, '2147483646') // 死 pid
    expect(() => acquireLock(f)).not.toThrow()
    expect(readPidFile(f)).toBe(process.pid)
  })

  test('已有存活进程持锁 → 抛 DaemonAlreadyRunningError', () => {
    const f = tmpFile()
    writeFileSync(f, String(process.pid)) // 存活
    // 以「另一个 pid」身份抢锁 → 发现锁被存活的 process.pid 持有
    expect(() => acquireLock(f, 1)).toThrow(DaemonAlreadyRunningError)
  })

  test('releaseLock 只删自己持有的锁', () => {
    const f = tmpFile()
    writeFileSync(f, String(process.pid))
    releaseLock(f, 999_999) // 不是持有者
    expect(existsSync(f)).toBe(true)
  })
})

describe('killAndWait()', () => {
  test('不存在的进程立即 resolve', async () => {
    await expect(killAndWait(2_147_483_646, { graceMs: 200 })).resolves.toBeUndefined()
  })

  test('SIGTERM 结束真实子进程', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    await new Promise((r) => setTimeout(r, 50)) // 等子进程起来
    expect(isProcessAlive(child.pid as number)).toBe(true)
    await killAndWait(child.pid as number, { graceMs: 1_000, pollMs: 50 })
    expect(isProcessAlive(child.pid as number)).toBe(false)
  })
})
