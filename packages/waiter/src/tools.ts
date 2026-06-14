import type { IToolAdapter, JixuEvent } from '@jixu/core'
import {
  ClaudeCodeAdapter,
  classifyStreamLine as claudeClassifyStreamLine,
  claudeBin,
  buildClaudeArgs,
  newSessionId as claudeNewSessionId,
  LogTailer,
  resolveLatestLog,
  defaultLogDir,
} from '@jixu/adapter-claude'
import {
  CodexAdapter,
  classifyStreamLine as codexClassifyStreamLine,
  codexBin,
  buildCodexArgs,
  newSessionId as codexNewSessionId,
  RolloutTailer,
  resolveLatestRollout,
  sessionsDir,
  sessionIdFromRolloutPath,
} from '@jixu/adapter-codex'

/**
 * 工具档案（ToolProfile）：把「某个工具相关的所有东西」收口到一处，让 supervisor /
 * daemon / main 与具体工具解耦。新增工具 = 加一个 profile，编排代码不变。
 */

export type ToolId = 'claude' | 'codex'

export interface TailerOptions {
  filePath: string
  onEvent: (event: JixuEvent, line: string) => void
  onLine?: (line: string) => void
}

export interface Tailer {
  start(): void
  stop(): void
}

export interface ToolProfile {
  id: ToolId
  /** 新建该工具的适配器（daemon 默认用它，可被显式注入覆盖） */
  makeAdapter(): IToolAdapter
  /** 流式输出逐行分类（supervisor 扫描 PTY 输出用） */
  classifyStreamLine(line: string): JixuEvent | null
  /** 可执行文件名 */
  bin(): string
  /** PTY 交互式启动参数（supervisor 的 launch 用） */
  buildArgs(opts: { sessionId: string; resume: boolean; extraArgs?: string[] }): string[]
  /** 生成 session 标签（guard 计数用） */
  newSessionId(): string
  /** 弱通道默认日志/会话目录 */
  defaultLogDir(home?: string): string
  /** 在该目录里找最新可 tail 的文件 */
  resolveLatestLog(dir: string): string | undefined
  /** 创建弱通道 tailer */
  makeTailer(opts: TailerOptions): Tailer
  /** 从弱通道文件路径推断 session id（Codex rollout 文件名含 uuid）；无则 undefined */
  sessionIdForLog?(filePath: string): string | undefined
}

const claudeProfile: ToolProfile = {
  id: 'claude',
  makeAdapter: () => new ClaudeCodeAdapter(),
  classifyStreamLine: claudeClassifyStreamLine,
  bin: claudeBin,
  buildArgs: (o) => buildClaudeArgs(o),
  newSessionId: claudeNewSessionId,
  defaultLogDir: (home) => defaultLogDir(home),
  resolveLatestLog: (dir) => resolveLatestLog(dir),
  makeTailer: (o) => new LogTailer(o),
}

const codexProfile: ToolProfile = {
  id: 'codex',
  makeAdapter: () => new CodexAdapter(),
  classifyStreamLine: codexClassifyStreamLine,
  bin: codexBin,
  buildArgs: (o) =>
    buildCodexArgs({ mode: 'pty', resume: o.resume, ...(o.extraArgs ? { extraArgs: o.extraArgs } : {}) }),
  newSessionId: codexNewSessionId,
  defaultLogDir: (home) => sessionsDir(home),
  resolveLatestLog: (dir) => resolveLatestRollout(dir),
  makeTailer: (o) => new RolloutTailer(o),
  sessionIdForLog: (filePath) => sessionIdFromRolloutPath(filePath) ?? undefined,
}

const PROFILES: Record<ToolId, ToolProfile> = {
  claude: claudeProfile,
  codex: codexProfile,
}

export function isToolId(s: string | undefined): s is ToolId {
  return s === 'claude' || s === 'codex'
}

export function getProfile(id: ToolId = 'claude'): ToolProfile {
  return PROFILES[id]
}

/**
 * 从参数数组里解析 `--tool <id>` / `--tool=<id>`（在 `--` 之前有效）。
 * 返回选定工具与剩余参数（剩余参数原样透传给底层 CLI）。未指定 → claude。
 */
export function parseToolFlag(args: string[]): { tool: ToolId; rest: string[] } {
  let tool: ToolId = 'claude'
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--') {
      rest.push(...args.slice(i)) // `--` 及其后全部透传
      break
    }
    if (a === '--tool') {
      const v = args[i + 1]
      if (isToolId(v)) tool = v
      i++ // 消费值（即使非法也跳过，避免误传给 CLI）
      continue
    }
    const m = a.match(/^--tool=(.+)$/)
    if (m) {
      const val = m[1]
      if (isToolId(val)) tool = val
      continue
    }
    rest.push(a)
  }
  return { tool, rest }
}
