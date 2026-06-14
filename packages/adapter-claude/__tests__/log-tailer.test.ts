import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLineScanner, LogTailer, resolveLatestLog } from '../src/log-tailer'
import type { JixuEvent } from '@jixu/core'

// ── createLineScanner ────────────────────────────────────────────────────────
describe('createLineScanner()', () => {
  test('单块多行 → 逐行回调', () => {
    const lines: string[] = []
    const s = createLineScanner((l) => lines.push(l))
    s.push('a\nb\nc\n')
    expect(lines).toEqual(['a', 'b', 'c'])
  })

  test('跨块的半行被缓存到下一块', () => {
    const lines: string[] = []
    const s = createLineScanner((l) => lines.push(l))
    s.push('hel')
    s.push('lo\nwor')
    expect(lines).toEqual(['hello'])
    s.push('ld\n')
    expect(lines).toEqual(['hello', 'world'])
  })

  test('flush 吐出残留的不完整行', () => {
    const lines: string[] = []
    const s = createLineScanner((l) => lines.push(l))
    s.push('tail-no-newline')
    expect(lines).toEqual([])
    s.flush()
    expect(lines).toEqual(['tail-no-newline'])
  })

  test('去除行尾 \\r（CRLF）', () => {
    const lines: string[] = []
    const s = createLineScanner((l) => lines.push(l))
    s.push('windows\r\nline\r\n')
    expect(lines).toEqual(['windows', 'line'])
  })
})

// ── LogTailer ────────────────────────────────────────────────────────────────
describe('LogTailer', () => {
  let dir: string
  const created: string[] = []

  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function tmpDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'jixu-tail-'))
    created.push(dir)
    return dir
  }

  test('只捕获启动后新增的 ECONNRESET 行（忽略历史）', () => {
    const d = tmpDir()
    const log = join(d, 'cc.log')
    writeFileSync(log, '2024 [info] old line with ECONNRESET should be ignored\n')

    const events: JixuEvent[] = []
    const tailer = new LogTailer({ filePath: log, onEvent: (e) => events.push(e) })

    // 启动后追加新行
    appendFileSync(log, '2024 [info] normal\n')
    appendFileSync(log, '2024 [error] read ECONNRESET\n')
    tailer.poll()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'ConnDead' })
  })

  test('fromStart=true 时扫描历史行', () => {
    const d = tmpDir()
    const log = join(d, 'cc.log')
    writeFileSync(log, 'Error: socket hang up\nplain info\n')

    const events: JixuEvent[] = []
    const tailer = new LogTailer({ filePath: log, fromStart: true, onEvent: (e) => events.push(e) })
    tailer.poll()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'ConnDead' })
  })

  test('普通日志不触发事件', () => {
    const d = tmpDir()
    const log = join(d, 'cc.log')
    writeFileSync(log, '')

    const events: JixuEvent[] = []
    const tailer = new LogTailer({ filePath: log, onEvent: (e) => events.push(e) })
    appendFileSync(log, '[info] all good\n[debug] token received\n')
    tailer.poll()

    expect(events).toHaveLength(0)
  })

  test('文件被截断后从头重新读', () => {
    const d = tmpDir()
    const log = join(d, 'cc.log')
    writeFileSync(log, 'line1\n')
    const events: JixuEvent[] = []
    const tailer = new LogTailer({ filePath: log, onEvent: (e) => events.push(e) })

    appendFileSync(log, 'connection reset by peer\n')
    tailer.poll()
    expect(events).toHaveLength(1)

    // 轮转：内容变短
    writeFileSync(log, 'socket closed\n')
    tailer.poll()
    expect(events).toHaveLength(2)
  })
})

// ── resolveLatestLog ─────────────────────────────────────────────────────────
describe('resolveLatestLog()', () => {
  const created: string[] = []
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  test('返回最新修改的 *.log', () => {
    const d = mkdtempSync(join(tmpdir(), 'jixu-logs-'))
    created.push(d)
    writeFileSync(join(d, 'old.log'), 'x')
    writeFileSync(join(d, 'readme.txt'), 'x') // 非 .log，忽略
    const newer = join(d, 'new.log')
    writeFileSync(newer, 'x')
    // 确保 new.log 的 mtime 更晚
    const future = Date.now() / 1000 + 100
    utimesSync(newer, future, future)

    expect(resolveLatestLog(d)).toBe(newer)
  })

  test('目录不存在 → undefined', () => {
    expect(resolveLatestLog('/no/such/dir/jixu-xyz')).toBeUndefined()
  })
})
