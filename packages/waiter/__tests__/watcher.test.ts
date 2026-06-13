import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeJob,
  parseJobFileContent,
  JobDedup,
  JobWatcher,
  type NormalizedJob,
} from '../src/watcher'

// ── normalizeJob ─────────────────────────────────────────────────────────────
describe('normalizeJob()', () => {
  test('强通道 rawPayload(rate_limit) → 分类为 RateLimited', () => {
    const job = normalizeJob({
      sessionId: 'S',
      pid: 123,
      timestamp: 1_000,
      rawPayload: { error: { type: 'rate_limit_error', resets_at: 1_718_000_000_000 } },
    })
    expect(job).toMatchObject({
      sessionId: 'S',
      pid: 123,
      event: { type: 'RateLimited', resets_at: 1_718_000_000_000 },
    })
  })

  test('强通道 rawPayload 为字符串也能分类', () => {
    const job = normalizeJob({
      sessionId: 'S',
      timestamp: 1_000,
      rawPayload: 'error: Overloaded, retry',
    })
    expect(job?.event).toMatchObject({ type: 'ApiError', reason: 'overloaded' })
    expect(job?.pid).toBeUndefined()
  })

  test('弱通道 event 形态直接透传', () => {
    const job = normalizeJob({
      sessionId: 'S',
      timestamp: 1_000,
      event: { type: 'ConnDead', raw: 'ECONNRESET' },
    })
    expect(job?.event).toEqual({ type: 'ConnDead', raw: 'ECONNRESET' })
  })

  test('缺少 sessionId → null', () => {
    expect(normalizeJob({ timestamp: 1, rawPayload: {} })).toBeNull()
  })

  test('rawPayload 无法识别 → null', () => {
    expect(normalizeJob({ sessionId: 'S', timestamp: 1, rawPayload: { foo: 1 } })).toBeNull()
  })

  test('非对象 → null', () => {
    expect(normalizeJob(null)).toBeNull()
    expect(normalizeJob('x')).toBeNull()
  })
})

describe('parseJobFileContent()', () => {
  test('非法 JSON → null', () => {
    expect(parseJobFileContent('{not json')).toBeNull()
  })
  test('合法 JSON → 归一化', () => {
    const content = JSON.stringify({
      sessionId: 'S',
      timestamp: 1,
      event: { type: 'Stalled' },
    })
    expect(parseJobFileContent(content)?.event).toEqual({ type: 'Stalled' })
  })
})

// ── JobDedup ─────────────────────────────────────────────────────────────────
describe('JobDedup', () => {
  const mk = (sessionId: string, timestamp: number): NormalizedJob => ({
    sessionId,
    timestamp,
    event: { type: 'ConnDead' },
  })

  test('首次不算重复，mark 后同/旧时间戳算重复', () => {
    const d = new JobDedup()
    const j = mk('S', 1_000)
    expect(d.isDuplicate(j)).toBe(false)
    d.mark(j)
    expect(d.isDuplicate(mk('S', 1_000))).toBe(true) // 同时刻
    expect(d.isDuplicate(mk('S', 900))).toBe(true) // 更旧
    expect(d.isDuplicate(mk('S', 1_100))).toBe(false) // 更新
  })

  test('不同 session 互不影响', () => {
    const d = new JobDedup()
    d.mark(mk('A', 1_000))
    expect(d.isDuplicate(mk('B', 1_000))).toBe(false)
  })
})

// ── JobWatcher.handleFile ────────────────────────────────────────────────────
describe('JobWatcher.handleFile()', () => {
  const created: string[] = []
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  test('读取 → 回调归一化 job → 删除文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jixu-jobs-'))
    created.push(dir)
    const file = join(dir, 'S.job.json')
    writeFileSync(
      file,
      JSON.stringify({ sessionId: 'S', pid: 7, timestamp: 1_000, rawPayload: { error: { type: 'overloaded_error' } } }),
    )

    const got: NormalizedJob[] = []
    const w = new JobWatcher({ jobsDir: dir, onJob: (j) => void got.push(j) })
    await w.handleFile(file)

    expect(got).toHaveLength(1)
    expect(got[0]?.event).toMatchObject({ type: 'ApiError', reason: 'overloaded' })
    expect(existsSync(file)).toBe(false) // 已消费
  })

  test('重复 job 文件第二次被去重', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jixu-jobs-'))
    created.push(dir)
    const got: NormalizedJob[] = []
    const w = new JobWatcher({ jobsDir: dir, onJob: (j) => void got.push(j) })

    const payload = JSON.stringify({ sessionId: 'S', timestamp: 1_000, event: { type: 'ConnDead' } })
    const f1 = join(dir, 'a.job.json')
    writeFileSync(f1, payload)
    await w.handleFile(f1)

    const f2 = join(dir, 'b.job.json')
    writeFileSync(f2, payload) // 同 session 同时间戳
    await w.handleFile(f2)

    expect(got).toHaveLength(1) // 第二次去重
  })

  test('consume=false 时保留文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jixu-jobs-'))
    created.push(dir)
    const file = join(dir, 'S.job.json')
    writeFileSync(file, JSON.stringify({ sessionId: 'S', timestamp: 1, event: { type: 'Stalled' } }))
    const w = new JobWatcher({ jobsDir: dir, onJob: () => {}, consume: false })
    await w.handleFile(file)
    expect(existsSync(file)).toBe(true)
  })
})
