# ADR-001：Monorepo + npm workspaces 技术栈选择

> 状态：**已接受**｜日期：2026-06-12

---

## 背景

jixu 由三层独立包组成（core / adapter-* / waiter），需要决定如何组织代码库和选择语言。

## 决策

- **语言**：TypeScript（Node.js 运行时）
- **包管理**：npm workspaces monorepo，根目录统一管理依赖
- **构建**：esbuild 或 tsc，按包独立编译
- **测试**：Vitest（兼容 Jest API，速度更快，支持 ESM）

## 理由

1. TypeScript 在 Node 生态中类型安全，且 CC hook 脚本（bash）可与 TS 进程无缝通信（JSON 文件）
2. npm workspaces 允许各包独立发布（@jixu/core、@jixu/adapter-claude、jixu），同时共享 node_modules
3. Vitest 对 monorepo 友好，fixtures 驱动的单测写起来简洁

## 后果

- 每个包有独立的 package.json 和 tsconfig.json
- `packages/core` 不依赖任何其他内部包
- `packages/adapter-*` 依赖 core，不依赖 waiter
- `packages/waiter` 依赖 core 和具体 adapter
