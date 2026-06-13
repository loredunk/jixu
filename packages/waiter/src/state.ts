import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Waiter 运行时状态，写到 waiter.state.json 供 `jixu status` 读取。
 * 仅快照用途，不是权威数据源（权威是内存里的 guard 等）。
 */
export interface WaiterState {
  pid: number
  startedAt: number // Unix ms
  jobsDir: string
  guardCounts: Record<string, number>
  haltedSessions: string[]
  lastEventAt?: number
  lastDecision?: string
}

export function initialState(pid: number, jobsDir: string, now: number): WaiterState {
  return {
    pid,
    startedAt: now,
    jobsDir,
    guardCounts: {},
    haltedSessions: [],
  }
}

export function writeState(path: string, state: WaiterState): void {
  mkdirSync(dirname(path), { recursive: true })
  // 临时文件 + 同目录 rename（原子），避免 status 读到半写状态
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, path)
}

export function readState(path: string): WaiterState | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as WaiterState
  } catch {
    return null
  }
}
