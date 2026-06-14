import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLineScanner, RolloutTailer } from '../src/rollout-tailer'
import type { JixuEvent } from '@jixu/core'

const errLine = (message: string): string =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'error', message } })

// ── createLineScanner ────────────────────────────────────────────────────────
describe('createLineScanner()', () => {
  test('单块多行 → 逐行回调', () => {
    const lines: string[] = []
    const s = createLineScanner((l) => lines.push(l))
    s.push('a\nb\nc\n')
    expect(lines).toEqual(['a', 'b', 'c'])
  })
  test('跨块半行缓存 + flush 残留', () => {
    const lines: string[] = []
    const s = createLineScanner((l) => lines.push(l))
    s.push('he')
    s.push('llo')
    expect(lines).toEqual([])
    s.flush()
    expect(lines).toEqual(['hello'])
  })
})

// ── RolloutTailer ────────────────────────────────────────────────────────────
describe('RolloutTailer', () => {
  let dir: string
  const created: string[] = []
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  function tmpDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'jixu-rollout-'))
    created.push(dir)
    return dir
  }

  test('只捕获启动后新增的错误行（忽略历史）', () => {
    const d = tmpDir()
    const f = join(d, 'rollout-x.jsonl')
    writeFileSync(f, errLine('old ECONNRESET ignored') + '\n')

    const events: JixuEvent[] = []
    const tailer = new RolloutTailer({ filePath: f, onEvent: (e) => events.push(e) })
    appendFileSync(f, JSON.stringify({ type: 'response_item' }) + '\n')
    appendFileSync(f, errLine('read ECONNRESET') + '\n')
    tailer.poll()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'ConnDead' })
  })

  test('fromStart=true 扫描历史行', () => {
    const d = tmpDir()
    const f = join(d, 'rollout-y.jsonl')
    writeFileSync(f, errLine('socket hang up') + '\n' + JSON.stringify({ type: 'response_item' }) + '\n')

    const events: JixuEvent[] = []
    const tailer = new RolloutTailer({ filePath: f, fromStart: true, onEvent: (e) => events.push(e) })
    tailer.poll()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'ConnDead' })
  })

  test('每行都触发 onLine（供 watchdog 活跃信号）', () => {
    const d = tmpDir()
    const f = join(d, 'rollout-z.jsonl')
    writeFileSync(f, '')
    const lines: string[] = []
    const tailer = new RolloutTailer({ filePath: f, onEvent: () => {}, onLine: (l) => lines.push(l) })
    appendFileSync(f, 'a\nb\n')
    tailer.poll()
    expect(lines).toEqual(['a', 'b'])
  })

  test('文件截断后从头重读', () => {
    const d = tmpDir()
    const f = join(d, 'rollout-t.jsonl')
    writeFileSync(f, JSON.stringify({ type: 'response_item' }) + '\n')
    const events: JixuEvent[] = []
    const tailer = new RolloutTailer({ filePath: f, onEvent: (e) => events.push(e) })
    appendFileSync(f, errLine('connection reset by peer') + '\n')
    tailer.poll()
    expect(events).toHaveLength(1)

    writeFileSync(f, errLine('socket closed') + '\n') // 轮转：变短
    tailer.poll()
    expect(events).toHaveLength(2)
  })
})
