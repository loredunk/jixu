#!/usr/bin/env node
/**
 * jixu waiter — 最小 CLI（M1）
 * M2 补全完整的 start/stop/status/init 守护进程逻辑。
 */
const [, , cmd] = process.argv

if (cmd === 'start' || cmd === 'stop' || cmd === 'status' || cmd === 'init') {
  console.error(`[jixu] '${cmd}' 命令在 M2 实现。`)
  process.exit(1)
} else {
  console.error('[jixu] 用法: jixu start|stop|status|init')
  process.exit(1)
}
