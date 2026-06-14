/**
 * demo/simulate.ts
 *
 * 演示：模拟一个 rate_limit job（resets_at: 现在 + 3s）
 *       → 引擎决策 → 等待 → 触发 headless resume（mock，不真实调用 claude）
 *
 * 运行：npm run demo
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  decide,
  freshGuardState,
  guardIncrement,
  SLEEP_BUFFER_MS,
} from '../packages/core/src/index.js'
import type { JobFile } from '../packages/core/src/index.js'
import { classifyHookPayload } from '../packages/adapter-claude/src/index.js'

async function main(): Promise<void> {
  // ── 配置 ───────────────────────────────────────────────────────────────
  const JOB_DIR = join(homedir(), '.local', 'share', 'jixu', 'jobs')
  const SESSION_ID = 'demo-sess-rate-limit-001'
  const DEMO_SLEEP_SEC = 3
  // demo 用极小缓冲让链路在 ~3s 内跑完；生产默认 SLEEP_BUFFER_MS=30s
  const DEMO_BUFFER_MS = 500

  // ── Step 1：模拟 CC StopFailure hook 写入的 job 文件 ───────────────────
  mkdirSync(JOB_DIR, { recursive: true })

  const nowMs = Date.now()
  const resets_at = nowMs + DEMO_SLEEP_SEC * 1000

  const mockHookPayload = JSON.stringify({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: 'Rate limit exceeded',
      resets_at,
    },
    stop_reason: 'error',
  })

  const rawJobFile = {
    sessionId: SESSION_ID,
    pid: process.pid,
    timestamp: nowMs,
    rawPayload: JSON.parse(mockHookPayload) as unknown,
  }
  const jobPath = join(JOB_DIR, `${SESSION_ID}.job.json`)
  writeFileSync(jobPath, JSON.stringify(rawJobFile, null, 2))

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(' jixu demo — 模拟 rate_limit → 自动续接')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('\n[Step 1] CC StopFailure hook 写入 job 文件')
  console.log(`  路径：${jobPath}`)
  console.log(`  rawPayload 类型：${(rawJobFile.rawPayload as { type?: string }).type ?? '?'}`)

  // ── Step 2：waiter 读取 job 文件，分类事件 ────────────────────────────
  console.log('\n[Step 2] Waiter 分类事件')
  const event = classifyHookPayload(mockHookPayload)
  if (!event) {
    throw new Error('无法识别事件类型')
  }
  console.log(`  事件：${JSON.stringify(event)}`)

  // ── Step 3：决策引擎 ──────────────────────────────────────────────────
  console.log('\n[Step 3] 决策引擎')
  const guardState = freshGuardState()
  const decision = decide(event, SESSION_ID, guardState, { random: () => 0, sleepBufferMs: DEMO_BUFFER_MS })
  console.log(`  决策：${JSON.stringify(decision)}`)

  if (decision.action !== 'sleep') {
    throw new Error(`预期 sleep 决策，实际得到 ${decision.action}`)
  }

  // ── Step 4：等待 resets_at ─────────────────────────────────────────────
  const waitMs = Math.max(decision.until - Date.now(), 0)
  console.log('\n[Step 4] 等待限额重置')
  console.log(`  resets_at：${new Date(resets_at).toISOString()}`)
  console.log(`  resets_at 安全缓冲：${DEMO_BUFFER_MS}ms（生产默认 ${SLEEP_BUFFER_MS}ms）`)
  console.log(`  实际等待：${(waitMs / 1000).toFixed(1)}s ...`)

  await new Promise<void>((resolve) => { setTimeout(resolve, waitMs) })

  // ── Step 5：触发 resume ────────────────────────────────────────────────
  console.log('\n[Step 5] 触发 headless resume（演示 mock）')
  console.log(`  命令：claude -p --resume ${SESSION_ID} "继续"`)
  console.log('  （演示模式：未实际调用 claude）')

  // ── Step 6：guard 状态更新 ────────────────────────────────────────────
  const newGuardState = guardIncrement(guardState, SESSION_ID)
  console.log('\n[Step 6] Guard 状态更新')
  console.log(`  续接次数：${newGuardState.counts[SESSION_ID] ?? 0} / 3`)

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(' ✓ demo 完成：rate_limit → 等待 → headless resume 链路验证通过')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch((err: unknown) => {
  console.error('demo 失败：', err)
  process.exit(1)
})
