import { randomUUID } from 'node:crypto'

/**
 * PTY 抽象层：把 node-pty 隔在接口后面，使上层（adapter / supervisor）逻辑可
 * 注入 mock 单测，且 node-pty（原生模块）惰性加载——缺失时只在真正用到 PTY 的
 * 命令里报错。与 @jixu/adapter-claude 同形，刻意各自独立以保持适配器解耦。
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

/** Codex 可执行文件名（可经 JIXU_CODEX_BIN 覆盖，便于测试/自定义路径） */
export function codexBin(): string {
  return process.env['JIXU_CODEX_BIN'] ?? 'codex'
}

/**
 * 生成一个 session 标签。注意：Codex 不支持预设 session id，此值仅供 jixu
 * 内部 guard 计数/日志使用；真正续接靠 `codex resume --last`（最近会话）或
 * 从 rollout 提取的真实 id。
 */
export function newSessionId(): string {
  return randomUUID()
}

export interface CodexArgsOptions {
  mode: 'pty' | 'headless'
  resume: boolean
  /** 真实的 Codex session id；resume 时缺省则用 --last（最近会话） */
  sessionId?: string
  /** headless 续接时附带的后续提示语 */
  prompt?: string
  extraArgs?: string[]
}

/**
 * 构造 codex 启动参数。
 *   pty  fresh : codex                              [extra]
 *   pty  resume: codex resume <sid|--last>          [extra]
 *   exec fresh : codex exec [prompt]                [extra]
 *   exec resume: codex exec resume <sid|--last> [prompt] [extra]
 */
export function buildCodexArgs(opts: CodexArgsOptions): string[] {
  const extra = opts.extraArgs ?? []
  const target = opts.sessionId ? [opts.sessionId] : ['--last']
  const promptArgs = opts.prompt ? [opts.prompt] : []

  if (opts.mode === 'pty') {
    if (!opts.resume) return [...extra]
    return ['resume', ...target, ...extra]
  }
  // headless（codex exec）
  if (!opts.resume) return ['exec', ...promptArgs, ...extra]
  return ['exec', 'resume', ...target, ...promptArgs, ...extra]
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
