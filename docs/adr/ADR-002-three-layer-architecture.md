# ADR-002：三层解耦架构与 IToolAdapter 契约

> 状态：**已接受**｜日期：2026-06-12

---

## 背景

需要支持 Claude Code，未来还要支持 Codex 等工具。如果把探测逻辑和决策逻辑耦合在一起，加新工具时会改动核心代码，风险高。

## 决策

严格三层，层间只通过接口通信：

```
Layer 1: @jixu/core       — 归一化事件/动作/能力契约（纯 TS 类型 + 纯函数）
Layer 2: @jixu/adapter-*  — 把各工具原生能力翻译成契约
Layer 3: jixu (waiter)    — 决策引擎 + 进程管理 + job 文件监听
```

### IToolAdapter 接口

```typescript
interface IToolAdapter {
  readonly id: string
  readonly capabilities: AdapterCapabilities
  resume(mode: 'headless' | 'pty', sessionId: string): Promise<void>
  usage(): Promise<UsageInfo>
  kill(pid: number): Promise<void>
}

interface AdapterCapabilities {
  errorDetect:   'strong' | 'weak'
  resetTime:     boolean
  forceContinue: boolean
}
```

### 能力降级规则

- `errorDetect: 'weak'` → 不依赖 hook 事件，改用 log-tail 兜底
- `resetTime: false` → RateLimited 时无法精准计算 sleep 时长，改用指数退避
- `forceContinue: false` → 不启用 PTY 模式，只做 headless resume

## 理由

- `@jixu/core` 完全无副作用，决策引擎可纯单测
- 加新工具只需实现 IToolAdapter，不改 core 和 waiter
- capabilities 标志位让引擎能在能力不全时优雅降级

## 后果

- CodexAdapter 必须实现 IToolAdapter，即使本期 throw NotImplemented
- adapter 内部细节（credentials 路径、log 格式）不泄露到 waiter 层
