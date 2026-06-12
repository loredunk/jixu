# ADR-003：StopFailure Hook 只写 job 文件，立即返回

> 状态：**已接受**｜日期：2026-06-12

---

## 背景

CC 的 StopFailure hook 在会话停止时被调用。如果 hook 内部 sleep 等待（例如等速率限制重置），会导致 CC 进程挂起，无法干净退出，续接时会出现 "rewake" 死循环——CC 以为上一个会话还在，新进程无法正常取得资源。

## 决策

StopFailure hook 脚本的唯一职责是：
1. 把事件信息（类型、session_id、pid、resets_at）写入 job 文件
2. 立即打印 `{}` 并退出（返回码 0）

所有等待逻辑（sleep until resets_at）在 Waiter 进程中执行，通过 FSWatch 感知 job 文件触发。

```bash
#!/usr/bin/env bash
# 全部逻辑：写文件 + 退出
JOB_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/jixu/jobs"
mkdir -p "$JOB_DIR"
# ... 构造 JSON 写入 $JOB_DIR/$SESSION_ID.job.json
echo '{}'   # 干净返回
```

## 理由

- 避免 hook 阻塞导致 CC 进程无法终止
- 关注点分离：探测归 hook，决策和等待归 Waiter
- hook 崩溃不影响 Waiter 的其他 session 监控

## 后果

- Hook 无法直接触发 resume，必须通过 job 文件 + Waiter 中转
- job 文件目录 `~/.local/share/jixu/jobs/` 成为唯一的 hook→waiter 通信通道
- hook 脚本必须在 bash 中完成 JSON 序列化，不依赖外部工具
