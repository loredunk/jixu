# ADR-007：分发策略（npm 包 + CC Plugin 分离）

> 状态：**已接受**｜日期：2026-06-12

---

## 背景

jixu 由两个独立部分组成：常驻守护进程（waiter）和 CC hook 脚本。两者的安装方式、更新频率和权限模型不同，需要分别考虑分发渠道。

## 决策

### Waiter → npm 包

```
包名：jixu（主入口）
子包：@jixu/core, @jixu/adapter-claude, @jixu/adapter-codex

安装：npm install -g jixu  或  npx jixu <command>
命令：npx jixu start|stop|status|init
```

### Hook 脚本 → CC Plugin

```
插件包含：
  manifest.json   — CC plugin 清单（名称、版本、权限）
  hooks.json      — 引用脚本用 ${CLAUDE_PLUGIN_ROOT}/stop-failure.sh
  stop-failure.sh — StopFailure hook 脚本

安装方式：用户运行 npx jixu init 后，自动将 hook 配置写入
         ~/.claude/plugins/jixu/（不修改全局 settings.json）
```

### 严格禁止

- **不在 postinstall 偷改 settings.json**：安装 npm 包时不自动修改 CC 配置，只有用户主动运行 `jixu init` 才写 hook
- **不使用绝对路径**：hooks.json 中引用脚本只用 `${CLAUDE_PLUGIN_ROOT}`

## 理由

- 守护进程需要长期运行和更新，npm 是标准分发方式
- Hook 与 CC 生命周期绑定，放在 CC plugin 目录更合适
- postinstall 偷改配置是恶意行为，损害用户信任
- `${CLAUDE_PLUGIN_ROOT}` 确保跨用户、跨机器的可移植性

## 后果

- `npx jixu init` 必须幂等（重复运行不产生副作用）
- plugin 版本和 npm 包版本需要同步（init 时从 npm 包复制 hook 脚本）
- CC marketplace 审核时 hooks.json 路径规范必须满足平台要求
