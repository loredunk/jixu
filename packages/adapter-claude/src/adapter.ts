import { spawn } from 'node:child_process'
import type { IToolAdapter, AdapterCapabilities, UsageInfo } from '@jixu/core'

export class ClaudeCodeAdapter implements IToolAdapter {
  readonly id = 'claude-code'

  readonly capabilities: AdapterCapabilities = {
    errorDetect: 'strong',  // StopFailure hook 可用
    resetTime: true,         // OAuth usage API 可获取 resets_at
    forceContinue: false,    // PTY 模式 M3 实现
  }

  async resume(mode: 'headless' | 'pty', sessionId: string): Promise<void> {
    if (mode === 'pty') {
      throw new Error('PTY 模式在 M3 实现，当前只支持 headless')
    }
    await this._headlessResume(sessionId)
  }

  async usage(): Promise<UsageInfo> {
    // M2 实现 OAuth usage API；M1 返回空对象
    return {}
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
