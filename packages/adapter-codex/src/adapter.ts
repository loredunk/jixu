import { spawn } from 'node:child_process'
import type { IToolAdapter, AdapterCapabilities, UsageInfo } from '@jixu/core'
import { getUsage } from './usage.js'
import { type PtySpawner, nodePtySpawner, codexBin, buildCodexArgs } from './pty.js'

/** headless 续接默认提示语（与 supervisor 的 JIXU_CONTINUE_PROMPT 对齐） */
const CONTINUE_PROMPT = process.env['JIXU_CONTINUE_PROMPT'] ?? '继续'

/**
 * Codex 适配器（OpenAI codex CLI）。
 *
 * 与 ClaudeCodeAdapter 对等的能力，差异来自 Codex 自身：
 *   - 无 StopFailure hook → errorDetect 'weak'（靠 tail rollout / 解析输出）
 *   - resets_at 内联在 rate_limits 事件 → resetTime true（见 usage.ts）
 *   - 支持 `codex resume` 交互式续接 → forceContinue true
 *   - 不能预设 session id → 续接用真实 id 或 `--last`（最近会话）
 */
export class CodexAdapter implements IToolAdapter {
  readonly id = 'codex'

  readonly capabilities: AdapterCapabilities = {
    errorDetect: 'weak',
    resetTime: true,
    forceContinue: true,
  }

  /** 惰性创建，避免无 PTY 场景触碰 node-pty 原生模块 */
  private _ptySpawner: PtySpawner | undefined

  constructor(opts: { ptySpawner?: PtySpawner } = {}) {
    if (opts.ptySpawner) this._ptySpawner = opts.ptySpawner
  }

  async resume(mode: 'headless' | 'pty', sessionId: string): Promise<void> {
    if (mode === 'pty') await this._ptyResume(sessionId)
    else await this._headlessResume(sessionId)
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
   * PTY 交互式续接：起 `codex resume <sid>`，输出转发到 stdout。
   * sessionId 为空（未知真实 id）时退化到 `codex resume --last`。
   */
  private _ptyResume(sessionId: string): Promise<void> {
    const spawner = (this._ptySpawner ??= nodePtySpawner())
    const args = buildCodexArgs({ mode: 'pty', resume: true, ...(sessionId ? { sessionId } : {}) })
    return new Promise((resolve, reject) => {
      const handle = spawner.spawn(codexBin(), args)
      handle.onData((d) => process.stdout.write(d))
      handle.onExit(({ exitCode }) => {
        if (exitCode === 0) resolve()
        else reject(new Error(`codex（PTY）退出码 ${exitCode}`))
      })
    })
  }

  /** headless 续接：`codex exec resume <sid> "继续"`（无 sid → --last，新进程） */
  private _headlessResume(sessionId: string): Promise<void> {
    const args = buildCodexArgs({
      mode: 'headless',
      resume: true,
      prompt: CONTINUE_PROMPT,
      ...(sessionId ? { sessionId } : {}),
    })
    return new Promise((resolve, reject) => {
      const child = spawn(codexBin(), args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false })

      child.stdout?.on('data', (chunk: Buffer) => {
        process.stdout.write(`[jixu:codex] ${chunk.toString()}`)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(`[jixu:codex:err] ${chunk.toString()}`)
      })

      child.on('close', (code) => {
        if (code === 0 || code === null) resolve()
        else reject(new Error(`codex 进程退出码 ${code}`))
      })
      child.on('error', reject)
    })
  }
}
