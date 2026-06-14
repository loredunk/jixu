import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * jixu 的运行时路径集中在此，统一遵循 XDG（与 hook 脚本、statusline 缓存一致）。
 * 所有函数接受可选 home，便于单测注入临时目录。
 */

export function dataDir(home: string = homedir()): string {
  return process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share')
}

export function jixuDir(home: string = homedir()): string {
  return join(dataDir(home), 'jixu')
}

export function jobsDir(home: string = homedir()): string {
  return join(jixuDir(home), 'jobs')
}

export function logFilePath(home: string = homedir()): string {
  return join(jixuDir(home), 'waiter.log')
}

export function stateFilePath(home: string = homedir()): string {
  return join(jixuDir(home), 'waiter.state.json')
}

export function pidFilePath(home: string = homedir()): string {
  return join(jixuDir(home), 'waiter.pid')
}

/** CC 配置目录（尊重 CLAUDE_CONFIG_DIR），init 把 plugin 装到其 plugins/ 下 */
export function claudeConfigDir(home: string = homedir()): string {
  return process.env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude')
}

export function pluginInstallDir(home: string = homedir()): string {
  return join(claudeConfigDir(home), 'plugins', 'jixu')
}
