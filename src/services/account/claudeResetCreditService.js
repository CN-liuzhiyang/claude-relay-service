/**
 * Claude 官方账号「重置卡」（cedar_ember）查询与手动兑换
 *
 * 协议和防重复思路参照 sub2api 的 claude_reset_credits.go / claude_reset_redeem.go
 * （其兑换协议又移植自上游 PR #7591）。
 *
 * 约束：
 * - 所有请求都走账号自己的代理，且强制（ProxyHelper required）；没配代理直接报错，不回落直连
 * - 只做管理员手动触发，不接入任何自动刷新
 * - 返回给前端的数据不含授权单 ID、组织 ID
 * - 重定向一律不跟随，避免把 OAuth 令牌带到别处
 */

const axios = require('axios')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const claudeCodeVersion = require('../../utils/claudeCodeVersion')
const ProxyHelper = require('../../utils/proxyHelper')
const claudeAccountService = require('./claudeAccountService')

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1'
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const REDEEM_URL = (org) => `https://api.anthropic.com/api/organizations/${org}/reset_rate_limits`

const GRANT_ID_PATTERN = /^[a-z0-9_-]{1,40}$/
const ORG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REQUEST_TIMEOUT_MS = 25000
const LEASE_TTL_MS = 90 * 1000
const RECORD_TTL_SECONDS = 365 * 24 * 3600
// 没确认结果的兑换会锁住整个组织，直到上游结果肯定已尘埃落定
const UNKNOWN_FENCE_MS = 24 * 3600 * 1000
// 上游明确答「不可用」说明没扣卡，只短暂拦一下
const UNAVAILABLE_FENCE_MS = 15 * 60 * 1000
const REASON_UNAVAILABLE = 'upstream_unavailable'

const OUTCOME = {
  RESET: 'reset',
  ALREADY_USED: 'already_used',
  NOT_LIMITED: 'not_limited',
  COOLDOWN: 'cooldown',
  INELIGIBLE: 'ineligible',
  UNKNOWN: 'unknown'
}
const KNOWN_OUTCOMES = new Set([
  OUTCOME.RESET,
  OUTCOME.ALREADY_USED,
  OUTCOME.NOT_LIMITED,
  OUTCOME.COOLDOWN,
  OUTCOME.INELIGIBLE
])
// 只放行已知的原因码和窗口名，上游回显的其他字符串（可能带 ID）一律丢弃
const KNOWN_REASONS = new Set([
  'no_grant',
  'unknown_grant',
  'not_next_grant',
  'grant_id_required',
  'tenure',
  'other_experiment',
  'stamp_indeterminate',
  'reset_unconfirmed',
  'authorization_rejected',
  'claim_unconfirmed',
  REASON_UNAVAILABLE,
  'result_persistence_failed'
])
const KNOWN_WINDOWS = new Set(['five_hour', 'seven_day', 'seven_day_overage_included'])

class ResetCreditError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')

const parseTime = (value) => {
  if (!value) {
    return null
  }
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

// 是不是一张有效、已生效、没过期、没暂停的卡
function isGrantHeld(grant, now) {
  if (!grant || typeof grant !== 'object') {
    return false
  }
  const startsAt = parseTime(grant.starts_at)
  const endsAt = parseTime(grant.ends_at)
  return (
    GRANT_ID_PATTERN.test(String(grant.id || '')) &&
    Array.isArray(grant.clears) &&
    grant.clears.length > 0 &&
    Number(grant.resets_left) > 0 &&
    !grant.paused &&
    (startsAt === null || now >= startsAt) &&
    (endsAt === null || now < endsAt)
  )
}

function requiresLimit(grant) {
  return grant.use_requires_limit === undefined || grant.use_requires_limit === null
    ? true
    : !!grant.use_requires_limit
}

// 查询展示和兑换共用同一道门：只有上游指定的下一张、此刻可用、没被挡、不在冷却、限流条件满足
function isGrantRedeemable(block, grant, now) {
  if (!block || !isGrantHeld(grant, now)) {
    return false
  }
  const cooldownUntil = parseTime(block.cooldown_until)
  return (
    !!block.eligible &&
    !!grant.usable_now &&
    grant.id === block.next_grant_id &&
    (!requiresLimit(grant) || !!block.at_limit) &&
    (!Array.isArray(grant.blocking) || grant.blocking.length === 0) &&
    (cooldownUntil === null || now >= cooldownUntil)
  )
}

// 把上游原始块整理成前端能看的样子（去掉授权单 ID）
function projectCredits(block, now = Date.now()) {
  const result = {
    eligible: false,
    availableCount: 0,
    credits: [],
    cooldownUntil: null,
    weeklyResetsAt: null,
    fetchedAt: new Date(now).toISOString()
  }
  if (!block) {
    return result
  }
  result.eligible = !!block.eligible
  const cooldownUntil = parseTime(block.cooldown_until)
  if (cooldownUntil !== null && now < cooldownUntil) {
    result.cooldownUntil = new Date(cooldownUntil).toISOString()
  }
  result.weeklyResetsAt = block.weekly_resets_at || null

  for (const grant of Array.isArray(block.grants) ? block.grants : []) {
    if (!isGrantHeld(grant, now)) {
      continue
    }
    const redeemable = isGrantRedeemable(block, grant, now)
    const percentUsed = {}
    for (const [key, value] of Object.entries(grant.percent_used || {})) {
      if (typeof value === 'number' && value >= 0 && value <= 100) {
        percentUsed[key] = value
      }
    }
    result.credits.push({
      label: grant.label || '',
      resetsLeft: Number(grant.resets_left),
      startsAt: grant.starts_at || null,
      expiresAt: grant.ends_at || null,
      clears: grant.clears.filter((w) => KNOWN_WINDOWS.has(w)),
      percentUsed,
      blocking: Array.isArray(grant.blocking)
        ? grant.blocking.filter((b) => typeof b === 'string')
        : [],
      useRequiresLimit: requiresLimit(grant),
      redeemable
    })
    if (redeemable) {
      result.availableCount += Number(grant.resets_left)
    }
  }
  return result
}

class ClaudeResetCreditService {
  // 取账号、令牌和强制代理
  async _context(accountId) {
    const account = await redis.getClaudeAccount(accountId)
    if (!account || Object.keys(account).length === 0) {
      throw new ResetCreditError('ACCOUNT_NOT_FOUND', '账号不存在', 404)
    }
    const scopes = String(account.scopes || '').split(/\s+/)
    if (!scopes.includes('user:profile')) {
      throw new ResetCreditError(
        'PROFILE_SCOPE_REQUIRED',
        '该账号不是带 user:profile 权限的 OAuth 账号，查不了重置卡'
      )
    }

    let agent
    try {
      agent = ProxyHelper.createProxyAgent(account.proxy, { required: true })
    } catch (error) {
      throw new ResetCreditError(
        'PROXY_REQUIRED',
        `账号代理不可用，已拒绝直连：${error.message}`,
        503
      )
    }
    if (!agent) {
      throw new ResetCreditError('PROXY_REQUIRED', '账号没有可用代理，已拒绝直连', 503)
    }

    let token
    try {
      token = await claudeAccountService.getValidAccessToken(accountId)
    } catch (error) {
      throw new ResetCreditError('TOKEN_UNAVAILABLE', `取不到 OAuth 令牌：${error.message}`, 503)
    }
    if (!token || !String(token).trim()) {
      throw new ResetCreditError('TOKEN_UNAVAILABLE', '取不到 OAuth 令牌', 503)
    }
    return { account, token, agent }
  }

  _request(method, url, { token, agent, data }) {
    return axios({
      method,
      url,
      data,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'x-app': 'cli',
        'User-Agent': claudeCodeVersion.getDefaultUserAgent(),
        'Accept-Language': 'en-US,en;q=0.9'
      },
      httpAgent: agent,
      httpsAgent: agent,
      proxy: false,
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      maxContentLength: 1 << 20,
      validateStatus: () => true
    })
  }

  // 拿上游原始 cedar_ember 块，含授权单 ID，不得出本服务
  async _fetchBlock(ctx) {
    let response
    try {
      response = await this._request('get', USAGE_URL, ctx)
    } catch (error) {
      throw new ResetCreditError('QUERY_FAILED', '重置卡状态请求失败', 503)
    }
    if (response.status !== 200) {
      throw new ResetCreditError('QUERY_FAILED', `重置卡状态上游返回 HTTP ${response.status}`, 502)
    }
    const envelope = response.data
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      Array.isArray(envelope) ||
      'error' in envelope
    ) {
      throw new ResetCreditError('STATUS_INVALID', '重置卡状态格式异常', 502)
    }
    const block = envelope.cedar_ember
    if (block === undefined || block === null) {
      return null
    }
    if (typeof block !== 'object' || !Array.isArray(block.grants)) {
      throw new ResetCreditError('STATUS_INVALID', '重置卡授权格式异常', 502)
    }
    return block
  }

  async query(accountId) {
    const ctx = await this._context(accountId)
    const block = await this._fetchBlock(ctx)
    return projectCredits(block)
  }

  async _organization(ctx) {
    let response
    try {
      response = await this._request('get', PROFILE_URL, ctx)
    } catch (error) {
      throw new ResetCreditError('PROFILE_FAILED', 'OAuth profile 请求失败', 503)
    }
    const org = response.status === 200 ? response.data?.organization?.uuid : null
    if (!ORG_ID_PATTERN.test(String(org || ''))) {
      throw new ResetCreditError('PROFILE_FAILED', '拿不到 OAuth 组织信息', 502)
    }
    return String(org).toLowerCase()
  }

  async _lease(key, owner) {
    const acquired = await redis.setAccountLock(key, owner, LEASE_TTL_MS)
    if (!acquired) {
      throw new ResetCreditError('BUSY', '另一次重置正在进行', 409)
    }
    return () => redis.releaseAccountLock(key, owner).catch(() => {})
  }

  /**
   * 兑换一张重置卡。idempotencyKey 代表管理员的一次确认：
   * 同一个 key 重放只返回已存的结果，绝不会再发第二次请求。
   * 由服务端自己选卡，只会兑换上游指定的下一张。
   */
  async redeem(accountId, idempotencyKey) {
    const key = String(idempotencyKey || '').trim()
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
      throw new ResetCreditError('IDEMPOTENCY_KEY_REQUIRED', '缺少有效的幂等键', 400)
    }
    const client = redis.getClientSafe()
    const operation = sha256(`claude-reset:${accountId}:${key}`)
    const recordKey = `claude_reset:op:${operation}`

    const stored = await client.get(recordKey)
    if (stored) {
      return { ...JSON.parse(stored), replayed: true }
    }

    const owner = uuidv4()
    const releaseAccount = await this._lease(`claude_reset:lease:account:${accountId}`, owner)
    try {
      const ctx = await this._context(accountId)
      const org = await this._organization(ctx)
      const orgHash = sha256(`claude-org:${org}`)
      const releaseOrg = await this._lease(`claude_reset:lease:org:${orgHash}`, owner)
      try {
        const outcome = await this._redeemLocked(ctx, org, orgHash, operation)
        // 只有结果明确才记成这次确认的最终结果；unknown 留给栅栏处理，不缓存
        if (outcome.outcome !== OUTCOME.UNKNOWN) {
          await client.set(recordKey, JSON.stringify(outcome), 'EX', RECORD_TTL_SECONDS)
        }
        return outcome
      } finally {
        await releaseOrg()
      }
    } finally {
      await releaseAccount()
    }
  }

  async _redeemLocked(ctx, org, orgHash, operation) {
    const client = redis.getClientSafe()
    const fenceKey = `claude_reset:fence:${orgHash}`
    const now = Date.now()

    const rawFence = await client.get(fenceKey)
    if (rawFence) {
      let prior
      try {
        prior = JSON.parse(rawFence)
      } catch (error) {
        prior = null
      }
      if (!prior || !prior.operation) {
        throw new ResetCreditError('UNRESOLVED', '上一次重置需要人工核对', 409)
      }
      if (prior.operation === operation) {
        // 同一次确认中途中断：绝不重发
        return { outcome: prior.outcome, reason: prior.reason || undefined, replayed: true }
      }
      if (prior.outcome === OUTCOME.UNKNOWN) {
        const age = now - (parseTime(prior.at) || 0)
        if (prior.reason === REASON_UNAVAILABLE) {
          if (age < UNAVAILABLE_FENCE_MS) {
            throw new ResetCreditError(
              'UPSTREAM_UNAVAILABLE',
              '重置服务刚才不可用，请稍后再试',
              409
            )
          }
        } else if (age < UNKNOWN_FENCE_MS) {
          throw new ResetCreditError('UNRESOLVED', '上一次重置结果未确认，暂时禁止再次兑换', 409)
        }
      }
    }

    // 发不可逆请求前再查一次：服务端自己选卡，只有上游指定的下一张可能入选
    const block = await this._fetchBlock(ctx)
    const grant =
      block?.grants.find((g) => g.id === block.next_grant_id && isGrantRedeemable(block, g, now)) ||
      null
    if (!grant) {
      throw new ResetCreditError('NOT_AVAILABLE', '现在没有可兑换的重置卡', 409)
    }

    // 发送前先落「未确认」标记：之后崩溃也会同时拦住重发和另一张卡
    const marker = {
      operation,
      outcome: OUTCOME.UNKNOWN,
      reason: 'claim_unconfirmed',
      at: new Date(now).toISOString()
    }
    await client.set(fenceKey, JSON.stringify(marker), 'EX', RECORD_TTL_SECONDS)

    logger.warn(
      `🎫 Redeeming Claude reset credit for account ${ctx.account.name || ctx.account.id}`
    )
    const outcome = await this._claim(ctx, org, grant.id, operation)

    marker.outcome = outcome.outcome
    marker.reason = outcome.reason || ''
    try {
      await client.set(fenceKey, JSON.stringify(marker), 'EX', RECORD_TTL_SECONDS)
    } catch (error) {
      return { outcome: OUTCOME.UNKNOWN, reason: 'result_persistence_failed' }
    }

    if (outcome.outcome !== OUTCOME.UNKNOWN) {
      try {
        outcome.credits = projectCredits(await this._fetchBlock(ctx))
      } catch (error) {
        logger.debug('Claude reset credits refetch after redeem failed')
      }
      logger.success(`✅ Claude reset credit result: ${outcome.outcome}`)
    } else {
      logger.error(`❌ Claude reset credit unconfirmed: ${outcome.reason || ''}`)
    }
    return outcome
  }

  // 发出唯一一次不可逆请求；凡是不是格式正确的已知结果，一律按 unknown 处理，防止盲目重试
  async _claim(ctx, org, grantId, operation) {
    const unknown = { outcome: OUTCOME.UNKNOWN, reason: 'claim_unconfirmed' }
    let response
    try {
      response = await this._request('post', REDEEM_URL(org), {
        ...ctx,
        data: { program: 'cedar_ember', grant_id: grantId, request_id: operation }
      })
    } catch (error) {
      return unknown
    }
    if (response.status === 401 || response.status === 403) {
      return { outcome: OUTCOME.INELIGIBLE, reason: 'authorization_rejected' }
    }
    if (response.status !== 200 || !response.data || typeof response.data !== 'object') {
      return unknown
    }
    const result = response.data
    const reason = KNOWN_REASONS.has(result.reason) ? result.reason : ''
    if (reason === 'stamp_indeterminate' || reason === 'reset_unconfirmed') {
      return unknown
    }
    if (KNOWN_OUTCOMES.has(result.result)) {
      return {
        outcome: result.result,
        reason: reason || undefined,
        cleared: Array.isArray(result.cleared)
          ? result.cleared.filter((w) => KNOWN_WINDOWS.has(w))
          : [],
        cooldownUntil: result.cooldown_until || null
      }
    }
    if (result.result === 'unavailable') {
      return { outcome: OUTCOME.UNKNOWN, reason: REASON_UNAVAILABLE }
    }
    return unknown
  }
}

module.exports = new ClaudeResetCreditService()
module.exports.ResetCreditError = ResetCreditError
module.exports._internals = { projectCredits, isGrantRedeemable, isGrantHeld }
