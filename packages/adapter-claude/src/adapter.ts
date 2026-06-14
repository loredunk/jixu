import { spawn } from 'node:child_process'
import type { IToolAdapter, AdapterCapabilities, UsageInfo } from '@jixu/core'
import { getUsage } from './usage-api.js'
import {
  type PtySpawner,
  nodePtySpawner,
  claudeBin,
  buildClaudeArgs,
} from './pty.js'

export class ClaudeCodeAdapter implements IToolAdapter {
  readonly id = 'claude-code'

  readonly capabilities: AdapterCapabilities = {
    errorDetect: 'strong',  // StopFailure hook 可用
    resetTime: true,         // OAuth usage API 可获取 resets_at
    forceContinue: true,     // PTY 交互式续接（M3）
  }

  /** 惰性创建，避免无 PTY 场景触碰 node-pty 原生模块 */
  private _ptySpawner: PtySpawner | undefined

  constructor(opts: { ptySpawner?: PtySpawner } = {}) {
    if (opts.ptySpawner) this._ptySpawner = opts.ptySpawner
  }

  async resume(mode: 'headless' | 'pty', sessionId: string): Promise<void> {
    if (mode === 'pty') {
      await this._ptyResume(sessionId)
    } else {
      await this._headlessResume(sessionId)
    }
  }

  async usage(): Promise<UsageInfo> {
    return getUsage()
  }

  async kill(pid: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        process.kill(pid, 'SIGTERM')
        // 给进程 3s 干净退出，超时再 SIGKILL
        const timer = setTimeout(() => {
          try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
          resolve()
        }, 3_000)
        timer.unref()

        // 轮询进程是否已退出
        const check = setInterval(() => {
          try {
            process.kill(pid, 0) // 不发信号，只检测进程存在
          } catch {
            clearInterval(check)
            clearTimeout(timer)
            resolve()
          }
        }, 200)
        check.unref()
      } catch (err) {
        // ESRCH = 进程不存在，视为已退出
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
          resolve()
        } else {
          reject(err)
        }
      }
    })
  }

  /**
   * PTY 交互式续接：在伪终端里起 `claude --resume <sid>`，输出转发到 stdout，
   * 进程退出码 0/null 视为成功。`jixu run` 的前台托管走更完整的 supervisor，
   * 这里是 IToolAdapter 契约下的最小实现（守护进程也可用）。
   */
  private _ptyResume(sessionId: string): Promise<void> {
    const spawner = (this._ptySpawner ??= nodePtySpawner())
    return new Promise((resolve, reject) => {
      const handle = spawner.spawn(claudeBin(), buildClaudeArgs({ sessionId, resume: true }))
      handle.onData((d) => process.stdout.write(d))
      handle.onExit(({ exitCode }) => {
        if (exitCode === 0) resolve()
        else reject(new Error(`claude（PTY）退出码 ${exitCode}`))
      })
    })
  }

  private _headlessResume(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // claude -p --resume <sessionId> "继续"
      const child = spawn('claude', ['-p', '--resume', sessionId, '继续'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })

      child.stdout?.on('data', (chunk: Buffer) => {
        process.stdout.write(`[jixu:claude] ${chunk.toString()}`)
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(`[jixu:claude:err] ${chunk.toString()}`)
      })

      child.on('close', (code) => {
        if (code === 0 || code === null) {
          resolve()
        } else {
          reject(new Error(`claude 进程退出码 ${code}`))
        }
      })

      child.on('error', reject)
    })
  }
}
