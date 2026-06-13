import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Logger = (msg: string) => void

/**
 * 追加式日志（PRD：所有决策写入 ~/.local/share/jixu/waiter.log）。
 * echoStderr 在前台运行时同时打到 stderr，detached 守护进程关掉。
 */
export function createLogger(filePath: string, echoStderr = false): Logger {
  mkdirSync(dirname(filePath), { recursive: true })
  return (msg: string): void => {
    const line = `${new Date().toISOString()} ${msg}\n`
    try {
      appendFileSync(filePath, line)
    } catch {
      /* 日志失败不应让守护进程崩溃 */
    }
    if (echoStderr) process.stderr.write(line)
  }
}
