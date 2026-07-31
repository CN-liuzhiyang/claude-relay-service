# ChatGPT 订阅账号（platform=`openai`）对接说明

本文记录 ChatGPT 订阅账号（OAuth 登录、走 Codex 后端，区别于 API Key 版的
`openai-responses`）的上游接口约束、数据结构，以及重置卡消费功能的实现依据
（含通过 Codex CLI 源码核验得到的 `/consume` 请求体格式）。

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
| POST | `/wham/rate-limit-reset-credits/consume` | 消费一张重置卡 | ❌ 否 | 已实现，见第 6 节 |

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

## 6. 消费重置卡（`/consume`）

### 现状（2026-07-30 已实现）

只读部分：拉取、落库、展示（徽章 + 临期高亮 + tooltip + 使用按钮）。
**消费功能已实现**，见第 7 节代码位置。

请求体格式最初无法验证（见下方「早期调研」），后来通过对 Codex CLI 源码
（`codex-rs/backend-client/src/client/rate_limit_resets.rs:15-20`）核验得到确切结构：

```json
// 不指定具体卡（服务端自动挑"下一张可用的"）
{ "redeem_request_id": "<uuid-v4>" }

// 指定具体卡
{ "redeem_request_id": "<uuid-v4>", "credit_id": "<credits[].id>" }
```

- `redeem_request_id` 是**必传**字段，语义是幂等键（客户端用 `uuid.v4()` 生成，
  同一次重试应复用同一个值），本项目实现里最初误以为 `credit_id` 是主字段，实际漏了这个。
- `credit_id` 可选，不传就是让服务端自己挑；本项目实现里**总是显式传**
  `resetCredits.items[0].id`（数组已按过期时间升序排列），优先消费最快过期的那张，
  避免服务端自动挑选导致快过期的卡被浪费。
- `total_earned_count` 和卡片数不一致（第 4 节提到的坑）不是异常：Codex CLI 官方的
  `RateLimitResetCreditsDetails` 结构体本身没有声明这个字段，serde 反序列化时静默丢弃，
  CLI 自己也不用它做一致性校验。
- `rate_limit_reached_type` / `rate_limit_upsell` 是 `/wham/usage` 在**真正撞到限额后**
  才会出现的字段（早期低用量验证时没有）；其中 `rate_limit_upsell` 全 Codex CLI 仓库搜索
  零匹配，是 ChatGPT Web 前端专属的营销 UI 结构，Codex CLI 走自己的 TUI 选卡器
  （`reset_credits.rs`），与本项目的实现无关，不需要处理。
- 鉴权细节：consume 只对 ChatGPT 账号登录（`platform=openai` 订阅账号）生效，
  Codex CLI 里 API Key 登录在客户端层就会被 `auth.uses_codex_backend()` 挡掉，
  和本项目里 API Key 版（`openai-responses`）本来就是两套账户类型这点一致。

### 早期调研中未解决、后已解决的问题

- ~~请求体格式：空 body？还是 `{"credit_id": "..."}`？~~ 见上方，已用源码核验确定。
- 返回结构，以及失败时（无适用卡 / 卡已过期）的错误格式：**仍未实测**，
  目前按 `/wham/usage` 等其它端点的通用格式处理（`{"detail": "..."}` 或
  `{"error": {"message": "..."}}`），第一次真实调用时需要留意日志核对。
- 消费后 `status`、`redeem_started_at`、`redeemed_at` 三个字段如何变化，
  重置是立即生效还是异步：**仍未实测**。当前实现里消费成功后立即调
  `fetchCodexUsageFromApi()` 重新拉取整份快照，不做「使用中」中间态展示，
  如果实测发现存在异步中间态，需要在 `buildResetCreditsSnapshot()` 里补充处理。

### 实现约束（已落实）

- 路由层（`POST /:accountId/consume-reset-credit`）在调用前用最近一次缓存的
  `applicable_available_count > 0` 作为前置校验，不满足直接 400，不去调用上游
- 前端按钮同样只在 `applicableCount > 0` 时渲染，见
  `CodexResetCreditsBadge.vue` 的 `use-credit` 事件
- 前端点击后走 `showConfirm()` 二次确认弹窗，不存在 429 自动消费的路径
- 消费成功后立即调用 `fetchCodexUsageFromApi()` 刷新快照并返回给前端，不本地推算状态；
  随后清除本地 429 限流/停止调度标记。否则调度器会在请求到达上游前持续拦截该账号，
  即使重置卡已经生效，网页测试和普通转发仍会表现为「一直 100% / 限流中」。该操作不会
  清除 401 等无关异常状态。

---

## 7. 相关代码位置

| 功能 | 位置 |
|---|---|
| 响应头解析用量 | `src/services/account/openaiAccountService.js` → `extractCodexUsageHeaders()` |
| 主动拉取用量+重置卡 | 同上 → `fetchCodexUsageFromApi()` |
| 快照组装（供前端） | 同上 → `buildCodexUsageSnapshot()` / `buildResetCreditsSnapshot()` |
| 消费一张重置卡 | 同上 → `consumeResetCredit()` |
| 连通性测试 | 同上 → `testAccountConnection()` |
| 30 分钟自动刷新 | 同上 → `startCodexUsageRefresh()`，在 `src/app.js` 启动 |
| Admin 路由 | `src/routes/admin/openaiAccounts.js` → `/:accountId/test`、`/:accountId/refresh-usage`、`/:accountId/consume-reset-credit` |
| 定时测试 | `src/services/accountTestSchedulerService.js` → `_testOpenAIAccount()` |
| 订阅账号模型列表 | `config/models.js` → `CODEX_SUBSCRIPTION_MODELS` |
| 前端窗口标签/进度条 | `web/admin-spa/src/utils/codexUsage.js` |
| 前端重置卡徽章 + 使用按钮 | `web/admin-spa/src/components/accounts/CodexResetCreditsBadge.vue` |
| 前端消费入口 | `web/admin-spa/src/views/AccountsView.vue` → `consumeResetCredit()` |

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
