import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, existsSync, statSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHookPlugin, resolveHookScriptsDir } from '../src/init'

const HOOK_SRC = join(__dirname, '..', '..', 'hook-scripts')

const created: string[] = []
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'jixu-home-'))
  created.push(d)
  return d
}

describe('installHookPlugin()', () => {
  test('把 plugin 复制到 ~/.claude/plugins/jixu，脚本可执行', () => {
    const home = tmpHome()
    const result = installHookPlugin({ home, sourceDir: HOOK_SRC })

    expect(result.installedTo).toBe(join(home, '.claude', 'plugins', 'jixu'))
    expect(result.copied).toContain('manifest.json')
    expect(result.copied).toContain('hooks.json')
    expect(result.copied).toContain('stop-failure.sh')

    const script = join(result.installedTo, 'stop-failure.sh')
    expect(existsSync(script)).toBe(true)
    // 可执行位（owner execute）
    expect(statSync(script).mode & 0o100).toBe(0o100)
  })

  test('幂等：重复运行不报错', () => {
    const home = tmpHome()
    installHookPlugin({ home, sourceDir: HOOK_SRC })
    expect(() => installHookPlugin({ home, sourceDir: HOOK_SRC })).not.toThrow()
  })

  test('CLAUDE_CONFIG_DIR 优先', () => {
    const home = tmpHome()
    const cfg = tmpHome()
    const prev = process.env['CLAUDE_CONFIG_DIR']
    process.env['CLAUDE_CONFIG_DIR'] = cfg
    try {
      const result = installHookPlugin({ home, sourceDir: HOOK_SRC })
      expect(result.installedTo).toBe(join(cfg, 'plugins', 'jixu'))
    } finally {
      if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR']
      else process.env['CLAUDE_CONFIG_DIR'] = prev
    }
  })
})

describe('resolveHookScriptsDir()', () => {
  test('能从 waiter 包定位到 hook-scripts', () => {
    // 模拟 dist/src 同级：从 packages/waiter/<x> 出发应找到 packages/hook-scripts
    const fromDir = join(__dirname, '..', 'src')
    expect(resolveHookScriptsDir(fromDir)).toBe(HOOK_SRC)
  })

  test('JIXU_HOOK_SCRIPTS_DIR 覆盖', () => {
    const prev = process.env['JIXU_HOOK_SCRIPTS_DIR']
    process.env['JIXU_HOOK_SCRIPTS_DIR'] = HOOK_SRC
    try {
      expect(resolveHookScriptsDir('/nonexistent')).toBe(HOOK_SRC)
    } finally {
      if (prev === undefined) delete process.env['JIXU_HOOK_SCRIPTS_DIR']
      else process.env['JIXU_HOOK_SCRIPTS_DIR'] = prev
    }
  })

  test('发布布局：从 dist 同级的 plugin/ 解析（bundle-plugin 产物）', () => {
    const prev = process.env['JIXU_HOOK_SCRIPTS_DIR']
    delete process.env['JIXU_HOOK_SCRIPTS_DIR']
    const root = mkdtempSync(join(tmpdir(), 'jixu-pub-'))
    created.push(root)
    // 模拟 node_modules/jixu/{dist,plugin}，且不存在 ../../hook-scripts
    const dist = join(root, 'jixu', 'dist')
    const plugin = join(root, 'jixu', 'plugin')
    mkdirSync(dist, { recursive: true })
    mkdirSync(plugin, { recursive: true })
    writeFileSync(join(plugin, 'manifest.json'), '{}')
    try {
      expect(resolveHookScriptsDir(dist)).toBe(plugin)
    } finally {
      if (prev !== undefined) process.env['JIXU_HOOK_SCRIPTS_DIR'] = prev
    }
  })
})
