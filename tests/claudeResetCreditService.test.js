jest.mock('axios')
jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn(),
  getClientSafe: jest.fn(),
  setAccountLock: jest.fn(),
  releaseAccountLock: jest.fn()
}))
jest.mock('../src/services/account/claudeAccountService', () => ({
  getValidAccessToken: jest.fn()
}))
jest.mock('../src/utils/proxyHelper', () => ({ createProxyAgent: jest.fn() }))
jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  success: jest.fn()
}))

const axios = require('axios')
const redis = require('../src/models/redis')
const claudeAccountService = require('../src/services/account/claudeAccountService')
const ProxyHelper = require('../src/utils/proxyHelper')
const service = require('../src/services/account/claudeResetCreditService')

const ORG = '11111111-2222-3333-4444-555555555555'
const future = (ms) => new Date(Date.now() + ms).toISOString()
const past = (ms) => new Date(Date.now() - ms).toISOString()

const grant = (over = {}) => ({
  id: 'grant_abc',
  label: 'Reset card',
  resets_left: 1,
  starts_at: past(1000),
  ends_at: future(86400000),
  clears: ['five_hour'],
  paused: false,
  usable_now: true,
  use_requires_limit: true,
  percent_used: { five_hour: 100 },
  blocking: [],
  ...over
})
const block = (over = {}) => ({
  eligible: true,
  at_limit: true,
  grants: [grant()],
  next_grant_id: 'grant_abc',
  cooldown_until: null,
  weekly_resets_at: null,
  ...over
})

describe('projectCredits', () => {
  const { projectCredits } = service._internals

  it('hides grant ids and reports redeemable credits', () => {
    const result = projectCredits(block())
    expect(result.availableCount).toBe(1)
    expect(result.credits[0].redeemable).toBe(true)
    expect(JSON.stringify(result)).not.toContain('grant_abc')
  })

  it('is not redeemable when not at limit but the grant requires it', () => {
    const result = projectCredits(block({ at_limit: false }))
    expect(result.credits).toHaveLength(1)
    expect(result.credits[0].redeemable).toBe(false)
    expect(result.availableCount).toBe(0)
  })

  it('is not redeemable when it is not the upstream next grant, blocked, or cooling down', () => {
    expect(projectCredits(block({ next_grant_id: 'other' })).availableCount).toBe(0)
    expect(projectCredits(block({ grants: [grant({ blocking: ['x'] })] })).availableCount).toBe(0)
    const cooling = projectCredits(block({ cooldown_until: future(60000) }))
    expect(cooling.availableCount).toBe(0)
    expect(cooling.cooldownUntil).not.toBeNull()
  })

  it('drops expired, paused, empty and malformed grants', () => {
    const grants = [
      grant({ id: 'a1', ends_at: past(1) }),
      grant({ id: 'a2', paused: true }),
      grant({ id: 'a3', resets_left: 0 }),
      grant({ id: 'BAD ID' }),
      grant({ id: 'a5', clears: [] })
    ]
    expect(projectCredits(block({ grants, next_grant_id: 'a1' })).credits).toHaveLength(0)
  })

  it('handles a missing block', () => {
    expect(projectCredits(null).credits).toEqual([])
  })
})

describe('query / redeem', () => {
  let store
  let client

  beforeEach(() => {
    jest.clearAllMocks()
    store = new Map()
    client = {
      get: jest.fn(async (k) => store.get(k) || null),
      set: jest.fn(async (k, v) => {
        store.set(k, v)
        return 'OK'
      })
    }
    redis.getClientSafe.mockReturnValue(client)
    redis.setAccountLock.mockResolvedValue(true)
    redis.releaseAccountLock.mockResolvedValue(true)
    redis.getClaudeAccount.mockResolvedValue({
      id: 'acc1',
      name: 'test',
      scopes: 'user:profile user:inference',
      proxy: '{"type":"socks5","host":"127.0.0.1","port":1080}'
    })
    claudeAccountService.getValidAccessToken.mockResolvedValue('tok')
    ProxyHelper.createProxyAgent.mockReturnValue({ agent: true })
  })

  const mockUpstream = ({ usage, claim }) => {
    axios.mockImplementation(async ({ method, url }) => {
      if (url.includes('/oauth/usage')) {
        return { status: 200, data: { cedar_ember: typeof usage === 'function' ? usage() : usage } }
      }
      if (url.includes('/oauth/profile')) {
        return { status: 200, data: { organization: { uuid: ORG } } }
      }
      if (method === 'post' && url.includes('/reset_rate_limits')) {
        return claim
      }
      throw new Error(`unexpected ${url}`)
    })
  }

  it('refuses to run without a proxy agent', async () => {
    ProxyHelper.createProxyAgent.mockReturnValue(null)
    await expect(service.query('acc1')).rejects.toMatchObject({ code: 'PROXY_REQUIRED' })
    expect(axios).not.toHaveBeenCalled()
  })

  it('refuses accounts without user:profile scope', async () => {
    redis.getClaudeAccount.mockResolvedValue({ id: 'acc1', scopes: 'user:inference' })
    await expect(service.query('acc1')).rejects.toMatchObject({ code: 'PROFILE_SCOPE_REQUIRED' })
  })

  it('sends every request through the proxy agent without following redirects', async () => {
    mockUpstream({ usage: block() })
    await service.query('acc1')
    const cfg = axios.mock.calls[0][0]
    expect(cfg.httpsAgent).toEqual({ agent: true })
    expect(cfg.proxy).toBe(false)
    expect(cfg.maxRedirects).toBe(0)
  })

  it('redeems once and replays the stored outcome for the same key', async () => {
    mockUpstream({
      usage: block(),
      claim: { status: 200, data: { result: 'reset', cleared: ['five_hour', 'evil'] } }
    })
    const first = await service.redeem('acc1', 'key-12345678')
    expect(first.outcome).toBe('reset')
    expect(first.cleared).toEqual(['five_hour'])
    const claims = () =>
      axios.mock.calls.filter(([c]) => c.method === 'post' && c.url.includes('reset_rate_limits'))
    expect(claims()).toHaveLength(1)
    expect(claims()[0][0].data.grant_id).toBe('grant_abc')

    const again = await service.redeem('acc1', 'key-12345678')
    expect(again.replayed).toBe(true)
    expect(claims()).toHaveLength(1)
  })

  it('does not claim when nothing is redeemable', async () => {
    mockUpstream({ usage: block({ at_limit: false }) })
    await expect(service.redeem('acc1', 'key-12345678')).rejects.toMatchObject({
      code: 'NOT_AVAILABLE'
    })
    expect(axios.mock.calls.some(([c]) => c.method === 'post')).toBe(false)
  })

  it('fences the organization after an unconfirmed claim', async () => {
    mockUpstream({ usage: block(), claim: { status: 500, data: {} } })
    const first = await service.redeem('acc1', 'key-aaaaaaaa')
    expect(first.outcome).toBe('unknown')
    await expect(service.redeem('acc1', 'key-bbbbbbbb')).rejects.toMatchObject({
      code: 'UNRESOLVED'
    })
    // 同一次确认重试：返回之前的结果，不重发
    const retry = await service.redeem('acc1', 'key-aaaaaaaa')
    expect(retry.outcome).toBe('unknown')
    expect(
      axios.mock.calls.filter(([c]) => c.method === 'post' && c.url.includes('reset_rate_limits'))
    ).toHaveLength(1)
  })

  it('rejects a missing idempotency key and a busy lease', async () => {
    await expect(service.redeem('acc1', '')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED'
    })
    redis.setAccountLock.mockResolvedValue(false)
    await expect(service.redeem('acc1', 'key-12345678')).rejects.toMatchObject({ code: 'BUSY' })
  })
})
