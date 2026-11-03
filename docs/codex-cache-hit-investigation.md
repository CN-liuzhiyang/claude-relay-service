# Codex 缓存命中率偏低：排查记录与修复任务

> 2026-11-03 排查，知洋 + Pi（本机 Windows）。**状态：代码已修（见末尾「修复结果」），待服务器部署后验证。**
> 修复人完成后把本文末尾「修复结果」补上。

## 现象

经本机 CRS（`/openai/responses`）调用 Codex（`gpt-6.1-terra` 等），上游缓存命中率很低；同样经 CRS 的 Claude 请求几乎全命中。

示例会话：一个 Paseo 里的 Codex 会话（11-03 15:53 起，本机 Windows）。逐请求（input / cached）：

```
27066/0  27094/26880  27152/0  27283/0  28513/27136  28790/28416  39535/0
41892/27264  51514/10240  52975/41728  53287/39424  53324/53120  55293/53376  58539/10240
```

特征：输入前缀基本不变（只追加一两句），命中却忽高忽低；常见"只命中开头 ~27k 的固定系统提示词，命不中本会话自己累积的历史"，还有整条 0 命中。
说明请求没有被固定送到同一个上游缓存节点，只有很热的公共前缀能命中。

近 3 天 CRS 日志里所有 gpt 请求的整体命中率 15%~30%（统计 `Recorded OpenAI usage - Input: N(actual:A+cached:C)`），所以是 CRS 链路的普遍问题，不是这个会话的问题。

## 已排除

- **不是账号来回切**：这些请求日志里都是同一个 OpenAI 账号，`Using sticky session account … for session <hash>…`，sticky 是生效的（sticky 的 key 由请求体里的 `prompt_cache_key` 得来）。
- **不是 Claude 同款问题**：Claude 走 Anthropic 的 `cache_control` 显式断点，跟这里的请求头无关。

## 最可疑的原因：CRS 丢掉了新版 Codex 的会话头

`src/routes/openaiRoutes.js` 约 360–375 行（`/openai/responses` 主路径），转发给 `chatgpt.com/backend-api/codex/responses` 的请求头是白名单：

```js
const allowedKeys = ['version', 'openai-beta', 'session_id']
```

再加 authorization / chatgpt-account-id / host / accept / content-type。`user-agent`、`originator` 没转发，上游收到的 UA 是 axios 默认值。

本机抓包（把 Codex `codex_exec 0.166.0` 的 provider 指到本地假服务，看它真实发出的内容）：

请求头：
```
session-id: <thread uuid>          # 注意是连字符；老版本是下划线 session_id
thread-id: <thread uuid>
x-client-request-id: <thread uuid>
x-codex-window-id: <thread uuid>:0
x-codex-turn-metadata: {...installation_id, session_id, thread_id, turn_id ...}
x-codex-beta-features: remote_compaction_v2
x-openai-internal-codex-responses-lite: true
originator: codex_exec            # VSCode/桌面版为 codex_cli_rs 等
user-agent: codex_exec/0.166.0 (Windows 10.0.26200; x86_64) ...
```
请求体顶层：`model, stream, input, tool_choice, parallel_tool_calls, reasoning{effort,context:"all_turns"}, store:false, include, prompt_cache_key(=thread uuid), text{verbosity}, client_metadata{...}`。

对比：新版 Codex 的会话头是 `session-id`（连字符），白名单里是 `session_id`（下划线），**匹配不上，所以上游收不到任何会话/线程标识**；`x-client-request-id`、`thread-id`、`x-codex-*` 全部被丢。只剩请求体里的 `prompt_cache_key` 给上游做亲和，效果弱。
CRS 里自己的 sticky 会话取的是 `req.headers['session_id']`（同样取不到新头），现在是靠回退到 `prompt_cache_key` 才碰巧工作。

**没有直接证明**这就是根因：chatgpt.com Codex 后端怎么给缓存分片没有公开文档。所以要做对照验证。

## 修复任务

1. 改 `src/routes/openaiRoutes.js` 的头白名单（注意是请求头 key，Node 里全小写），至少放行：
   `session-id`、`session_id`、`thread-id`、`x-client-request-id`、`x-codex-window-id`、`x-codex-turn-metadata`、`x-codex-beta-features`、`x-openai-internal-codex-responses-lite`。
   `originator` 和 `user-agent`：Codex CLI 请求（`isCodexCLI` 为真，即 UA 校验过）时透传客户端的；非 Codex 客户端（走 `applyCodexCliAdaptation` 的）保持现在的行为，别把别家 UA 透传上去。
2. sticky 会话 key 的取法（约 323–329 行）也加上 `session-id`、`x-client-request-id`、`thread-id`，顺序放在 `prompt_cache_key` 前。注意这会改变 sticky hash，正在进行的会话切换后第一次会换一次账号——如果池里不止一个 OpenAI 账号，上线时间选没人在用的时候。
3. 同文件还有一处自己构造头的地方（约 1015–1025，`originator: 'codex_cli_rs'`、`user-agent: codex_cli_rs/0.144.5`，是 CRS 自己发的探测/测试请求）和 `/v1/chat/completions` 一类路径（约 930–970 的 `session_id` 提取），一并检查是否有同样的 `session_id`/`session-id` 问题；没必要的不要动。
4. 只改这几处，别重构。改完 `systemctl restart claude-relay`，看 `systemctl is-active` 和日志无报错。

## 验证

用本机或服务器上的 Codex（≥0.166，provider 指向本 CRS）开一个新会话，跑 8~10 轮（含几次工具调用，让前缀涨到 40k+ token），然后看日志：

```bash
grep -o "Recorded OpenAI usage - Input: [0-9]*(actual:[0-9]*+cached:[0-9]*)" <CRS 目录>/logs/claude-relay-$(date +%F).log | tail -20
```

也可读 Codex 本地 rollout（`~/.codex/sessions/.../rollout-*.jsonl` 里 `token_count` 事件的 `last_token_usage.cached_input_tokens`）。

通过标准：除第一次请求外，每一轮 `cached` 接近上一轮的 `input`（命中 ≥ 90%），不再出现整条 0 命中。
没改善的话：先怀疑 `x-openai-internal-codex-responses-lite` / `originator` / UA 是否真的被带上了（抓一次实际发往 chatgpt.com 的头，或临时在发送前打日志，注意别把 authorization 打出来），再考虑上游是否按出口 IP 分片（若账号走代理，确认出口 IP 是否稳定）。

## 修复结果（修完补）

- 日期 / commit：2026-11-03 / `9bfef4e8`（fix(openai): forward new Codex session headers and use them for sticky sessions）
- 实际改动（只动 `src/routes/openaiRoutes.js`，外加测试）：
  - 抽出两个小纯函数并导出供测试：`pickCodexForwardHeaders(incoming, isCodexCLI)`、`extractResponsesSessionId(headers, body)`。
  - 头白名单 `CODEX_FORWARD_HEADER_KEYS`：`version`、`openai-beta`、`session_id`、`session-id`、`thread-id`、`x-client-request-id`、`x-codex-window-id`、`x-codex-turn-metadata`、`x-codex-beta-features`、`x-openai-internal-codex-responses-lite`。
  - `isCodexCLI` 为真（UA 匹配 `codex_vscode|codex_cli_rs|codex_exec/版本`）时额外透传 `originator`、`user-agent`；非 Codex 客户端不透传，行为同前。authorization/chatgpt-account-id/host/accept/content-type 仍由 CRS 覆盖。
  - sticky 会话 key 顺序：`session_id` → `session-id` → `x-session-id` → `x-client-request-id` → `thread-id` → body `session_id` → `conversation_id` → `prompt_cache_key`。
  - 另外两处检查后未改：`handleImages`（`/v1/images/generations`）是单次出图请求，没有多轮前缀缓存可言，其 `session_id` 提取不影响本问题；约 1025 行写死的 `originator: codex_cli_rs` / `user-agent: codex_cli_rs/0.144.5` 是 CRS 自己构造的出图请求头，不是转发客户端的头，不在本问题范围。`openai-responses` 类型账户走 `openaiResponsesRelayService`，不经这段白名单，未检查/未改。
  - 测试：`tests/openaiResponsesPayloadToggles.test.js` 新增 4 个用例，用实抓的 Codex 0.166 头（`session-id`/`thread-id`/`x-client-request-id` = 同一 thread uuid、`x-codex-window-id` = `<uuid>:0`、`originator: codex_exec`、`user-agent: codex_exec/0.166.0 ...`）断言：转发头带上这些字段、客户端的 `x-api-key`/`cookie` 不被带上、非 Codex 客户端不透传 UA/originator、sticky key 取 `session-id` 的值。
- 验证数据（命中率前后对比）：待服务器部署后用真实 Codex 会话验证。
- 入库说明：仓库公开，入库前已把原排查记录里的真实账号 ID、sticky hash、Paseo/Codex 会话 ID、代理端口和服务器路径换成占位描述；原始数据留在服务器上的未跟踪副本里。
- 上线注意：
  - Codex 0.166 的 `session-id` 与 `prompt_cache_key` 都是 thread uuid，sticky hash 不变，进行中的新版 Codex 会话不会换账号；老版 Codex（发 `session_id`）本来就用头，也不变。只有"不发 `session_id` 但发 `session-id`/`x-client-request-id`/`thread-id` 且值与 `prompt_cache_key` 不同"的客户端会在切换后换一次账号。
  - 风险：`x-client-request-id` 在其他客户端（如部分 OpenAI SDK 用法）可能是每请求一个新值，若这类客户端也走这个入口，sticky 会退化为每请求一个 key。是否把它挪到 `prompt_cache_key` 之后，需要知洋拍板。
  - 透传 UA 只对已通过 UA 正则校验的 Codex CLI 请求生效，上游看到的是真实 Codex 客户端标识（和直连 Codex 一致），风险低；非 Codex 客户端仍是 axios 默认 UA。
