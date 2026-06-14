#!/usr/bin/env node
/**
 * node-pty 的 npm 包里 prebuilds/<platform>/spawn-helper 常常丢失执行位，
 * 导致 macOS/Linux 下首次 `jixu run` 报 `posix_spawnp failed`。
 * 这个 postinstall 钩子在安装后给各平台的 spawn-helper 补 +x（存在才改、静默失败，
 * 绝不让安装因此失败）。
 */
import { chmodSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// 工作区会把 node-pty 提升到根 node_modules；保险起见也扫描各子包的 node_modules。
const candidateRoots = [
  'node_modules/node-pty/prebuilds',
  'packages/adapter-claude/node_modules/node-pty/prebuilds',
  'packages/adapter-codex/node_modules/node-pty/prebuilds',
  'packages/waiter/node_modules/node-pty/prebuilds',
]

let fixed = 0
for (const root of candidateRoots) {
  let platforms
  try {
    platforms = readdirSync(root)
  } catch {
    continue // 该位置没有 node-pty
  }
  for (const platform of platforms) {
    const helper = join(root, platform, 'spawn-helper')
    try {
      statSync(helper) // 不存在就跳过（如 win32 无 spawn-helper）
      chmodSync(helper, 0o755)
      fixed++
    } catch {
      /* 文件不存在或无权限：静默忽略 */
    }
  }
}

if (fixed > 0) {
  console.log(`[jixu] 已为 ${fixed} 个 node-pty spawn-helper 补执行位（修复 posix_spawnp failed）`)
}
