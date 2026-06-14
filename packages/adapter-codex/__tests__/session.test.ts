import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sessionIdFromRolloutPath,
  sessionIdFromRolloutLine,
  readSessionId,
} from '../src/session'
import { resolveLatestRollout } from '../src/paths'

const UUID = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'

// ── sessionIdFromRolloutPath ────────────────────────────────────────────────
describe('sessionIdFromRolloutPath()', () => {
  test('从 rollout 文件名提取 uuid', () => {
    expect(sessionIdFromRolloutPath(`/x/sessions/2026/06/14/rollout-2026-06-14T10-30-00-${UUID}.jsonl`)).toBe(UUID)
  })
  test('无 uuid → null', () => {
    expect(sessionIdFromRolloutPath('/x/rollout-no-uuid.jsonl')).toBeNull()
  })
})

// ── sessionIdFromRolloutLine ────────────────────────────────────────────────
describe('sessionIdFromRolloutLine()', () => {
  test('session_meta.payload.id', () => {
    expect(sessionIdFromRolloutLine(JSON.stringify({ type: 'session_meta', payload: { id: UUID } }))).toBe(UUID)
  })
  test('thread.started.thread_id', () => {
    expect(sessionIdFromRolloutLine(JSON.stringify({ type: 'thread.started', thread_id: 'th_1' }))).toBe('th_1')
  })
  test('非 JSON / 无 id → null', () => {
    expect(sessionIdFromRolloutLine('garbage')).toBeNull()
    expect(sessionIdFromRolloutLine(JSON.stringify({ type: 'response_item' }))).toBeNull()
  })
})

// ── readSessionId ────────────────────────────────────────────────────────────
describe('readSessionId()', () => {
  const created: string[] = []
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  test('文件名带 uuid → 直接用文件名（不读内容）', () => {
    expect(readSessionId(`/x/rollout-${UUID}.jsonl`)).toBe(UUID)
  })

  test('文件名无 uuid → 读内容里的 session_meta', () => {
    const d = mkdtempSync(join(tmpdir(), 'jixu-sid-'))
    created.push(d)
    const f = join(d, 'rollout-plain.jsonl')
    writeFileSync(f, JSON.stringify({ type: 'session_meta', payload: { id: 'sess-xyz' } }) + '\n')
    expect(readSessionId(f)).toBe('sess-xyz')
  })
})

// ── resolveLatestRollout（YYYY/MM/DD 分层） ─────────────────────────────────
describe('resolveLatestRollout()', () => {
  const created: string[] = []
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  test('返回日期目录树里 mtime 最新的 rollout-*.jsonl', () => {
    const root = mkdtempSync(join(tmpdir(), 'jixu-sessions-'))
    created.push(root)
    const day = join(root, '2026', '06', '14')
    mkdirSync(day, { recursive: true })
    const older = join(day, 'rollout-A.jsonl')
    const newer = join(day, 'rollout-B.jsonl')
    writeFileSync(older, 'x')
    writeFileSync(newer, 'x')
    writeFileSync(join(day, 'note.txt'), 'x') // 非 rollout，忽略
    const future = Date.now() / 1000 + 100
    utimesSync(newer, future, future)

    expect(resolveLatestRollout(root)).toBe(newer)
  })

  test('目录不存在 → undefined', () => {
    expect(resolveLatestRollout('/no/such/jixu-sessions-xyz')).toBeUndefined()
  })
})
