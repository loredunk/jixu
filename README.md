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

# 初始化（安装 Claude Code hook）
npx jixu init

# 启动守护进程
npx jixu start

# 查看状态
npx jixu status

# 停止
npx jixu stop
```

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
