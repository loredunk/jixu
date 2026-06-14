import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * 守护进程生命周期：PID 锁（防重复启动 + 陈旧锁回收）、kill+等待退出（ADR-006）、
 * detached 拉起后台进程。
 */

export class DaemonAlreadyRunningError extends Error {
  constructor(public readonly pid: number) {
    super(`jixu 守护进程已在运行（pid ${pid}）`)
    this.name = 'DaemonAlreadyRunningError'
  }
}

/** 进程是否存活。EPERM 表示存在但无权限发信号，仍视为存活。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function readPidFile(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, 'utf-8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** 返回正在运行的守护进程 pid；pid 文件指向死进程时视为无主，返回 null */
export function readLivePid(path: string): number | null {
  const pid = readPidFile(path)
  if (pid === null) return null
  return isProcessAlive(pid) ? pid : null
}

/**
 * 抢占 PID 锁。已有存活守护进程 → 抛 DaemonAlreadyRunningError；
 * 陈旧锁（指向死进程）→ 直接覆盖。
 */
export function acquireLock(path: string, pid: number = process.pid): void {
  const existing = readLivePid(path)
  if (existing !== null && existing !== pid) {
    throw new DaemonAlreadyRunningError(existing)
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, String(pid))
}

/** 释放锁（只删自己持有的，避免误删别人的锁） */
export function releaseLock(path: string, pid: number = process.pid): void {
  if (readPidFile(path) === pid) {
    try {
      rmSync(path, { force: true })
    } catch {
      /* ignore */
    }
  }
}

export interface KillOptions {
  /** SIGTERM 后等待干净退出的时间，超时升级 SIGKILL */
  graceMs?: number
  pollMs?: number
}

/**
 * 发 SIGTERM，轮询等待退出；graceMs 内未退出则 SIGKILL（ADR-006）。
 * 进程本就不存在（ESRCH）视为已退出。
 */
export function killAndWait(pid: number, opts: KillOptions = {}): Promise<void> {
  const graceMs = opts.graceMs ?? 3_000
  const pollMs = opts.pollMs ?? 100
  return new Promise((resolve) => {
    try {
      process.kill(pid, 'SIGTERM')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return resolve()
      // 其他错误（如 EPERM）也无法继续，直接返回
      return resolve()
    }

    const deadline = Date.now() + graceMs
    const timer = setInterval(() => {
      if (!isProcessAlive(pid)) {
        clearInterval(timer)
        return resolve()
      }
      if (Date.now() >= deadline) {
        clearInterval(timer)
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* 已退出 */
        }
        return resolve()
      }
    }, pollMs)
    timer.unref?.()
  })
}

/**
 * detached 拉起后台守护进程（用同一运行时重新执行入口 + 内部参数）。
 * 返回子进程 pid。生产路径是 node dist/main.js。
 */
export function spawnDaemon(entry: string, args: string[], stdioTarget: number): number {
  const child = spawn(process.execPath, [entry, ...args], {
    detached: true,
    stdio: ['ignore', stdioTarget, stdioTarget],
  })
  child.unref()
  if (child.pid === undefined) {
    throw new Error('无法拉起守护进程子进程')
  }
  return child.pid
}
