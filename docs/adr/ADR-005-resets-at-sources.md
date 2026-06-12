# ADR-005：resets_at 获取优先级

> 状态：**已接受**｜日期：2026-06-12

---

## 背景

RateLimited 后，续接时机取决于速率限制何时重置（resets_at）。获取这个时间戳的途径有多个，可靠性不同。

## 决策

按以下优先级依次尝试：

### 来源 1：OAuth Usage API（首选）

```
GET https://api.anthropic.com/api/oauth/usage
Headers:
  Authorization: Bearer <accessToken>
  anthropic-beta: oauth-2025-04-20

Token 来源（按优先级）：
  macOS: 钥匙串 "Claude Code-credentials" → .claudeAiOauth.accessToken
  Linux: ~/.claude/.credentials.json       → .claudeAiOauth.accessToken

响应字段：response.five_hour.reset（Unix timestamp，秒）
```

### 来源 2：Statusline 缓存（备选）

```
文件：~/.local/share/jixu/cache/rate_limits.json
字段：rate_limits.five_hour.resets_at
更新时机：statusline 插件读到 rate_limits 数据时写入缓存
有效期：仅当 timestamp 在过去 30 分钟内认为有效
```

### 来源 3：无信息时退化

```
无 resets_at → 决策引擎走指数退避路径，不做精确 sleep
```

## 理由

- OAuth API 是最准确的来源，直接反映当前账户状态
- API 调用可能失败（网络问题），需要缓存兜底
- 缓存来自 statusline，无需额外轮询，零成本

## 后果

- `adapter-claude/usage-api.ts` 需要处理 macOS 钥匙串读取（`security find-generic-password`）和 Linux 文件读取两条路径
- 缓存文件格式需要与 statusline 插件约定（M2 阶段对齐）
- OAuth token 过期时，来源 1 会返回 401，需要 fallback 到来源 2
