# jixu（继续）

> Claude Code / Codex 会话在 API / 网络 / 限额中断后自动续上的守护工具。

## 简介

国内网络环境下，Claude Code / Codex 经常因以下原因中断会话：
- API 速率限制（五小时窗口 / 七天窗口）
- 网络连接中断（ECONNRESET / socket closed）
- 服务器过载（overloaded）
- 会话无响应（Stalled）

`jixu` 监听这些事件，在合适的时机自动续接会话，让你无需手动干预。

## 架构

三层解耦架构：

1. **归一化契约**（`@jixu/core`）—— tool-agnostic 事件/动作/能力接口
2. **工具适配器**（`@jixu/adapter-claude`、`@jixu/adapter-codex`）—— 把原生能力翻译成契约
3. **Waiter 守护进程**（`jixu`）—— 决策引擎 + 进程管理 + job 文件监听

## 快速开始

```bash
# 安装
npm install -g jixu
```

`jixu` 有两种用法：

### 前台托管（推荐）—— 看得见地续接

```bash
jixu run                    # 在当前终端用 PTY 启动 Claude Code
jixu run --tool codex       # 改托管 OpenAI Codex（codex CLI）
# 你照常交互；API 中断时，jixu 在同一个窗口里自动续接，全程可见
# 透传底层 CLI 参数：jixu run -- --model opus（或 jixu run --tool codex -- ...）
```

中断时的表现：

```
> 帮我重构这个模块
…(正常交互)…
✗ API Error: overloaded
[jixu] API 错误(overloaded)，6s 后自动续接…
…(claude --resume 重开会话)…
[jixu] 就绪，自动发送「继续」继续…
继续
…(对话在你眼前接着跑)…
```

关键点：续接（`claude --resume` / `codex resume`）只是重开会话、不会自己接着跑被打断的那一轮，
所以 jixu 会在会话**输出安静下来（判定就绪）后替你敲一次「继续」+回车**（可用下方环境变量微调）。

三类中断都接得住：**报错**（overloaded/rate_limit/ECONNRESET）、**进程退出**、**静默挂起**（不报错也不退出、长时间无输出）。

> 需要 `node-pty`（原生模块，随包作为 optionalDependency 安装；macOS/Linux）。
> 注：续接后的「就绪」判定为启发式，可用上面的环境变量微调。

### 后台守护 —— 跑长任务时自动兜底

```bash
jixu init               # 安装 Claude Code hook 到 ~/.claude/plugins/jixu（不改 settings.json）
jixu start              # 启动后台守护进程（默认托管 Claude）
jixu start --tool codex # 改托管 Codex（弱通道 tail ~/.codex/sessions 的 rollout）
jixu status             # 查看监听的 session 与续接计数
jixu stop               # 停止
```

守护进程探测中断后在后台续接（输出进 `~/.local/share/jixu/waiter.log`）：
托管 Claude 时走 hook + debug log 双通道，托管 Codex 时 tail `~/.codex/sessions` 的 rollout。

> **工具选择**：`--tool claude`（默认）/ `--tool codex`，对 `run` 与 `start` 均可用。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `JIXU_CONTINUE_PROMPT` | `继续` | 续接/试探后注入的提示语；空串则只重开、不自动发送（也禁用同会话试探） |
| `JIXU_NUDGE_QUIET_MS` | `800` | 判定「就绪」的静默时长（毫秒） |
| `JIXU_STALL_MS` | `120000` | 多久无输出判定静默挂起 → kill 重启（`0` 禁用） |
| `JIXU_PROBE_ESCALATE_MS` | `8000` | `jixu run` 检测到网络中断后，先补发「继续」试探的观察窗口；窗口内未再报错判定恢复，再报错则升级为 kill 重启（`0` 禁用试探，直接 kill） |
| `JIXU_CLAUDE_BIN` / `JIXU_CODEX_BIN` | `claude` / `codex` | 自定义可执行文件路径 |

> `jixu run` 的续接过程（检测/决策/试探/注入「继续」/结局）会写入 `~/.local/share/jixu/run.log`，
> 可 `tail -f` 回看是否成功触发了续接。

## 开发

```bash
# 安装依赖
npm install

# 运行测试
npm test

# 运行 demo（模拟 rate_limit → 自动续）
npm run demo
```

## 许可证

MIT
