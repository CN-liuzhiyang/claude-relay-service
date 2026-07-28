# ChatGPT 订阅账号（platform=`openai`）对接说明

本文记录 ChatGPT 订阅账号（OAuth 登录、走 Codex 后端，区别于 API Key 版的
`openai-responses`）的上游接口约束、数据结构，以及**尚未实现的重置卡消费功能**及其
未完成的原因。

> 所有结论均在 2026-07-28 用真实 Plus 账号实测得出。上游是私有接口，随时可能变，
> 改动前建议先按「如何复现验证」一节重新打一遍。

---

## 1. 速率窗口：primary 已变成 7 天，secondary 已取消

2026-07 前后 OpenAI 调整了订阅账号的限额模型：

| | 变更前 | 变更后（当前） |
|---|---|---|
| primary 窗口 | 5 小时（`windowMinutes=300`） | **7 天**（`windowMinutes=10080`） |
| secondary 窗口 | 7 天 | **已取消**，字段返回全 0 / `null` |

**上游响应头没有变**，`x-codex-primary-*` / `x-codex-secondary-*` 依然照常返回，
变的只是数值语义。所以后端解析逻辑无需改动，
但**任何按 primary/secondary 硬编码窗口名称的地方都是错的**。

历史上前端就是这么写死的（primary→"5h"、secondary→"周限"），导致界面出现
"5h ... 重置剩余 6天19小时" 这种自相矛盾的显示。现已改为由 `windowMinutes` 推导，
见 `web/admin-spa/src/utils/codexUsage.js` 的 `formatCodexWindowLabel()`。

**注意**：secondary 取消后上游持续返回 `0`（不是 `null`），所以"是否有数据"必须判
`> 0` 而不是 `!== null`，否则界面会渲染出一条永远 0% / 重置剩余 0 秒的空窗口。
见 `buildCodexUsageSnapshot()` 里的 `hasWindowData()`。

---

## 2. 上游端点清单

Base：`https://chatgpt.com/backend-api`

| 方法 | 路径 | 用途 | 消耗配额 | 状态 |
|---|---|---|---|---|
| POST | `/codex/responses` | 转发 / 连通性测试 | ✅ 是 | 已用 |
| GET | `/wham/usage` | 用量 + 积分 + 重置卡计数 | ❌ 否 | 已用 |
| GET | `/wham/rate-limit-reset-credits` | 重置卡明细列表 | ❌ 否 | 已用 |
| POST | `/wham/rate-limit-reset-credits/consume` | 消费一张重置卡 | ❌ 否 | **未实现，见第 6 节** |

> ⚠️ **路径陷阱**：Codex CLI 二进制里还存在一套 `/backend-api/api/codex/*` 的同名路径
> （`/api/codex/usage`、`/api/codex/rate-limit-reset-credits` 等）。这些是历史/别名路径，
> **实测全部返回 404**，不要用。只有 `/wham/*` 那套是活的。

鉴权只需要两个头，多余的头不影响结果：

```
Authorization: Bearer <accessToken>
User-Agent: codex_cli_rs
```

（`chatgpt-account-id` 对这两个 GET 加不加都一样；但转发 `/codex/responses` 时必须带。）

---

## 3. `/wham/usage` 返回结构（实测样本）

```json
{
  "user_id": "user-xxx",
  "account_id": "user-xxx",
  "email": "xxx@gmail.com",
  "plan_type": "plus",
  "rate_limit": {
    "allowed": true,
    "limit_reached": false,
    "primary_window": {
      "used_percent": 4,
      "limit_window_seconds": 604800,
      "reset_after_seconds": 585282,
      "reset_at": 1785819459
    },
    "secondary_window": null
  },
  "code_review_rate_limit": null,
  "additional_rate_limits": null,
  "credits": {
    "has_credits": false,
    "unlimited": false,
    "overage_limit_reached": false,
    "balance": "0",
    "approx_local_messages": [0, 0],
    "approx_cloud_messages": [0, 0]
  },
  "spend_control": { "reached": false, "individual_limit": null },
  "rate_limit_reached_type": null,
  "promo": null,
  "rate_limit_reset_credits": {
    "available_count": 2,
    "applicable_available_count": 0
  }
}
```

### `available_count` vs `applicable_available_count` —— 两者语义不同且会不一致

这是设计 UI 时最容易踩的坑，实测出现过 `available=2` 而 `applicable=0`：

| 字段 | 含义 | 用途 |
|---|---|---|
| `available_count` | 手上有几张没用过的卡 | 常驻展示「重置卡 ×N」 |
| `applicable_available_count` | **此刻**能不能用 | consume 按钮的 enable 条件 |

没撞限流时没有东西可重置，所以 `applicable` 为 0 —— 有卡不等于现在能用。
**不要拿 `available_count` 去 enable 消费按钮**，那会给用户一个点了必然失败的按钮。

---

## 4. `/wham/rate-limit-reset-credits` 返回结构（实测样本）

```json
{
  "credits": [
    {
      "id": "RateLimitResetCredit_c69906e329c081918daf50017dfb632d",
      "reset_type": "codex_rate_limits",
      "is_supported_by_plan": true,
      "status": "available",
      "granted_at": "2026-07-01T20:27:50.281921Z",
      "expires_at": "2026-07-31T20:27:50.281921Z",
      "redeem_started_at": null,
      "redeemed_at": null,
      "profile_image_url": "https://openaiassets.blob.core.windows.net/$web/codex/codex-icon-200.png",
      "profile_user_id": "Codex Team",
      "title": "Full reset",
      "description": "Thanks for using Codex! You've been granted one free rate limit reset."
    }
  ],
  "available_count": 2,
  "total_earned_count": 1
}
```

要点：

- **卡有 30 天有效期**（`granted_at` + 30 天 = `expires_at`），过期作废，值得在 UI 上做临期高亮
- `status` 从 Codex 二进制符号表可知取值包含
  `available` / `granted` / `consumed` / `redeemed` / `expired`，实测只见过 `available`
- **`total_earned_count` 不等于卡的总数**（实测 2 张卡但该值为 1），语义不明，
  **UI 不要用这个字段**，用 `available_count`

---

## 5. `/codex/responses` 对订阅账号的三个硬约束

违反任何一条都是 400，且错误体格式是 `{"detail": "..."}`（不是标准的 `{"error": {...}}`）：

| 约束 | 违反时的报错 |
|---|---|
| `stream` 必须为 `true` | `Stream must be set to true` |
| 不能带 `max_output_tokens` | `Unsupported parameter: max_output_tokens` |
| 模型必须是订阅账号专属的那批 | `The 'xxx' model is not supported when using Codex with a ChatGPT account.` |

`input` 里 `content` 用扁平字符串或结构化数组（`[{type:'input_text',text:'hi'}]`）都可以。

### 订阅账号可用模型 ≠ API Key 可用模型

`config/models.js` 里的 `OPENAI_MODELS`（`gpt-5`、`gpt-5.1-codex` 等）是给
**API Key 版**（`openai-responses`）用的，这些名字在订阅账号上一律 400。

订阅账号专属列表见 `config/models.js` 的 `CODEX_SUBSCRIPTION_MODELS`。
该列表来源是 Codex CLI 自己缓存的模型清单：

```bash
python3 -c "
import json
d = json.load(open('$HOME/.codex/models_cache.json'))
for m in d['models']:
    print(m['slug'], m.get('visibility'), m.get('display_name'))
"
```

**上游新增/下线模型时需要手动同步这个列表。**

---

## 6. 未实现：消费重置卡（`/consume`）

### 现状

只读部分已完成：拉取、落库、展示（徽章 + 临期高亮 + tooltip）。
**消费功能没有实现**，`POST /wham/rate-limit-reset-credits/consume` 一次都没有调用过。

### 为什么没做

1. **无法端到端验证**。消费只在撞到限额时才有意义，而验证时账号
   `applicable_available_count = 0`（用量仅 4%，`limit_reached: false`）。
   在这个状态下调用 consume 大概率直接被拒，验证不了成功路径。
2. **不可逆**。卡用掉就没了，盲写一个没验证过的不可逆接口风险不对等。
3. **请求体格式未知**。Codex 二进制里看不出参数结构，不确定是否需要传 `credit_id`
   （列表里有 `id` 字段，推测要传，但没证据）。

### 要接的话，需要先验证什么

必须在**账号真正撞到 7 天限额**时才能验证，届时需要确认：

- [ ] 请求体格式：空 body？还是 `{"credit_id": "RateLimitResetCredit_xxx"}`？
- [ ] 返回结构，以及失败时（无适用卡 / 卡已过期）的错误格式
- [ ] 消费后 `status`、`redeem_started_at`、`redeemed_at` 三个字段如何变化
      —— 决定了 UI 上「使用中」和「已使用」怎么区分
- [ ] 重置是立即生效还是异步（`redeem_started_at` 和 `redeemed_at` 是两个字段，
      暗示可能存在中间态）

### 实现时的约束

- **必须**以 `applicable_available_count > 0` 作为按钮 enable 条件（原因见第 3 节）
- **必须**管理员手动点击 + 二次确认，**不要做成 429 时自动消费** ——
  一次调度抖动就可能白烧一张卡
- 消费后应立即调 `fetchCodexUsageFromApi()` 刷新，不要本地推算状态

---

## 7. 相关代码位置

| 功能 | 位置 |
|---|---|
| 响应头解析用量 | `src/services/account/openaiAccountService.js` → `extractCodexUsageHeaders()` |
| 主动拉取用量+重置卡 | 同上 → `fetchCodexUsageFromApi()` |
| 快照组装（供前端） | 同上 → `buildCodexUsageSnapshot()` / `buildResetCreditsSnapshot()` |
| 连通性测试 | 同上 → `testAccountConnection()` |
| 30 分钟自动刷新 | 同上 → `startCodexUsageRefresh()`，在 `src/app.js` 启动 |
| Admin 路由 | `src/routes/admin/openaiAccounts.js` → `/:accountId/test`、`/:accountId/refresh-usage` |
| 定时测试 | `src/services/accountTestSchedulerService.js` → `_testOpenAIAccount()` |
| 订阅账号模型列表 | `config/models.js` → `CODEX_SUBSCRIPTION_MODELS` |
| 前端窗口标签/进度条 | `web/admin-spa/src/utils/codexUsage.js` |
| 前端重置卡徽章 | `web/admin-spa/src/components/accounts/CodexResetCreditsBadge.vue` |

### 相关环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CODEX_USAGE_REFRESH_ENABLED` | `true` | 是否启用用量自动刷新 |
| `CODEX_USAGE_REFRESH_INTERVAL_MINUTES` | `30` | 刷新间隔（分钟） |

---

## 8. 如何复现验证

上游是私有接口，改动前建议重新验证一遍。用账号自己的代理和 token 直接打：

```js
// NODE_PATH=/path/to/claude-relay-service/node_modules node this.js <accountId>
const axios = require('axios')
const redis = require('./src/models/redis')
const svc = require('./src/services/account/openaiAccountService')
const ProxyHelper = require('./src/utils/proxyHelper')

;(async () => {
  await redis.connect()
  const id = process.argv[2]
  const { accessToken, proxy } = await svc.getValidAccessToken(id)
  const cfg = {
    headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'codex_cli_rs' },
    validateStatus: () => true
  }
  const agent = ProxyHelper.createProxyAgent(proxy)
  if (agent) Object.assign(cfg, { httpAgent: agent, httpsAgent: agent, proxy: false })

  for (const p of ['/wham/usage', '/wham/rate-limit-reset-credits']) {
    const r = await axios.get(`https://chatgpt.com/backend-api${p}`, cfg)
    console.log(p, '->', r.status, JSON.stringify(r.data, null, 2))
  }
  process.exit(0)
})()
```

### 常见排查

- **401 `token_revoked`**：账号在别处重新登录会吊销旧的 token 链。此时
  accessToken 的 JWT `exp` 可能还没到（本地看着没过期），但上游已经作废，
  且 refreshToken 会返回 `invalid_grant`。**只能重新走 OAuth 授权**。
- **账号 `status=unauthorized` 但已重新授权**：token 刷新成功后不会自动清除
  `unauthorized` 标记，需要在后台点「重置状态」（`POST /:accountId/reset-status`）。
  注意这和「启用/停止调度」（`toggle-schedulable`）是两个不同的按钮，别点错 ——
  调度器在 `unifiedOpenAIScheduler.js` 里会同时检查 `status` 和 `schedulable`，
  只切 `schedulable` 不清 `status` 的话账号依然不会被调度。
