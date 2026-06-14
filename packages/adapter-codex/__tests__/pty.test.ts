import { describe, test, expect } from 'vitest'
import { buildCodexArgs, codexBin, newSessionId } from '../src/pty'

// ── buildCodexArgs ───────────────────────────────────────────────────────────
describe('buildCodexArgs()', () => {
  test('pty fresh → 仅 extra（codex 交互 TUI）', () => {
    expect(buildCodexArgs({ mode: 'pty', resume: false })).toEqual([])
    expect(buildCodexArgs({ mode: 'pty', resume: false, extraArgs: ['--model', 'gpt-5'] })).toEqual([
      '--model',
      'gpt-5',
    ])
  })
  test('pty resume + sid → codex resume <sid>', () => {
    expect(buildCodexArgs({ mode: 'pty', resume: true, sessionId: 'sid' })).toEqual(['resume', 'sid'])
  })
  test('pty resume 无 sid → codex resume --last', () => {
    expect(buildCodexArgs({ mode: 'pty', resume: true })).toEqual(['resume', '--last'])
  })
  test('headless resume + sid + prompt → codex exec resume <sid> "继续"', () => {
    expect(buildCodexArgs({ mode: 'headless', resume: true, sessionId: 'sid', prompt: '继续' })).toEqual([
      'exec',
      'resume',
      'sid',
      '继续',
    ])
  })
  test('headless resume 无 sid → codex exec resume --last "继续"', () => {
    expect(buildCodexArgs({ mode: 'headless', resume: true, prompt: '继续' })).toEqual([
      'exec',
      'resume',
      '--last',
      '继续',
    ])
  })
  test('headless fresh → codex exec [prompt]', () => {
    expect(buildCodexArgs({ mode: 'headless', resume: false, prompt: 'hi' })).toEqual(['exec', 'hi'])
  })
})

describe('codexBin() / newSessionId()', () => {
  test('默认 codex，可被 JIXU_CODEX_BIN 覆盖', () => {
    const prev = process.env['JIXU_CODEX_BIN']
    delete process.env['JIXU_CODEX_BIN']
    expect(codexBin()).toBe('codex')
    process.env['JIXU_CODEX_BIN'] = '/opt/codex'
    try {
      expect(codexBin()).toBe('/opt/codex')
    } finally {
      if (prev === undefined) delete process.env['JIXU_CODEX_BIN']
      else process.env['JIXU_CODEX_BIN'] = prev
    }
  })
  test('newSessionId 返回 UUID（仅作内部标签）', () => {
    expect(newSessionId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
