import {
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  readdirSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pluginInstallDir } from './paths.js'

/**
 * `jixu init`（ADR-007）：把 hook 脚本 plugin 复制到 ~/.claude/plugins/jixu/。
 * - 幂等：重复运行只覆盖 plugin 文件，不产生其他副作用
 * - 绝不修改 settings.json
 * - hooks.json 内用 ${CLAUDE_PLUGIN_ROOT} 引用脚本，保持可移植
 */

const PLUGIN_FILES = ['manifest.json', 'hooks.json', 'stop-failure.sh'] as const

/**
 * 定位随包分发的 hook-scripts 源目录。按优先级尝试：
 *   1. JIXU_HOOK_SCRIPTS_DIR 环境变量（测试/打包覆盖）
 *   2. 相对 waiter 包的 ../hook-scripts（monorepo 源码与 dist 同样适用）
 */
export function resolveHookScriptsDir(fromDir: string = __dirname): string | undefined {
  const candidates = [
    process.env['JIXU_HOOK_SCRIPTS_DIR'],
    // packages/waiter/src 或 packages/waiter/dist → packages/hook-scripts
    resolve(fromDir, '..', '..', 'hook-scripts'),
    // 已打包进 jixu 包内的场景
    resolve(fromDir, '..', 'hook-scripts'),
  ].filter((p): p is string => typeof p === 'string')

  for (const dir of candidates) {
    if (existsSync(join(dir, 'manifest.json'))) return dir
  }
  return undefined
}

export interface InitResult {
  installedTo: string
  copied: string[]
}

export function installHookPlugin(opts: { home?: string; sourceDir?: string } = {}): InitResult {
  const source = opts.sourceDir ?? resolveHookScriptsDir()
  if (!source) {
    throw new Error(
      '找不到 hook-scripts 目录；可设置 JIXU_HOOK_SCRIPTS_DIR 指向 plugin 源目录',
    )
  }

  const target = pluginInstallDir(opts.home)
  mkdirSync(target, { recursive: true })

  const available = new Set(readdirSync(source))
  const copied: string[] = []
  for (const file of PLUGIN_FILES) {
    if (!available.has(file)) continue
    const dest = join(target, file)
    copyFileSync(join(source, file), dest)
    copied.push(file)
    if (file.endsWith('.sh')) chmodSync(dest, 0o755) // 脚本需可执行
  }

  return { installedTo: target, copied }
}
