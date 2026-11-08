const crypto = require('crypto')
const config = require('../../config/config')
const redis = require('../models/redis')
const apiKeyService = require('./apiKeyService')
const accountGroupService = require('./accountGroupService')
const userService = require('./userService')
const claudeAccountService = require('./account/claudeAccountService')
const { buildCodexUsageSnapshot } = require('./account/openaiAccountService')
const { isSchedulable } = require('../utils/commonHelper')

const ACCOUNT_TYPES = {
  claude: { prefix: 'claude:account:', platform: 'claude', upstream: 'claude-official' },
  console: { prefix: 'claude_console_account:', platform: 'claude', upstream: 'claude-console' },
  bedrock: { prefix: 'bedrock_account:', platform: 'claude', upstream: 'bedrock' },
  openai: { prefix: 'openai:account:', platform: 'openai', upstream: 'openai' },
  responses: {
    prefix: 'openai_responses_account:',
    platform: 'openai',
    upstream: 'openai-responses'
  }
}
// Allow three rounds of the default ten-minute Claude background refresh before marking data old.
const FRESH_MS = 30 * 60 * 1000

function bindingKindForKey(key, platform) {
  if (!apiKeyService.hasPermission(key.permissions, platform)) {
    return 'none'
  }
  const binding = key[`${platform}AccountId`]
  if (binding?.startsWith('group:')) {
    return 'group'
  }
  if (binding || (platform === 'claude' && (key.claudeConsoleAccountId || key.bedrockAccountId))) {
    return 'fixed'
  }
  return 'pool'
}

function number(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function limit(value) {
  const parsed = number(value)
  return parsed > 0 ? parsed : null
}

function iso(value) {
  if (!value) {
    return null
  }
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function object(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) || {}
    } catch {
      return {}
    }
  }
  return value || {}
}

function enabled(value) {
  return value === true || value === 'true'
}

function tier(account, type) {
  if (type === 'openai') {
    const plan = String(account.planType || '').toLowerCase()
    return ['plus', 'pro', 'team', 'free'].includes(plan) ? plan : 'unknown'
  }
  if (type !== 'claude') {
    return 'unknown'
  }
  const info = object(account.subscriptionInfo)
  const plan = String(info.rateLimitTier || info.tier || info.plan || '').toLowerCase()
  if (/^(max20|default_claude_max_20x|claude_max_20x)$/.test(plan)) {
    return 'max20'
  }
  if (/^(max5|default_claude_max_5x|claude_max_5x)$/.test(plan)) {
    return 'max5'
  }
  if (info.hasClaudePro === true && info.hasClaudeMax !== true) {
    return 'pro'
  }
  if (info.accountType === 'claude_pro' && info.hasClaudeMax !== true) {
    return 'pro'
  }
  return ['pro', 'team', 'free'].includes(plan) ? plan : 'unknown'
}

async function readAccount(type, id) {
  const client = redis.getClientSafe()
  const key = `${ACCOUNT_TYPES[type].prefix}${id}`
  const account = type === 'bedrock' ? object(await client.get(key)) : await client.hgetall(key)
  return account && Object.keys(account).length ? { ...account, id, type } : null
}

async function readPool(type) {
  const { prefix } = ACCOUNT_TYPES[type]
  const ids = await redis.getAllIdsByIndex(
    `${prefix}index`,
    `${prefix}*`,
    new RegExp(`^${prefix}([^:]+)$`),
    { readOnly: true }
  )
  const results = await Promise.allSettled(
    ids.filter((id) => id !== 'index').map((id) => readAccount(type, id))
  )
  // Health is reported separately; a temporary limit does not change the key's authorization.
  return {
    accounts: results.flatMap((result) => {
      const account = result.status === 'fulfilled' ? result.value : null
      const legacyShared = ['claude', 'openai', 'responses'].includes(type) && !account?.accountType
      // Operators can opt shared accounts out of public stats with hideFromStats=true.
      const visible = account && account.hideFromStats !== 'true'
      return visible && (legacyShared || account.accountType === 'shared') ? [account] : []
    }),
    error: results.some((result) => result.status === 'rejected') ? 'snapshot_unavailable' : null
  }
}

async function resolvePool(key, platform) {
  if (!apiKeyService.hasPermission(key.permissions, platform)) {
    return { bindingKind: 'none', accounts: [] }
  }
  const binding = key[`${platform}AccountId`]
  if (binding?.startsWith('group:')) {
    const groupId = binding.slice(6)
    const group = await accountGroupService.getGroup(groupId)
    if (!group || group.platform !== platform) {
      return { bindingKind: 'group', accounts: [], error: 'group_unavailable' }
    }
    const ids = await accountGroupService.getGroupMembers(groupId)
    const types = platform === 'claude' ? ['claude', 'console'] : ['openai', 'responses']
    const results = await Promise.allSettled(
      [...new Set(ids)].map(async (id) => {
        for (const type of types) {
          const account = await readAccount(type, id)
          if (account) {
            return account
          }
        }
        return null
      })
    )
    return {
      bindingKind: 'group',
      accounts: results.flatMap((result) =>
        result.status === 'fulfilled' && result.value ? [result.value] : []
      ),
      error: results.some((result) => result.status === 'rejected') ? 'snapshot_unavailable' : null
    }
  }
  if (binding) {
    const type =
      platform === 'claude' ? 'claude' : binding.startsWith('responses:') ? 'responses' : 'openai'
    const id = type === 'responses' ? binding.slice(10) : binding
    const account = await readAccount(type, id)
    return {
      bindingKind: 'fixed',
      accounts: account ? [account] : [],
      error: account ? null : 'account_missing'
    }
  }
  // Console bindings precede the shared Claude pool in unifiedClaudeScheduler.
  if (platform === 'claude' && key.claudeConsoleAccountId) {
    const account = await readAccount('console', key.claudeConsoleAccountId)
    return {
      bindingKind: 'fixed',
      accounts: account ? [account] : [],
      error: account ? null : 'account_missing'
    }
  }
  if (platform === 'claude' && key.bedrockAccountId) {
    const account = await readAccount('bedrock', key.bedrockAccountId)
    return {
      bindingKind: 'fixed',
      accounts: account ? [account] : [],
      error: account ? null : 'account_missing'
    }
  }
  const types = platform === 'claude' ? ['claude', 'console', 'bedrock'] : ['openai', 'responses']
  const results = await Promise.allSettled(types.map(readPool))
  return {
    bindingKind: 'pool',
    accounts: results.flatMap((result) =>
      result.status === 'fulfilled' ? result.value.accounts : []
    ),
    error: results.some((result) => result.status === 'rejected' || result.value.error)
      ? 'snapshot_unavailable'
      : null
  }
}

async function accountSnapshot(account, now) {
  const { type, id } = account
  const { platform, upstream } = ACCOUNT_TYPES[type]
  // The server secret prevents offline guessing from public account identifiers.
  const digest = crypto
    .createHmac('sha256', config.security.encryptionKey)
    .update(`usage-snapshot:${type}:${id}`)
    .digest('hex')
    .slice(0, 16)
  const alias = `${platform === 'claude' ? 'Claude' : 'OpenAI'}-${digest}`
  const scopes = String(account.scopes || '').split(/\s+/)
  const oauth = scopes.includes('user:profile') && scopes.includes('user:inference')
  const snapshot =
    type === 'claude'
      ? oauth
        ? claudeAccountService.buildClaudeUsageSnapshot(account)
        : null
      : type === 'openai'
        ? buildCodexUsageSnapshot(account)
        : null
  const windows =
    platform === 'openai'
      ? ['primary', 'secondary'].map((name) => {
          const window = snapshot?.[name]
          const minutes = number(window?.windowMinutes)
          return {
            id: minutes === 300 ? '5h' : minutes === 10080 ? 'week' : name,
            usedPct: number(window?.usedPercent),
            resetsAt: iso(window?.resetAt)
          }
        })
      : [
          ['5h', 'fiveHour'],
          ['week', 'sevenDay'],
          ['week_opus', 'sevenDayOpus']
        ].map(([name, field]) => ({
          id: name,
          usedPct: number(snapshot?.[field]?.utilization),
          resetsAt: iso(snapshot?.[field]?.resetsAt)
        }))
  const observedAt = iso(snapshot?.updatedAt)
  const stale =
    !observedAt ||
    now - Date.parse(observedAt) >= FRESH_MS ||
    windows.some((window) => window.resetsAt && Date.parse(window.resetsAt) <= now)
  const rate = object(account.rateLimitStatus)
  const flagged =
    account.rateLimitStatus === 'limited' ||
    (enabled(account.rateLimitAutoStopped) && !!account.rateLimitEndAt) ||
    rate.status === 'limited' ||
    rate.isRateLimited === true ||
    account.status === 'rateLimited'
  const limitedUntil =
    iso(
      account.rateLimitEndAt ||
        account.rateLimitResetAt ||
        rate.rateLimitEndAt ||
        rate.rateLimitResetAt
    ) ||
    (flagged && iso(account.rateLimitedAt)
      ? iso(Date.parse(account.rateLimitedAt) + 3600000)
      : null)
  const limited = flagged && (!limitedUntil || Date.parse(limitedUntil) > now)
  // Do not use isTempUnavailable: it repairs Redis entries with a missing TTL.
  const tempUnavailable = await redis.getClientSafe().get(`temp_unavailable:${upstream}:${id}`)
  let state = 'normal'
  let unavailableReason = null
  if (
    !enabled(account.isActive) ||
    [
      'error',
      'unauthorized',
      'blocked',
      'temp_error',
      'account_blocked',
      'quota_exceeded'
    ].includes(account.status)
  ) {
    state = 'unavailable'
    unavailableReason = 'account_unavailable'
  } else if (limited) {
    state = 'rate_limited'
    unavailableReason = 'rate_limited'
  } else if (
    !isSchedulable(account.schedulable) ||
    tempUnavailable ||
    (type === 'openai' &&
      iso(account.expiresAt) &&
      Date.parse(account.expiresAt) <= now &&
      !account.refreshToken) ||
    (iso(account.subscriptionExpiresAt) && Date.parse(account.subscriptionExpiresAt) <= now)
  ) {
    state = 'unavailable'
    unavailableReason = 'not_schedulable'
  } else if (!account.status) {
    state = 'unknown'
  }
  if (!snapshot || windows.every((window) => window.usedPct === null)) {
    unavailableReason ||= type === 'claude' && !oauth ? 'oauth_required' : 'snapshot_missing'
  }
  return {
    alias,
    tier: tier(account, type),
    state,
    limitedUntil: limited ? limitedUntil : null,
    windows,
    observedAt,
    stale,
    unavailableReason
  }
}

async function keySnapshot(key, now) {
  const [cost, usage, weekly] = await Promise.all([
    redis.getCostStats(key.id),
    redis.getUsageStats(key.id),
    redis.getWeeklyOpusCost(
      key.id,
      Number(key.weeklyResetDay || 1),
      Number(key.weeklyResetHour || 0)
    )
  ])
  // Match the accounting helpers' timezone, including their legacy zero-offset fallback.
  const offset = (config.system.timezoneOffset || 8) * 3600000
  const nextDay = new Date(now + offset)
  nextDay.setUTCHours(24, 0, 0, 0)
  const client = redis.getClientSafe()
  let counts = [0, 0, 0]
  let resetsAt = null
  if (limit(key.rateLimitWindow)) {
    const values = await Promise.all(
      ['window_start', 'requests', 'cost', 'tokens'].map((field) =>
        client.get(`rate_limit:${field}:${key.id}`)
      )
    )
    const end =
      number(values[0]) === null ? null : number(values[0]) + Number(key.rateLimitWindow) * 60000
    if (end !== null && end > now) {
      resetsAt = iso(end)
      counts = values.slice(1).map((value) => number(value) ?? 0)
    }
  }
  return {
    status:
      key.expirationMode === 'activation' && !enabled(key.isActivated) ? 'inactive' : 'active',
    name: key.name || '',
    expiresAt: iso(key.expiresAt),
    daily: {
      used: number(cost.daily),
      limit: limit(key.dailyCostLimit),
      resetsAt: iso(nextDay.getTime() - offset)
    },
    total: { used: number(cost.total), limit: limit(key.totalCostLimit), resetsAt: null },
    weeklyOpus: {
      used: number(weekly),
      limit: limit(key.weeklyOpusCostLimit),
      resetsAt: iso(
        redis.getNextResetTime(Number(key.weeklyResetDay || 1), Number(key.weeklyResetHour || 0))
      )
    },
    rateWindow: {
      requests: { used: counts[0], limit: limit(key.rateLimitRequests) },
      cost: { used: counts[1], limit: limit(key.rateLimitCost) },
      tokens: { used: counts[2], limit: limit(key.tokenLimit) },
      resetsAt
    },
    usage: {
      totalTokens: number(usage.total?.allTokens),
      totalRequests: number(usage.total?.requests),
      dailyTokens: number(usage.daily?.allTokens),
      dailyRequests: number(usage.daily?.requests)
    }
  }
}

async function getSnapshot(apiKey) {
  if (
    typeof apiKey !== 'string' ||
    apiKey.length > 512 ||
    !apiKey.startsWith(config.security.apiKeyPrefix)
  ) {
    return { status: 401, body: { error: 'invalid_api_key' } }
  }
  const hash = apiKeyService._hashApiKey(apiKey)
  const key = await redis.findApiKeyByHash(hash, { readOnly: true })
  if (!key || enabled(key.isDeleted)) {
    return { status: 401, body: { error: 'invalid_api_key' } }
  }
  const now = Date.now()
  let status = !enabled(key.isActive) ? 'disabled' : null
  if (!status && key.userId) {
    const user = await userService.getUserById(key.userId, false)
    if (!user || !user.isActive) {
      status = 'disabled'
    }
  }
  if (!status && iso(key.expiresAt) && Date.parse(key.expiresAt) <= now) {
    status = 'expired'
  }
  if (status) {
    return { status: 403, body: { schemaVersion: 1, serverTime: iso(now), key: { status } } }
  }
  const errors = []
  const pools = await Promise.all(
    ['claude', 'openai'].map(async (platform) => {
      const bindingKind = bindingKindForKey(key, platform)
      try {
        const pool = await resolvePool(key, platform)
        if (pool.error) {
          errors.push({ scope: `pool:${platform}`, code: pool.error })
        }
        const results = await Promise.allSettled(
          pool.accounts.map(async (account) => {
            const snapshot = await accountSnapshot(account, now)
            if (
              snapshot.unavailableReason === 'snapshot_missing' ||
              snapshot.unavailableReason === 'oauth_required'
            ) {
              errors.push({ scope: `account:${snapshot.alias}`, code: snapshot.unavailableReason })
            }
            return snapshot
          })
        )
        const accounts = []
        for (const result of results) {
          if (result.status === 'fulfilled') {
            accounts.push(result.value)
          } else {
            errors.push({ scope: `pool:${platform}`, code: 'snapshot_unavailable' })
          }
        }
        accounts.sort((a, b) => a.alias.localeCompare(b.alias))
        return { platform, bindingKind, accounts }
      } catch {
        errors.push({ scope: `pool:${platform}`, code: 'snapshot_unavailable' })
        return { platform, bindingKind, accounts: [] }
      }
    })
  )
  const snapshot = await keySnapshot(key, now)
  return {
    status: 200,
    body: { schemaVersion: 1, serverTime: iso(now), key: snapshot, pools, errors }
  }
}

module.exports = { getSnapshot }
