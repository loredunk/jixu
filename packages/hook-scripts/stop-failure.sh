#!/usr/bin/env bash
# stop-failure.sh — StopFailure hook
#
# 职责：把 CC 传入的 payload 写入 job 文件，立即返回 {}，绝不 sleep。
# 事件分类由 waiter（TypeScript）通过 classifyHookPayload() 完成。
# waiter 通过 FSWatch 感知 job 文件，负责所有等待和续接逻辑。
#
# CC 通过 stdin 传入 JSON payload。
# 环境变量（CC 注入）：
#   CLAUDE_SESSION_ID      — 当前会话 ID
#   CLAUDE_TRANSCRIPT_PATH — transcript 路径（备选 session_id 来源）
#   CLAUDE_PID             — CC 进程 PID

set -euo pipefail

JOB_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/jixu/jobs"
mkdir -p "$JOB_DIR"

# 一次性读取 stdin
PAYLOAD=$(cat)

# 提取 session_id（优先环境变量，其次 transcript 路径）
SESSION_ID="${CLAUDE_SESSION_ID:-}"
if [ -z "$SESSION_ID" ]; then
  TRANSCRIPT="${CLAUDE_TRANSCRIPT_PATH:-}"
  if [ -n "$TRANSCRIPT" ]; then
    SESSION_ID=$(basename "$TRANSCRIPT" .jsonl 2>/dev/null || true)
  fi
fi
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="unknown-$(date +%s)"
fi

PID="${CLAUDE_PID:-0}"
TIMESTAMP_MS=$(date +%s)000  # 秒 → 毫秒（兼容 macOS / Linux）

# 写到临时文件再 mv，避免 waiter 读到半写状态
JOB_FILE="$JOB_DIR/${SESSION_ID}.job.json"
TMP_FILE="${JOB_FILE}.tmp.$$"

# 用 printf %s 安全地把 payload 嵌入 JSON
# waiter 读取 rawPayload 后调用 classifyHookPayload() 确定事件类型
printf '{"sessionId":"%s","pid":%s,"timestamp":%s,"rawPayload":%s}\n' \
  "$SESSION_ID" \
  "$PID" \
  "$TIMESTAMP_MS" \
  "$PAYLOAD" \
  > "$TMP_FILE" 2>/dev/null || {
    # payload 不是合法 JSON 时，用字符串形式包装
    ESCAPED=$(printf '%s' "$PAYLOAD" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/g' | tr -d '\n' | sed 's/\\n$//')
    printf '{"sessionId":"%s","pid":%s,"timestamp":%s,"rawPayload":"%s"}\n' \
      "$SESSION_ID" "$PID" "$TIMESTAMP_MS" "$ESCAPED" \
      > "$TMP_FILE"
  }

mv "$TMP_FILE" "$JOB_FILE"

# 干净返回，让 CC 正常退出（不 block、不 sleep）
echo '{}'
