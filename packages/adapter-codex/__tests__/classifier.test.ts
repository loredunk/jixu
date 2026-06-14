import { describe, test, expect } from 'vitest'
import {
  classifyCodexMessage,
  classifyExecEvent,
  classifyRolloutLine,
  classifyStreamLine,
  classifyLogLine,
} from '../src/classifier'

// ── classifyCodexMessage（消息文本分类） ────────────────────────────────────
describe('classifyCodexMessage()', () => {
  test('套餐用量上限 → RateLimited', () => {
    const ev = classifyCodexMessage("You've hit your usage limit.")
    expect(ev).toMatchObject({ type: 'RateLimited' })
  })

  test('rate limit + "try again at <ISO>" → 携带 resets_at', () => {
    const ev = classifyCodexMessage("You've hit your usage limit. Try again at 2026-06-14T12:00:00Z.")
    expect(ev).toMatchObject({ type: 'RateLimited', resets_at: Date.parse('2026-06-14T12:00:00Z') })
  })

  test('insufficient_quota（API 余额）→ billing_failed', () => {
    expect(classifyCodexMessage('Error: insufficient_quota')).toMatchObject({
      type: 'ApiError',
      reason: 'billing_failed',
    })
  })

  test('overloaded / 503 → overloaded', () => {
    expect(classifyCodexMessage('503 server had an error, overloaded')).toMatchObject({
      type: 'ApiError',
      reason: 'overloaded',
    })
  })

  test('401 unauthorized → auth_failed', () => {
    expect(classifyCodexMessage('401 Unauthorized: not logged in')).toMatchObject({
      type: 'ApiError',
      reason: 'auth_failed',
    })
  })

  test('context window 超限 → context_too_long', () => {
    expect(classifyCodexMessage('maximum context length exceeded')).toMatchObject({
      type: 'ApiError',
      reason: 'context_too_long',
    })
  })

  test('ECONNRESET → ConnDead（连接层优先）', () => {
    expect(classifyCodexMessage('stream disconnected: read ECONNRESET')).toMatchObject({
      type: 'ConnDead',
    })
  })

  test('403 Request not allowed / Unable to connect → ConnDead', () => {
    expect(classifyCodexMessage('API Error: 403 Request not allowed')).toMatchObject({
      type: 'ConnDead',
    })
    expect(classifyCodexMessage('Unable to connect to API (ConnectionRefused)')).toMatchObject({
      type: 'ConnDead',
    })
  })

  // Codex=Rust(reqwest/hyper/tokio/rustls)：下面是中国网络不稳定下的真实风格错误串
  test.each([
    'error sending request for url (https://api.openai.com/v1/responses)',
    'connection closed before message completed',
    'Connection reset by peer (os error 104)',
    'Connection refused (os error 111)',
    'dns error: failed to lookup address information: Temporary failure in name resolution',
    'received fatal alert: handshake_failure',
    'tls handshake eof',
    'operation timed out',
    'Network is unreachable (os error 101)',
  ])('Rust/中国网络族 → ConnDead: %s', (msg) => {
    expect(classifyCodexMessage(msg)).toMatchObject({ type: 'ConnDead' })
  })

  // 实测 codex 把状态码包进 `stream error: ... last status: <code>`（issue #2612/#2896/#9148）。
  // 关键：必须按状态码归类，而非一律 ConnDead——否则 401(FATAL) 会被当可重试连接错误反复重启。
  test('stream error 按 last status 状态码归类（不被 stream-error 吞成 ConnDead）', () => {
    expect(
      classifyCodexMessage('⚠ stream error: exceeded retry limit, last status: 429 Too Many Requests; retrying 4/5 in 1.471s'),
    ).toMatchObject({ type: 'RateLimited' })
    expect(
      classifyCodexMessage('stream error: exceeded retry limit, last status: 401 Unauthorized, request id: 98c70fafdb690c36-LHR; retrying 1/5 in 212ms'),
    ).toMatchObject({ type: 'ApiError', reason: 'auth_failed' })
    expect(
      classifyCodexMessage('⚠ stream error: unexpected status 400 Bad Request: {"error":{"message":"Provider returned error"}}'),
    ).toMatchObject({ type: 'ApiError', reason: 'invalid_request' })
    expect(
      classifyCodexMessage('🖐 exceeded retry limit, last status: 503 Service Unavailable'),
    ).toMatchObject({ type: 'ApiError', reason: 'overloaded' })
  })

  // 纯断流（无状态码）→ SOFT 兜底 ConnDead（实测 issue #19121）
  test('stream disconnected before completion（无状态码）→ ConnDead', () => {
    expect(
      classifyCodexMessage('Stream disconnected before completion: An error occurred while processing your request. Please include the request ID 5036c677-60f5-4aef-ad04-da4182e0fc56 in your message.'),
    ).toMatchObject({ type: 'ConnDead' })
  })

  // 防回归：硬连接层与状态码语义不得相互吞没
  test('扩宽后 FATAL 分类不变', () => {
    expect(classifyCodexMessage('401 Unauthorized: not logged in')).toMatchObject({
      type: 'ApiError',
      reason: 'auth_failed',
    })
    expect(classifyCodexMessage('Error: insufficient_quota')).toMatchObject({
      type: 'ApiError',
      reason: 'billing_failed',
    })
    expect(classifyCodexMessage('maximum context length exceeded')).toMatchObject({
      type: 'ApiError',
      reason: 'context_too_long',
    })
  })

  test('普通文本 → null', () => {
    expect(classifyCodexMessage('Working on it…')).toBeNull()
  })
})

// ── classifyExecEvent（codex exec --json） ──────────────────────────────────
describe('classifyExecEvent()', () => {
  test('turn.failed（SDK）→ 按 error.message 分类', () => {
    const line = JSON.stringify({ type: 'turn.failed', error: { message: 'You have hit the rate limit' } })
    expect(classifyExecEvent(line)).toMatchObject({ type: 'RateLimited' })
  })

  test('协议 stream_error（msg）→ ConnDead', () => {
    const line = JSON.stringify({ msg: { type: 'stream_error', message: 'stream disconnected before completion' } })
    expect(classifyExecEvent(line)).toMatchObject({ type: 'ConnDead' })
  })

  test('rollout 包裹 payload.error → 分类', () => {
    const line = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'error', message: 'server is overloaded' },
    })
    expect(classifyExecEvent(line)).toMatchObject({ type: 'ApiError', reason: 'overloaded' })
  })

  test('rollout 包裹 Rust 网络串（reqwest）→ ConnDead', () => {
    const line = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'error', message: 'error sending request for url (https://api.openai.com): connection reset by peer (os error 104)' },
    })
    expect(classifyExecEvent(line)).toMatchObject({ type: 'ConnDead' })
  })

  test('thread.started（无错误消息）→ null', () => {
    expect(classifyExecEvent(JSON.stringify({ type: 'thread.started', thread_id: 'abc' }))).toBeNull()
  })

  test('正常 agent_message（不含错误字段）→ null', () => {
    const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'rate limit explained' } })
    expect(classifyExecEvent(line)).toBeNull()
  })

  test('非 JSON 行 → null', () => {
    expect(classifyExecEvent('not json at all')).toBeNull()
  })
})

// ── classifyStreamLine（PTY 输出：JSON 优先，文本兜底） ─────────────────────
describe('classifyStreamLine()', () => {
  test('JSON 事件优先', () => {
    const line = JSON.stringify({ type: 'error', message: 'read ECONNRESET' })
    expect(classifyStreamLine(line)).toMatchObject({ type: 'ConnDead' })
  })
  test('纯文本（带 ANSI）兜底', () => {
    expect(classifyStreamLine('\x1b[31m✗ You have hit your usage limit\x1b[0m')).toMatchObject({
      type: 'RateLimited',
    })
  })
  test('普通 TUI 输出 → null', () => {
    expect(classifyStreamLine('> thinking…')).toBeNull()
  })
})

// ── classifyRolloutLine / classifyLogLine ───────────────────────────────────
describe('classifyRolloutLine() / classifyLogLine()', () => {
  test('rollout 错误行 → 分类（等价 classifyExecEvent）', () => {
    const line = JSON.stringify({ payload: { type: 'error', message: 'socket hang up' } })
    expect(classifyRolloutLine(line)).toMatchObject({ type: 'ConnDead' })
  })
  test('classifyLogLine 只认连接层', () => {
    expect(classifyLogLine('Error: connection reset by peer')).toMatchObject({ type: 'ConnDead' })
    expect(classifyLogLine('[info] normal line')).toBeNull()
  })
})
