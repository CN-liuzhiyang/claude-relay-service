const request = require('supertest')
const express = require('express')

jest.mock('../config/config', () => ({
  security: { apiKeyPrefix: 'cr_', encryptionKey: 'test-encryption-secret-32-characters' },
  system: { timezoneOffset: 8 },
  claude: {},
  requestDetail: {},
  logging: {
    level: 'error',
    dirname: require('path').join(require('os').tmpdir(), 'crs-usage-snapshot-test-logs'),
    maxSize: '1m',
    maxFiles: 1
  }
}))
jest.mock('../src/utils/logger', () => new Proxy({}, { get: () => jest.fn() }))
jest.mock('ioredis', () =>
  jest.fn(() => {
    throw new Error('Real Redis forbidden')
  })
)
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), request: jest.fn() }))

// Exercise the real storage readers and snapshot builders, with no external connections.
describe('GET /apiStats/api/usage-snapshot', () => {
  let app
  let redis
  let apiKeyService
  let data
  let reads
  let client
  let pipelines
  const now = Date.parse('2026-11-08T03:00:00Z')
  const secret = 'cr_test-snapshot-key-0000000000000000'
  const path = '/apiStats/api/usage-snapshot'

  function put(key, value) {
    data.set(key, structuredClone(value))
  }

  function keyRecord(overrides = {}, keySecret = secret, id = 'key-fixture-private') {
    const record = {
      id,
      name: 'Fixture key',
      isActive: 'true',
      isActivated: 'true',
      expirationMode: 'fixed',
      permissions: 'all',
      weeklyResetDay: '3',
      weeklyResetHour: '15',
      dailyCostLimit: '10',
      totalCostLimit: '20',
      rateLimitWindow: '60',
      rateLimitRequests: '30',
      tokenLimit: '20000',
      rateLimitCost: '5',
      ...overrides
    }
    put(`apikey:${id}`, record)
    const hashes = data.get('apikey:hash_map') || {}
    put('apikey:hash_map', { ...hashes, [apiKeyService._hashApiKey(keySecret)]: id })
    put(`usage:cost:daily:${id}:2026-11-08`, '12.3')
    put(`usage:cost:total:${id}`, '81')
    put(`usage:cost:real:total:${id}`, '1.23')
    put(`usage:${id}`, { totalAllTokens: '12345', totalRequests: '77' })
    put(`usage:daily:${id}:2026-11-08`, { totalAllTokens: '345', totalRequests: '7' })
    put(`rate_limit:window_start:${id}`, String(now - 600000))
    put(`rate_limit:requests:${id}`, '35')
    put(`rate_limit:tokens:${id}`, '25000')
    put(`rate_limit:cost:${id}`, '6')
    const period = redis.getPeriodString(3, 15)
    put(`usage:opus:weekly:${id}:${period}`, '4.5')
    return record
  }

  function account(type, id, overrides = {}) {
    const prefixes = {
      claude: 'claude:account:',
      openai: 'openai:account:',
      console: 'claude_console_account:',
      responses: 'openai_responses_account:'
    }
    const record = {
      id,
      name: 'SECRET_ACCOUNT_NAME',
      email: 'fixture-private@example.test',
      accessToken: 'SECRET_ACCESS_TOKEN',
      refreshToken: 'SECRET_REFRESH_TOKEN',
      proxy: 'SECRET_PROXY',
      isActive: 'true',
      status: 'active',
      schedulable: 'true',
      accountType: 'shared',
      scopes: 'user:profile user:inference',
      claudeUsageUpdatedAt: '2026-11-08T02:59:00Z',
      claudeFiveHourUtilization: '22',
      claudeFiveHourResetsAt: '2026-11-08T07:00:00+00:00',
      claudeSevenDayUtilization: '40',
      subscriptionInfo: JSON.stringify({
        rateLimitTier: 'default_claude_max_20x',
        email: 'fixture-private@example.test'
      }),
      planType: 'plus',
      codexUsageUpdatedAt: '2026-11-08T02:59:00Z',
      codexPrimaryUsedPercent: '18',
      codexPrimaryWindowMinutes: '300',
      codexPrimaryResetAfterSeconds: '3600',
      codexSecondaryUsedPercent: '45',
      codexSecondaryWindowMinutes: '10080',
      ...overrides
    }
    put(`${prefixes[type]}${id}`, record)
    return record
  }

  const get = (key = secret) => request(app).get(path).set('x-api-key', key)

  function modelDay(date, model, counts, keyId = 'key-fixture-private') {
    const index = `usage:keymodel:daily:index:${date}`
    put(index, [...(data.get(index) || []), `${keyId}:${model}`])
    put(`usage:${keyId}:model:daily:${model}:${date}`, counts)
  }

  beforeEach(() => {
    jest.resetModules()
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
    jest.setSystemTime(now)
    redis = require('../src/models/redis')
    apiKeyService = require('../src/services/apiKeyService')
    data = new Map()
    pipelines = []
    reads = []
    const read = (key, fallback) => {
      reads.push(key)
      return structuredClone(data.get(key) ?? fallback)
    }
    const allowed = {
      get: async (key) => read(key, null),
      hget: async (key, field) => read(key, {})[field] ?? null,
      hgetall: async (key) => read(key, {}),
      smembers: async (key) => read(key, []),
      scard: async (key) => read(key, []).length,
      sscan: async (key, _cursor, _match, pattern) => [
        '0',
        read(key, []).filter((member) => member.startsWith(pattern.slice(0, -1)))
      ],
      pipeline: () => {
        const commands = []
        pipelines.push(commands)
        const pipeline = {
          get: (...args) => {
            commands.push(['get', ...args])
            return pipeline
          },
          hgetall: (...args) => {
            commands.push(['hgetall', ...args])
            return pipeline
          },
          sscan: (...args) => {
            commands.push(['sscan', ...args])
            return pipeline
          },
          exec: async () =>
            Promise.all(
              commands.map(async ([method, ...args]) => {
                try {
                  return [null, await client[method](...args)]
                } catch (error) {
                  return [error, null]
                }
              })
            )
        }
        return pipeline
      },
      scan: async (_cursor, _match, pattern) => {
        const regex = new RegExp(
          `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`
        )
        return ['0', [...data.keys()].filter((key) => regex.test(key))]
      }
    }
    client = new Proxy(allowed, {
      get: (target, field) => {
        if (field in target) {
          return target[field]
        }
        throw new Error(`Unexpected storage operation: ${String(field)}`)
      }
    })
    redis.client = client
    redis.isConnected = true
    app = express()
    app.use('/apiStats', require('../src/routes/apiStats'))
    keyRecord()
    put('unified_claude_session_mapping:fixture', 'secret-sticky-claude')
    put('unified_openai_session_mapping:fixture', 'secret-sticky-openai')
  })

  afterEach(() => {
    const axios = require('axios')
    expect(axios.get).not.toHaveBeenCalled()
    expect(axios.post).not.toHaveBeenCalled()
    expect(axios.request).not.toHaveBeenCalled()
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  it('rejects absent, malformed, unknown and query-only credentials with 401', async () => {
    for (const req of [
      request(app).get(path),
      get('sk-test-invalid'),
      get('cr_test-unknown'),
      request(app).get(path).query({ apiKey: secret })
    ]) {
      const response = await req
      expect(response.status).toBe(401)
      expect(response.body).toEqual({ error: 'invalid_api_key' })
      expect(JSON.stringify(response.body)).not.toContain(secret)
    }
  })

  it('accepts Bearer authentication and disables response caching', async () => {
    const response = await request(app).get(path).set('Authorization', `Bearer ${secret}`)
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it.each([
    [{ isActive: 'false' }, 'disabled'],
    [{ expiresAt: '2026-11-07T00:00:00Z' }, 'expired'],
    [{ expiresAt: '2026-11-08T03:00:00Z' }, 'expired'],
    [{ isActivated: 'false', expiresAt: '2026-11-07T00:00:00Z' }, 'expired']
  ])('returns only minimal state for restricted keys: %j', async (overrides, status) => {
    keyRecord(overrides)
    const response = await get()
    expect(response.status).toBe(403)
    expect(response.body).toEqual({
      schemaVersion: 1,
      serverTime: new Date(now).toISOString(),
      key: { status }
    })
    expect(reads.every((key) => key.startsWith('apikey'))).toBe(true)
  })

  it('treats a disabled owning user as disabled and fails closed on lookup errors', async () => {
    keyRecord({ userId: 'user-fixture-private' })
    put('user:user-fixture-private', JSON.stringify({ isActive: false }))
    expect((await get()).body.key).toEqual({ status: 'disabled' })
    put('user:user-fixture-private', 'invalid JSON')
    const response = await get()
    expect(response.status).toBe(503)
    expect(response.headers['retry-after']).toBe('30')
    expect(response.body).toEqual({ error: 'snapshot_unavailable' })
  })

  it('keeps exhausted keys readable with rated costs, custom weekly resets and no storage changes', async () => {
    const before = structuredClone([...data])
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.body.key.daily).toEqual({
      used: 12.3,
      limit: 10,
      resetsAt: '2026-11-08T16:00:00.000Z'
    })
    expect(response.body.key.total).toEqual({ used: 81, limit: 20, resetsAt: null })
    expect(response.body.key.weeklyOpus).toEqual({
      used: 4.5,
      limit: null,
      resetsAt: '2026-11-11T07:00:00.000Z'
    })
    expect(response.body.key.rateWindow).toEqual({
      requests: { used: 35, limit: 30 },
      cost: { used: 6, limit: 5 },
      tokens: { used: 25000, limit: 20000 },
      resetsAt: '2026-11-08T03:50:00.000Z'
    })
    expect(response.body.key.usage).toEqual({
      totalTokens: 12345,
      totalRequests: 77,
      dailyTokens: 345,
      dailyRequests: 7
    })
    expect([...data]).toEqual(before)
  })

  it('does not activate an unused key', async () => {
    keyRecord({ expirationMode: 'activation', isActivated: 'false' })
    const before = structuredClone([...data])
    expect((await get()).body.key.status).toBe('inactive')
    expect([...data]).toEqual(before)
  })

  it('projects expired rate windows as zero without resetting stored counters', async () => {
    put('rate_limit:window_start:key-fixture-private', String(now - 7200000))
    const before = structuredClone([...data])
    const response = await get()
    expect(response.body.key.rateWindow.resetsAt).toBeNull()
    expect(response.body.key.rateWindow.requests.used).toBe(0)
    expect([...data]).toEqual(before)
  })

  it('limits fixed bindings to their own accounts across keys and ignores accountId query inputs', async () => {
    account('claude', 'private-claude-alpha', { accountType: 'dedicated' })
    account('claude', 'private-claude-beta', {
      accountType: 'dedicated',
      claudeFiveHourUtilization: '67'
    })
    account('openai', 'private-openai-alpha', { accountType: 'dedicated' })
    keyRecord({ claudeAccountId: 'private-claude-alpha', openaiAccountId: 'private-openai-alpha' })
    const otherSecret = 'cr_test-other-key-0000000000000000'
    keyRecord(
      { claudeAccountId: 'private-claude-beta', permissions: '["claude"]' },
      otherSecret,
      'other-key-private'
    )
    const first = await get().query({
      accountId: 'private-claude-beta',
      apiId: 'other-key-private'
    })
    const other = await get(otherSecret)
    expect(first.status).toBe(200)
    expect(first.body.pools.map((pool) => pool.bindingKind)).toEqual(['fixed', 'fixed'])
    expect(first.body.pools[0].accounts).toHaveLength(1)
    expect(first.body.pools[0].accounts[0].windows[0].usedPct).toBe(22)
    expect(other.body.pools[0].accounts[0].windows[0].usedPct).toBe(67)
    expect(other.body.pools[1]).toEqual({ platform: 'openai', bindingKind: 'none', accounts: [] })
    expect(first.body.pools[0].accounts[0].alias).not.toBe(other.body.pools[0].accounts[0].alias)
  })

  it.each(['claude', 'openai'])(
    'limits %s group bindings to members, including alternate account types',
    async (platform) => {
      const alternate = platform === 'claude' ? 'console' : 'responses'
      account(platform, 'group-member-private', { accountType: 'dedicated' })
      account(alternate, 'alternate-member-private', { accountType: 'group' })
      account(platform, 'outside-member-private')
      put('account_group:private-group', { id: 'private-group', platform })
      put('account_group_members:private-group', [
        'group-member-private',
        'alternate-member-private'
      ])
      keyRecord({ [`${platform}AccountId`]: 'group:private-group', permissions: platform })
      const response = await get()
      const pool = response.body.pools.find((item) => item.platform === platform)
      expect(pool.bindingKind).toBe('group')
      expect(pool.accounts).toHaveLength(2)
      expect(JSON.stringify(response.body)).not.toContain('outside-member-private')
    }
  )

  it('does not fall back to a pool for missing or wrongly typed groups', async () => {
    account('claude', 'shared-private')
    put('account_group:wrong-platform', { platform: 'openai' })
    keyRecord({ claudeAccountId: 'group:wrong-platform', permissions: 'claude' })
    const response = await get()
    expect(response.body.pools[0]).toEqual({
      platform: 'claude',
      bindingKind: 'group',
      accounts: []
    })
    expect(response.body.errors).toContainEqual({ scope: 'pool:claude', code: 'group_unavailable' })
  })

  it('shows only shared and legacy unbound pool accounts, retaining temporary health states', async () => {
    account('claude', 'shared-claude-private', {
      rateLimitStatus: 'limited',
      rateLimitEndAt: '2026-11-08T04:00:00Z',
      schedulable: 'false'
    })
    account('claude', 'legacy-claude-private', { accountType: '' })
    account('claude', 'dedicated-claude-private', { accountType: 'dedicated' })
    account('claude', 'group-only-claude-private', { accountType: 'group' })
    account('openai', 'shared-openai-private')
    account('responses', 'responses-shared-private')
    const before = structuredClone([...data])
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.body.pools.map((pool) => pool.bindingKind)).toEqual(['pool', 'pool'])
    expect(response.body.pools[0].accounts).toHaveLength(2)
    expect(response.body.pools[1].accounts).toHaveLength(2)
    expect(
      response.body.pools[0].accounts.find((item) => item.state === 'rate_limited').limitedUntil
    ).toBe('2026-11-08T04:00:00.000Z')
    expect([...data]).toEqual(before)
  })

  it('omits shared accounts the operator marked hideFromStats', async () => {
    account('openai', 'visible-openai-private')
    account('openai', 'hidden-openai-private', { hideFromStats: 'true' })
    const response = await get()
    const pool = response.body.pools.find((item) => item.platform === 'openai')
    expect(pool.accounts).toHaveLength(1)
  })

  it('uses official utilization and Codex percentages with collection times, not window progress', async () => {
    account('claude', 'claude-window-private', { sessionWindowProgress: '99' })
    account('openai', 'codex-window-private')
    const response = await get()
    const claude = response.body.pools[0].accounts[0]
    expect(claude.tier).toBe('max20')
    expect(claude.windows).toEqual([
      { id: '5h', usedPct: 22, resetsAt: '2026-11-08T07:00:00.000Z' },
      { id: 'week', usedPct: 40, resetsAt: null },
      { id: 'week_opus', usedPct: null, resetsAt: null }
    ])
    expect(claude.observedAt).toBe('2026-11-08T02:59:00.000Z')
    expect(claude.stale).toBe(false)
    const codex = response.body.pools[1].accounts[0]
    expect(codex.tier).toBe('plus')
    expect(codex.windows[0]).toEqual({
      id: '5h',
      usedPct: 18,
      resetsAt: '2026-11-08T03:59:00.000Z'
    })
    expect(codex.windows[1]).toEqual({ id: 'week', usedPct: 45, resetsAt: null })
  })

  it('leaves absent windows null, suppresses setup-token snapshots and marks stale data', async () => {
    account('claude', 'setup-token-private', { scopes: 'user:inference', subscriptionInfo: '{}' })
    account('openai', 'missing-snapshot-private', {
      codexUsageUpdatedAt: '',
      codexPrimaryUsedPercent: '',
      codexPrimaryWindowMinutes: '',
      codexPrimaryResetAfterSeconds: '',
      codexSecondaryUsedPercent: '',
      codexSecondaryWindowMinutes: '',
      planType: ''
    })
    const response = await get()
    for (const pool of response.body.pools) {
      const item = pool.accounts[0]
      expect(item.tier).toBe('unknown')
      expect(item.observedAt).toBeNull()
      expect(item.stale).toBe(true)
      expect(
        item.windows.every((window) => window.usedPct === null && window.resetsAt === null)
      ).toBe(true)
    }
    expect(response.body.errors.map((error) => error.code).sort()).toEqual([
      'oauth_required',
      'snapshot_missing'
    ])
    account('claude', 'setup-token-private', { claudeUsageUpdatedAt: '2026-11-08T02:00:00Z' })
    expect((await get()).body.pools[0].accounts[0].stale).toBe(true)
  })

  it.each(
    ['claude', 'openai'].flatMap((platform) =>
      [
        [6 * 60000, false],
        [30 * 60000 - 1, false],
        [30 * 60000, true],
        [30 * 60000 + 1, true]
      ].map(([age, stale]) => [platform, age, stale])
    )
  )(
    'marks %s snapshot age %i ms stale=%s at the thirty-minute boundary',
    async (platform, age, stale) => {
      account(platform, 'fixture-age-boundary', {
        claudeUsageUpdatedAt: new Date(now - age).toISOString(),
        codexUsageUpdatedAt: new Date(now - age).toISOString()
      })
      keyRecord({ permissions: platform })
      const response = await get()
      expect(response.status).toBe(200)
      const pool = response.body.pools.find((item) => item.platform === platform)
      expect(pool.accounts[0].stale).toBe(stale)
    }
  )

  it.each(['claude', 'openai'].flatMap((platform) => [-1, 0, 1].map((delta) => [platform, delta])))(
    'marks a fresh %s snapshot stale when reset is %i ms relative to serverTime',
    async (platform, delta) => {
      account(platform, 'fixture-reset-boundary', {
        claudeFiveHourResetsAt: new Date(now + delta).toISOString(),
        codexPrimaryResetAfterSeconds: String((60000 + delta) / 1000)
      })
      keyRecord({ permissions: platform })
      const response = await get()
      const pool = response.body.pools.find((item) => item.platform === platform)
      expect(pool.accounts[0].stale).toBe(delta <= 0)
      expect(pool.accounts[0].windows[0].usedPct).toBe(platform === 'claude' ? 22 : 18)
      expect(Date.parse(pool.accounts[0].windows[0].resetsAt)).toBe(now + delta)
    }
  )

  it('adds the thirty-day token contract, zero-fills missing days and keeps input exclusive of caches', async () => {
    const counts = {
      inputTokens: '100',
      outputTokens: '20',
      cacheCreateTokens: '200',
      cacheReadTokens: '3000',
      requests: '7'
    }
    put('usage:daily:key-fixture-private:2026-11-08', counts)
    modelDay('2026-11-08', 'claude-fixture', counts)
    modelDay('2026-11-08', 'neighbor-model-private', counts, 'neighbor-key-private')
    const before = structuredClone([...data])
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.body.schemaVersion).toBe(1)
    const { tokenDays } = response.body
    expect(Object.keys(tokenDays).sort()).toEqual(['days', 'timezoneOffset'])
    expect(tokenDays.timezoneOffset).toBe(8)
    expect(tokenDays.days).toHaveLength(30)
    expect(tokenDays.days[0]).toEqual({
      date: '2026-10-10',
      cost: 0,
      input: 0,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
      requests: 0,
      models: []
    })
    expect(tokenDays.days[29]).toEqual({
      date: '2026-11-08',
      cost: 12.3,
      input: 100,
      output: 20,
      cacheCreate: 200,
      cacheRead: 3000,
      requests: 7,
      models: [
        {
          model: 'claude-fixture',
          input: 100,
          output: 20,
          cacheCreate: 200,
          cacheRead: 3000,
          requests: 7
        }
      ]
    })
    expect(tokenDays.days[29].cost).toBe(response.body.key.daily.used)
    expect(tokenDays.days.map((day) => day.date)).toEqual(
      [...tokenDays.days.map((day) => day.date)].sort()
    )
    expect(reads).not.toContain(
      'usage:neighbor-key-private:model:daily:neighbor-model-private:2026-11-08'
    )
    for (const forbidden of [
      secret,
      'key-fixture-private',
      'neighbor-key-private',
      'neighbor-model-private'
    ]) {
      expect(JSON.stringify(response.body)).not.toContain(forbidden)
    }
    expect([...data]).toEqual(before)
  })

  it('reads rated daily dollars and distinguishes missing, invalid and failed cost reads', async () => {
    put('usage:cost:daily:key-fixture-private:2026-10-10', '0.000123')
    put('usage:cost:daily:key-fixture-private:2026-11-04', '0')
    put('usage:cost:daily:key-fixture-private:2026-11-05', 'invalid')
    put('usage:cost:daily:key-fixture-private:2026-11-06', '')
    put('usage:cost:real:daily:key-fixture-private:2026-11-08', '999')
    put('usage:cost:daily:neighbor-key-private:2026-11-08', '888')
    const originalGet = client.get
    client.get = async (key) => {
      if (key === 'usage:cost:daily:key-fixture-private:2026-11-07') {
        throw new Error(`${secret} synthetic cost failure`)
      }
      return originalGet(key)
    }
    const before = structuredClone([...data])
    const response = await get()
    expect(response.status).toBe(200)
    const { days } = response.body.tokenDays
    expect(days[0].cost).toBe(0.000123)
    expect(days[1].cost).toBe(0)
    expect(days[25].cost).toBe(0)
    expect(days.slice(26, 29).map((day) => day.cost)).toEqual([null, null, null])
    expect(days[29].cost).toBe(12.3)
    expect(days[29].cost).toBe(response.body.key.daily.used)
    expect(days[28].input).toBe(0)
    expect(response.body.key.total.used).toBe(81)
    for (const date of ['2026-11-05', '2026-11-06', '2026-11-07']) {
      expect(response.body.errors).toContainEqual({
        scope: `tokenDays:${date}`,
        code: 'snapshot_unavailable'
      })
    }
    expect(reads).not.toContain('usage:cost:daily:neighbor-key-private:2026-11-08')
    expect(JSON.stringify(response.body)).not.toContain(secret)
    expect([...data]).toEqual(before)
  })

  it('leaves every daily cost unknown when the history reader fails entirely', async () => {
    jest.spyOn(redis, 'getDailyTokenStats').mockRejectedValueOnce(new Error('synthetic failure'))
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.body.tokenDays.days).toHaveLength(30)
    expect(response.body.tokenDays.days.every((day) => day.cost === null)).toBe(true)
    expect(response.body.key.daily.used).toBe(12.3)
  })

  it.each([12, 13])(
    'caps %i daily models at twelve rows, ranking all four token categories',
    async (count) => {
      for (let i = 1; i <= count; i++) {
        modelDay('2026-11-08', `fixture-model-${i}`, {
          inputTokens: String(i),
          outputTokens: '0',
          cacheCreateTokens: '0',
          cacheReadTokens: '0',
          requests: '1'
        })
      }
      // Cache reads participate in ranking, but never get added to input.
      put('usage:key-fixture-private:model:daily:fixture-model-1:2026-11-08', {
        inputTokens: '1',
        outputTokens: '0',
        cacheCreateTokens: '0',
        cacheReadTokens: '100',
        requests: '1'
      })
      const response = await get()
      const { models } = response.body.tokenDays.days[29]
      expect(models).toHaveLength(12)
      expect(models[0].model).toBe('fixture-model-1')
      if (count === 13) {
        expect(models.find((model) => model.model === 'other')).toEqual({
          model: 'other',
          input: 5,
          output: 0,
          cacheCreate: 0,
          cacheRead: 0,
          requests: 2
        })
      } else {
        expect(models.some((model) => model.model === 'other')).toBe(false)
      }
      expect(models.reduce((sum, model) => sum + model.input, 0)).toBe((count * (count + 1)) / 2)
      expect(models.reduce((sum, model) => sum + model.cacheRead, 0)).toBe(100)
    }
  )

  it('merges a real other model without duplicates and preserves unknown aggregate fields', async () => {
    for (let i = 1; i <= 13; i++) {
      modelDay('2026-11-08', `fixture-model-${i}`, {
        inputTokens: String(i * 10),
        outputTokens: '0',
        cacheCreateTokens: '0',
        cacheReadTokens: '0',
        requests: '1'
      })
    }
    modelDay('2026-11-08', 'other', {
      inputTokens: '1',
      outputTokens: '0',
      cacheCreateTokens: '0',
      cacheReadTokens: '0',
      requests: '2'
    })
    data.delete('usage:key-fixture-private:model:daily:fixture-model-1:2026-11-08')
    const original = client.hgetall
    client.hgetall = async (key) => {
      if (key === 'usage:key-fixture-private:model:daily:fixture-model-2:2026-11-08') {
        throw new Error('synthetic read failure')
      }
      return original(key)
    }
    const response = await get()
    const { models } = response.body.tokenDays.days[29]
    expect(models).toHaveLength(12)
    expect(models.filter((model) => model.model === 'other')).toHaveLength(1)
    expect(models.find((model) => model.model === 'other').input).toBeNull()
    expect(response.body.errors).toContainEqual({
      scope: 'tokenDays:2026-11-08',
      code: 'snapshot_unavailable'
    })
  })

  it.each([
    [8, '2026-11-07T15:59:59.999Z', '2026-11-07'],
    [8, '2026-11-07T16:00:00.000Z', '2026-11-08'],
    [0, '2026-11-07T23:59:59.999Z', '2026-11-07'],
    [0, '2026-11-08T00:00:00.000Z', '2026-11-08'],
    [-5, '2026-11-08T04:59:59.999Z', '2026-11-07'],
    [-5, '2026-11-08T05:00:00.000Z', '2026-11-08']
  ])('cuts token dates at timezone %i midnight for %s', async (offset, time, date) => {
    require('../config/config').system.timezoneOffset = offset
    jest.setSystemTime(new Date(time))
    put(`usage:cost:daily:key-fixture-private:${date}`, '4.25')
    const response = await get()
    expect(response.body.tokenDays.timezoneOffset).toBe(offset)
    expect(response.body.tokenDays.days[29].date).toBe(date)
    expect(response.body.tokenDays.days[29].cost).toBe(4.25)
    expect(response.body.tokenDays.days).toHaveLength(30)
  })

  it('returns null for failed day/index/model reads while preserving the rest of the snapshot', async () => {
    modelDay('2026-11-08', 'fixture-failed-model', { inputTokens: '1' })
    const originalRead = client.hgetall
    const originalScan = client.sscan
    client.hgetall = async (key) => {
      if (
        key === 'usage:daily:key-fixture-private:2026-11-07' ||
        key.includes('fixture-failed-model:')
      ) {
        throw new Error(`${secret} synthetic storage failure`)
      }
      return originalRead(key)
    }
    client.sscan = async (key, ...args) => {
      if (key.endsWith('2026-11-06')) {
        throw new Error('synthetic index failure')
      }
      return originalScan(key, ...args)
    }
    const response = await get()
    expect(response.status).toBe(200)
    const { days } = response.body.tokenDays
    expect(days[28]).toEqual({
      date: '2026-11-07',
      cost: 0,
      input: null,
      output: null,
      cacheCreate: null,
      cacheRead: null,
      requests: null,
      models: []
    })
    expect(days[27].models).toBeNull()
    expect(days[27].input).toBe(0)
    expect(days[29].models[0]).toEqual({
      model: 'fixture-failed-model',
      input: null,
      output: null,
      cacheCreate: null,
      cacheRead: null,
      requests: null
    })
    expect(response.body.key.total.used).toBe(81)
    expect(JSON.stringify(response.body)).not.toContain(secret)
  })

  it('distinguishes unknown fields in an existing record from an absent record', async () => {
    put('usage:daily:key-fixture-private:2026-11-08', {
      inputTokens: '5',
      outputTokens: 'invalid',
      requests: '2'
    })
    const response = await get()
    expect(response.body.tokenDays.days[29]).toEqual({
      date: '2026-11-08',
      cost: 12.3,
      input: 5,
      output: null,
      cacheCreate: null,
      cacheRead: null,
      requests: 2,
      models: []
    })
  })

  it('deduplicates model index pages and tolerates a whole pipeline failure', async () => {
    modelDay('2026-11-08', 'fixture:paged-model', {
      inputTokens: '3',
      outputTokens: '0',
      cacheCreateTokens: '0',
      cacheReadTokens: '0',
      requests: '1'
    })
    const originalScan = client.sscan
    client.sscan = async (key, cursor, ...args) => {
      if (key.endsWith('2026-11-08')) {
        return [cursor === '0' ? '1' : '0', ['key-fixture-private:fixture:paged-model']]
      }
      return originalScan(key, cursor, ...args)
    }
    const originalPipeline = client.pipeline
    let batches = 0
    client.pipeline = () => {
      const pipeline = originalPipeline()
      if (++batches === 1) {
        pipeline.exec = async () => {
          throw new Error('synthetic batch failure')
        }
      }
      return pipeline
    }
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.body.tokenDays.days.every((day) => day.input === null)).toBe(true)
    expect(response.body.tokenDays.days.every((day) => day.cost === null)).toBe(true)
    expect(response.body.tokenDays.days[29].models).toEqual([
      {
        model: 'fixture:paged-model',
        input: 3,
        output: 0,
        cacheCreate: 0,
        cacheRead: 0,
        requests: 1
      }
    ])
  })

  it('batches thirty days of model history read-only with bounded pipelines (optional timing)', async () => {
    keyRecord({ permissions: 'gemini' })
    for (let i = 0; i < 30; i++) {
      const date = new Date(now - i * 86400000).toISOString().slice(0, 10)
      const counts = {
        inputTokens: '100',
        outputTokens: '50',
        cacheCreateTokens: '25',
        cacheReadTokens: '1000',
        requests: '4'
      }
      put(`usage:daily:key-fixture-private:${date}`, counts)
      for (let j = 0; j < 20; j++) {
        modelDay(date, `fixture-model-${j}`, counts)
      }
    }
    const before = structuredClone([...data])
    const response = await get()
    expect(response.status).toBe(200)
    expect(pipelines.map((batch) => batch.length)).toEqual([60, 30, 500, 100])
    expect(
      pipelines.flat().every(([command]) => ['hgetall', 'sscan', 'get'].includes(command))
    ).toBe(true)
    expect(response.body.tokenDays.days.every((day) => day.models.length === 12)).toBe(true)
    expect([...data]).toEqual(before)
    if (process.env.CRS_TOKEN_DAYS_BENCH === '1') {
      const { performance } = require('perf_hooks')
      const time = async () => {
        const durations = []
        for (let i = 0; i < 110; i++) {
          const start = performance.now()
          await get()
          if (i >= 10) {
            durations.push(performance.now() - start)
          }
        }
        durations.sort((a, b) => a - b)
        return { medianMs: durations[50], p95Ms: durations[94] }
      }
      const skip = jest.spyOn(redis, 'getDailyTokenStats').mockResolvedValue([])
      const baseline = await time()
      skip.mockRestore()
      const expanded = await time()
      console.log(
        JSON.stringify({
          tokenDaysBenchmark: {
            baseline,
            expanded,
            samples: 100,
            days: 30,
            modelsPerDay: 20,
            pipelineBatches: 4,
            hashReads: 630,
            costReads: 30,
            indexScans: 30
          }
        })
      )
    }
  })

  it('keeps missing and disabled account-name settings byte-identical', async () => {
    account('claude', 'fixture-claude')
    account('openai', 'fixture-openai')
    const baseline = await get()
    for (const value of [false, 'false']) {
      keyRecord({ showAccountNames: value })
      const response = await get()
      expect(response.text).toBe(baseline.text)
      expect(
        response.body.pools.flatMap((pool) => pool.accounts).every((row) => !('name' in row))
      ).toBe(true)
    }
  })

  it.each([true, 'true'])(
    'adds only display names when this key opts in with %s',
    async (value) => {
      account('claude', 'fixture-claude-a', { name: 'Z fixture <team>' })
      account('claude', 'fixture-claude-b', { name: 'A fixture & team' })
      account('openai', 'fixture-openai', { name: 'fixture-display@example.test' })
      const baseline = await get()
      keyRecord({ showAccountNames: value })
      const response = await get()
      const rows = response.body.pools.flatMap((pool) => pool.accounts)
      expect(rows.map((row) => row.name).sort()).toEqual(
        ['Z fixture <team>', 'A fixture & team', 'fixture-display@example.test'].sort()
      )
      const withoutNames = structuredClone(response.body)
      for (const pool of withoutNames.pools) {
        for (const row of pool.accounts) {
          delete row.name
        }
      }
      expect(withoutNames).toEqual(baseline.body)
      expect(JSON.stringify(response.body)).not.toContain(secret)
      keyRecord({ showAccountNames: false }, 'cr_test-anonymous-fixture', 'anonymous-key-fixture')
      const anonymous = await get('cr_test-anonymous-fixture')
      expect(
        anonymous.body.pools.flatMap((pool) => pool.accounts).every((row) => !('name' in row))
      ).toBe(true)
      keyRecord({ showAccountNames: false })
      expect((await get()).text).toBe(baseline.text)
    }
  )

  it('omits empty or non-string display names even when enabled', async () => {
    keyRecord({ showAccountNames: 'true' })
    for (const [index, name] of [undefined, null, '', '   ', 123].entries()) {
      account('claude', `fixture-empty-${index}`, { name })
    }
    const response = await get()
    const rows = response.body.pools.flatMap((pool) => pool.accounts)
    expect(rows).toHaveLength(5)
    expect(rows.every((row) => !('name' in row))).toBe(true)
  })

  it('keeps aliases stable through account addition, removal and ordering changes', async () => {
    account('claude', 'stable-account-private')
    const { alias } = (await get()).body.pools[0].accounts[0]
    account('claude', 'new-account-private')
    expect((await get()).body.pools[0].accounts.map((item) => item.alias)).toContain(alias)
    data.delete('claude:account:new-account-private')
    expect((await get()).body.pools[0].accounts[0].alias).toBe(alias)
  })

  it('never emits account identifiers, account metadata, tokens, proxies or other keys', async () => {
    account('claude', 'identifier-claude-private')
    account('openai', 'identifier-openai-private')
    keyRecord({}, 'cr_test-neighbor-private', 'neighbor-key-private')
    const response = await get()
    const body = JSON.stringify(response.body)
    for (const forbidden of [
      secret,
      'key-fixture-private',
      'identifier-claude-private',
      'identifier-openai-private',
      'fixture-private@example.test',
      'SECRET_ACCOUNT_NAME',
      'SECRET_ACCESS_TOKEN',
      'SECRET_REFRESH_TOKEN',
      'SECRET_PROXY',
      'neighbor-key-private',
      'cr_test-neighbor-private',
      '/admin'
    ]) {
      expect(body).not.toContain(forbidden)
    }
  })

  it('reads legacy hash mappings without repairing them and does not clean dangling mappings', async () => {
    const hash = apiKeyService._hashApiKey(secret)
    data.delete('apikey:hash_map')
    put(`apikey_hash:${hash}`, { id: 'key-fixture-private' })
    let before = structuredClone([...data])
    expect((await get()).status).toBe(200)
    expect([...data]).toEqual(before)
    put('apikey:hash_map', { [hash]: 'missing-key-private' })
    before = structuredClone([...data])
    expect((await get()).status).toBe(401)
    expect([...data]).toEqual(before)
  })

  it('returns a sanitized 503 and Retry-After when key statistics fail', async () => {
    jest
      .spyOn(redis, 'getCostStats')
      .mockRejectedValueOnce(new Error(`${secret} fixture-private@example.test`))
    const response = await get()
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'snapshot_unavailable' })
    expect(response.headers['retry-after']).toBe('30')
  })

  it('preserves healthy account data when another account cannot be read', async () => {
    account('claude', 'healthy-partial-private')
    account('claude', 'failed-partial-private')
    const originalGet = client.get
    const getSpy = jest.fn(async (key) => {
      if (key === 'temp_unavailable:claude-official:failed-partial-private') {
        throw new Error('SECRET_ACCESS_TOKEN failed-partial-private')
      }
      return originalGet(key)
    })
    client.get = getSpy
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.body.pools[0].accounts).toHaveLength(1)
    expect(response.body.pools[0].accounts[0].windows[0].usedPct).toBe(22)
    expect(response.body.errors).toContainEqual({
      scope: 'pool:claude',
      code: 'snapshot_unavailable'
    })
    expect(JSON.stringify(response.body)).not.toContain('SECRET_ACCESS_TOKEN')
    expect(JSON.stringify(response.body)).not.toContain('failed-partial-private')
  })

  it('keeps other pool members when an account hash read fails', async () => {
    account('claude', 'readable-account-private')
    account('claude', 'unreadable-account-private')
    const originalRead = client.hgetall
    client.hgetall = async (key) => {
      if (key === 'claude:account:unreadable-account-private') {
        throw new Error('SECRET_ACCESS_TOKEN')
      }
      return originalRead(key)
    }
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.body.pools[0].accounts).toHaveLength(1)
    expect(response.body.errors).toContainEqual({
      scope: 'pool:claude',
      code: 'snapshot_unavailable'
    })
  })

  it('honors response and Console fixed bindings without disclosing the shared pool', async () => {
    account('responses', 'bound-responses-private', { accountType: 'dedicated' })
    account('console', 'bound-console-private', { accountType: 'dedicated' })
    account('claude', 'outside-console-private')
    account('openai', 'outside-responses-private')
    keyRecord({
      claudeConsoleAccountId: 'bound-console-private',
      openaiAccountId: 'responses:bound-responses-private'
    })
    const response = await get()
    expect(response.body.pools.map((pool) => pool.bindingKind)).toEqual(['fixed', 'fixed'])
    for (const pool of response.body.pools) {
      expect(pool.accounts).toHaveLength(1)
      expect(pool.accounts[0].windows.every((window) => window.usedPct === null)).toBe(true)
    }
  })

  it('keeps unavailable fixed bindings restricted and exposes auto-stopped rate limits without repair', async () => {
    keyRecord({ claudeAccountId: 'missing-fixed-private', permissions: 'claude' })
    account('claude', 'other-shared-private')
    const missing = await get()
    expect(missing.body.pools[0]).toEqual({
      platform: 'claude',
      bindingKind: 'fixed',
      accounts: []
    })
    expect(missing.body.errors).toContainEqual({ scope: 'pool:claude', code: 'account_missing' })
    account('claude', 'missing-fixed-private', {
      rateLimitStatus: '',
      rateLimitAutoStopped: 'true',
      rateLimitEndAt: '2026-11-08T04:00:00Z',
      schedulable: 'false'
    })
    const before = structuredClone([...data])
    const limited = await get()
    expect(limited.body.pools[0].accounts[0].state).toBe('rate_limited')
    expect([...data]).toEqual(before)
  })

  it('includes shared Bedrock candidates as unknown windows and honors their fixed binding', async () => {
    put(
      'bedrock_account:shared-bedrock-private',
      JSON.stringify({
        id: 'shared-bedrock-private',
        accountType: 'shared',
        isActive: true,
        schedulable: true,
        accessKeyId: 'SECRET_AWS_ACCESS_KEY'
      })
    )
    account('console', 'console-without-type-private', { accountType: '' })
    const shared = await get()
    expect(shared.body.pools[0].accounts).toHaveLength(1)
    const item = shared.body.pools[0].accounts[0]
    expect(item.windows.every((window) => window.usedPct === null)).toBe(true)
    expect(item.tier).toBe('unknown')
    keyRecord({ bedrockAccountId: 'shared-bedrock-private', permissions: 'claude' })
    const fixed = await get()
    expect(fixed.body.pools[0].bindingKind).toBe('fixed')
    expect(fixed.body.pools[0].accounts[0].alias).toBe(item.alias)
    expect(JSON.stringify(fixed.body)).not.toContain('SECRET_AWS_ACCESS_KEY')
  })
})
