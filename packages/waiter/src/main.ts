#!/usr/bin/env node
import { openSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Daemon } from './daemon.js'
import { installHookPlugin } from './init.js'
import { readState } from './state.js'
import { pidFilePath, logFilePath, stateFilePath } from './paths.js'
import {
  readLivePid,
  acquireLock,
  releaseLock,
  killAndWait,
  spawnDaemon,
  DaemonAlreadyRunningError,
} from './process-mgr.js'

const USAGE = '用法: jixu start|stop|status|init'

async function main(): Promise<number> {
  const cmd = process.argv[2]
  switch (cmd) {
    case 'start':
      return cmdStart()
    case '__daemon': // 内部：被 start detached 拉起的实际守护进程
      return cmdDaemon()
    case 'stop':
      return cmdStop()
    case 'status':
      return cmdStatus()
    case 'init':
      return cmdInit()
    default:
      console.error(USAGE)
      return 1
  }
}

function cmdStart(): number {
  const pidFile = pidFilePath()
  const running = readLivePid(pidFile)
  if (running !== null) {
    console.error(`jixu 已在运行（pid ${running}）`)
    return 1
  }

  mkdirSync(dirname(pidFile), { recursive: true })
  const logFile = logFilePath()
  const logFd = openSync(logFile, 'a') // 守护进程的 stdout/stderr 重定向到日志

  const childPid = spawnDaemon(process.argv[1] as string, ['__daemon'], logFd)
  writeFileSync(pidFile, String(childPid))

  console.log(`jixu 守护进程已启动（pid ${childPid}）`)
  console.log(`日志：${logFile}`)
  return 0
}

function cmdDaemon(): number {
  const pidFile = pidFilePath()
  try {
    acquireLock(pidFile)
  } catch (err) {
    if (err instanceof DaemonAlreadyRunningError) {
      console.error(err.message)
      return 1
    }
    throw err
  }

  // stdout/stderr 已被 start 重定向到 waiter.log；logger 再 echoStderr 会写两遍，故关掉。
  // 未经 logger 的崩溃堆栈仍会经 stderr 落到日志文件。
  const daemon = new Daemon({ echoStderr: false })
  daemon.start()

  const shutdown = (): void => {
    void daemon.stop().finally(() => {
      releaseLock(pidFile)
      process.exit(0)
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // 不返回——靠 fs.watch / 定时器保持事件循环存活
  return 0
}

async function cmdStop(): Promise<number> {
  const pidFile = pidFilePath()
  const pid = readLivePid(pidFile)
  if (pid === null) {
    console.log('jixu 未在运行')
    releaseLock(pidFile, readStaleOwner(pidFile)) // 清理可能的陈旧锁
    return 0
  }
  await killAndWait(pid)
  releaseLock(pidFile, pid)
  console.log(`jixu 守护进程已停止（pid ${pid}）`)
  return 0
}

function readStaleOwner(pidFile: string): number {
  // 仅用于 releaseLock 的参数匹配；读不到就给 -1（不会误删）
  const s = readState(stateFilePath())
  return s?.pid ?? -1
}

function cmdStatus(): number {
  const pid = readLivePid(pidFilePath())
  if (pid === null) {
    console.log('jixu 未在运行')
    return 0
  }
  console.log(`jixu 运行中（pid ${pid}）`)

  const state = readState(stateFilePath())
  if (!state) {
    console.log('（暂无状态快照）')
    return 0
  }
  const uptimeS = Math.round((Date.now() - state.startedAt) / 1000)
  console.log(`运行时长：${uptimeS}s`)
  console.log(`job 目录：${state.jobsDir}`)
  if (state.lastDecision) console.log(`最近决策：${state.lastDecision}`)

  const sessions = Object.entries(state.guardCounts)
  if (sessions.length === 0) {
    console.log('监听中的 session：无')
  } else {
    console.log('监听中的 session（续接计数）：')
    for (const [sid, n] of sessions) console.log(`  ${sid}: ${n}`)
  }
  if (state.haltedSessions.length > 0) {
    console.log(`已停手（需人工介入）：${state.haltedSessions.join(', ')}`)
  }
  return 0
}

function cmdInit(): number {
  try {
    const result = installHookPlugin()
    console.log(`已安装 jixu hook plugin → ${result.installedTo}`)
    console.log(`复制文件：${result.copied.join(', ')}`)
    console.log('未修改任何 settings.json。重启 Claude Code 后 hook 生效。')
    return 0
  } catch (err) {
    console.error(`init 失败：${String(err)}`)
    return 1
  }
}

main()
  .then((code) => {
    // __daemon 与长驻命令不主动退出；其余命令按返回码退出
    if (process.argv[2] !== '__daemon') process.exit(code)
  })
  .catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
