import { randomUUID } from 'node:crypto'

/**
 * PTY 抽象层（M3）：把 node-pty 隔在接口后面，使上层（adapter / supervisor）
 * 逻辑可注入 mock 单测，且 node-pty（原生模块）惰性加载——缺失时只在真正
 * 用到 PTY 的命令里报错，不拖累守护进程与测试。
 */

export interface PtyHandle {
  readonly pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number | undefined }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface PtySpawnOptions {
  cols?: number
  rows?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface PtySpawner {
  spawn(file: string, args: string[], opts?: PtySpawnOptions): PtyHandle
}

/** node-pty 的最小形状，避免构建期硬依赖其类型 */
interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    opts: Record<string, unknown>,
  ): {
    pid: number
    onData(cb: (d: string) => void): void
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
    write(d: string): void
    resize(c: number, r: number): void
    kill(s?: string): void
  }
}

/** Claude Code 可执行文件名（可经 JIXU_CLAUDE_BIN 覆盖，便于测试/自定义路径） */
export function claudeBin(): string {
  return process.env['JIXU_CLAUDE_BIN'] ?? 'claude'
}

/** 生成一个新 session id（fresh 启动时用 --session-id 固定，便于后续 --resume） */
export function newSessionId(): string {
  return randomUUID()
}

/**
 * 构造 claude 启动参数。
 *   fresh：claude --session-id <sid> [extra]
 *   resume：claude --resume <sid> [extra]
 */
export function buildClaudeArgs(opts: {
  sessionId: string
  resume: boolean
  extraArgs?: string[]
}): string[] {
  const base = opts.resume
    ? ['--resume', opts.sessionId]
    : ['--session-id', opts.sessionId]
  return [...base, ...(opts.extraArgs ?? [])]
}

/** 默认 spawner：惰性 require node-pty（原生模块） */
export function nodePtySpawner(): PtySpawner {
  let mod: NodePtyModule
  try {
    mod = require('node-pty') as NodePtyModule
  } catch (err) {
    throw new Error(
      'PTY 模式需要 node-pty（原生模块）。请确认其安装/编译成功（npm i node-pty）。原始错误：' +
        String(err),
    )
  }
  return {
    spawn(file, args, opts = {}): PtyHandle {
      const p = mod.spawn(file, args, {
        name: 'xterm-color',
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 30,
        cwd: opts.cwd ?? process.cwd(),
        env: opts.env ?? process.env,
      })
      return {
        pid: p.pid,
        onData: (cb) => p.onData(cb),
        onExit: (cb) => p.onExit((e) => cb({ exitCode: e.exitCode, signal: e.signal })),
        write: (d) => p.write(d),
        resize: (c, r) => p.resize(c, r),
        kill: (s) => p.kill(s),
      }
    },
  }
}
