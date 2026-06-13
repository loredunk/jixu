# jixu（继续）

> Claude Code 会话在 API / 网络 / 限额中断后自动续上的守护工具。

## 简介

国内网络环境下，Claude Code 经常因以下原因中断会话：
- API 速率限制（五小时窗口 / 七天窗口）
- 网络连接中断（ECONNRESET / socket closed）
- 服务器过载（overloaded）
- 会话无响应（Stalled）

`jixu` 作为常驻守护进程，监听这些事件并在合适的时机自动执行 `claude --resume`，让你无需手动干预。

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
jixu run            # 在当前终端用 PTY 启动 Claude Code
# 你照常交互；API 中断时，jixu 在同一个窗口里自动续接，全程可见
# 透传 claude 参数：jixu run -- --model opus
```

中断时的表现：

```
> 帮我重构这个模块
…(正常交互)…
✗ API Error: overloaded
[jixu] 检测到 overloaded，12s 后在本窗口自动续接…
[jixu] 续接 → 继续
…(对话在你眼前接着跑)…
```

> 需要 `node-pty`（原生模块，随包作为 optionalDependency 安装；macOS/Linux）。

### 后台守护 —— 跑长任务时自动兜底

```bash
jixu init     # 安装 Claude Code hook 到 ~/.claude/plugins/jixu（不改 settings.json）
jixu start    # 启动后台守护进程
jixu status   # 查看监听的 session 与续接计数
jixu stop     # 停止
```

守护进程通过 hook + 日志双通道探测中断，headless 在后台续接（输出进 `~/.local/share/jixu/waiter.log`）。

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
