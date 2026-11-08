jest.mock('../config/config', () => ({
  security: { encryptionKey: 'synthetic-test-encryption-key-only' },
  claude: {}
}))
jest.mock('../src/models/redis', () => ({
  getAllClaudeAccounts: jest.fn(),
  getClaudeAccount: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))
jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(),
  getProxyDescription: jest.fn(() => 'fixture proxy')
}))
jest.mock('../src/services/tokenRefreshService', () => ({}))
jest.mock('../src/utils/tokenRefreshLogger', () => ({}))
jest.mock('axios', () => ({ get: jest.fn() }))

describe('Claude OAuth background usage refresh', () => {
  let service
  let redis
  let fetch
  let update
  let accounts
  const usage = { five_hour: { utilization: 19 } }
  const account = (id, overrides = {}) => ({
    id,
    isActive: 'true',
    status: 'active',
    schedulable: 'true',
    scopes: 'user:profile user:inference',
    ...overrides
  })

  beforeEach(() => {
    jest.resetModules()
    jest.useFakeTimers()
    service = require('../src/services/account/claudeAccountService')
    redis = require('../src/models/redis')
    accounts = [account('fixture-first'), account('fixture-second')]
    redis.getAllClaudeAccounts.mockImplementation(async () => accounts)
    redis.getClaudeAccount.mockImplementation(async (id) => accounts.find((item) => item.id === id))
    fetch = jest.spyOn(service, 'fetchOAuthUsage').mockResolvedValue(usage)
    update = jest.spyOn(service, 'updateClaudeUsageSnapshot').mockResolvedValue()
  })

  afterEach(() => {
    service.stopClaudeUsageRefresh()
    jest.restoreAllMocks()
    jest.clearAllMocks()
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('delays startup and defaults to a ten-minute round with staggered account requests', async () => {
    service.startClaudeUsageRefresh()
    expect(redis.getAllClaudeAccounts).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(599999)
    expect(fetch).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    expect(fetch.mock.calls).toEqual([['fixture-first']])
    await jest.advanceTimersByTimeAsync(299999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(fetch.mock.calls).toEqual([['fixture-first'], ['fixture-second']])
    await jest.advanceTimersByTimeAsync(300000)
    expect(fetch.mock.calls[2]).toEqual(['fixture-first'])
    expect(update).toHaveBeenCalledWith('fixture-first', usage)
  })

  it('uses the configured interval and ignores duplicate starts', async () => {
    service.startClaudeUsageRefresh(9000)
    service.startClaudeUsageRefresh(1000)
    await jest.advanceTimersByTimeAsync(8999)
    expect(fetch).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(4500)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([0, -1, NaN, Infinity, 2147483648])(
    'falls back to ten minutes for invalid interval %s',
    async (interval) => {
      service.startClaudeUsageRefresh(interval)
      await jest.advanceTimersByTimeAsync(599999)
      expect(fetch).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(1)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  )

  it('skips setup-token, inactive, unhealthy and unschedulable accounts', async () => {
    accounts = [
      account('fixture-eligible'),
      account('fixture-disabled', { isActive: 'false' }),
      account('fixture-disabled-bool', { isActive: false }),
      account('fixture-inactive', { status: 'inactive' }),
      account('fixture-unauthorized', { status: 'unauthorized' }),
      account('fixture-error', { status: 'error' }),
      account('fixture-stopped', { schedulable: 'false' }),
      account('fixture-stopped-bool', { schedulable: false }),
      account('fixture-setup-token', { scopes: 'user:inference' }),
      account('fixture-missing-inference', { scopes: 'user:profile' }),
      account('fixture-missing-scopes', { scopes: '' })
    ]
    service.startClaudeUsageRefresh(1000)
    await jest.advanceTimersByTimeAsync(3000)
    expect(fetch.mock.calls.every(([id]) => id === 'fixture-eligible')).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('rechecks eligibility between accounts and reloads membership each round', async () => {
    service.startClaudeUsageRefresh(6000)
    await jest.advanceTimersByTimeAsync(6000)
    accounts[1].schedulable = 'false'
    accounts.push(account('fixture-added'))
    await jest.advanceTimersByTimeAsync(3000)
    expect(fetch.mock.calls).toEqual([['fixture-first']])
    await jest.advanceTimersByTimeAsync(6000)
    expect(fetch.mock.calls).toContainEqual(['fixture-added'])
    expect(redis.getAllClaudeAccounts).toHaveBeenCalledTimes(2)
  })

  it('waits for a slow fetch and storage update without overlapping accounts or rounds', async () => {
    let finishFetch
    let finishUpdate
    fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFetch = resolve
        })
    )
    update.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpdate = resolve
        })
    )
    service.startClaudeUsageRefresh(6000)
    await jest.advanceTimersByTimeAsync(6000)
    await jest.advanceTimersByTimeAsync(60000)
    expect(fetch).toHaveBeenCalledTimes(1)
    finishFetch(usage)
    await jest.advanceTimersByTimeAsync(0)
    expect(update).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(60000)
    expect(fetch).toHaveBeenCalledTimes(1)
    finishUpdate()
    await jest.advanceTimersByTimeAsync(3000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('logs fetch, persistence and enumeration failures and continues scheduling', async () => {
    const logger = require('../src/utils/logger')
    fetch.mockRejectedValueOnce(new Error('synthetic fetch failure'))
    update.mockRejectedValueOnce(new Error('synthetic storage failure'))
    service.startClaudeUsageRefresh(2000)
    await jest.advanceTimersByTimeAsync(3000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledTimes(2)
    redis.getAllClaudeAccounts.mockRejectedValueOnce(new Error('synthetic list failure'))
    await jest.advanceTimersByTimeAsync(1000)
    expect(logger.warn).toHaveBeenCalledTimes(3)
    await jest.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('does not persist a null usage response and retries an empty pool on the next interval', async () => {
    accounts = []
    service.startClaudeUsageRefresh(2000)
    await jest.advanceTimersByTimeAsync(2000)
    expect(fetch).not.toHaveBeenCalled()
    accounts.push(account('fixture-new'))
    fetch.mockResolvedValueOnce(null)
    await jest.advanceTimersByTimeAsync(2000)
    expect(fetch).toHaveBeenCalledWith('fixture-new')
    expect(update).not.toHaveBeenCalled()
  })

  it('stop clears its pending timer and is idempotent', async () => {
    const initialTimers = jest.getTimerCount()
    service.startClaudeUsageRefresh(1000)
    expect(jest.getTimerCount()).toBe(initialTimers + 1)
    service.stopClaudeUsageRefresh()
    service.stopClaudeUsageRefresh()
    expect(jest.getTimerCount()).toBe(initialTimers)
    await jest.advanceTimersByTimeAsync(10000)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('stop prevents post-fetch writes and restart waits for the previous in-flight request', async () => {
    let finish
    fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    service.startClaudeUsageRefresh(1000)
    await jest.advanceTimersByTimeAsync(1000)
    service.stopClaudeUsageRefresh()
    service.startClaudeUsageRefresh(1000)
    await jest.advanceTimersByTimeAsync(5000)
    expect(fetch).toHaveBeenCalledTimes(1)
    finish(usage)
    await jest.advanceTimersByTimeAsync(0)
    expect(update).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(2)
    service.stopClaudeUsageRefresh()
    await jest.advanceTimersByTimeAsync(10000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('uses fetchOAuthUsage with the account proxy and valid token, without real network access', async () => {
    fetch.mockRestore()
    const axios = require('axios')
    const proxy = require('../src/utils/proxyHelper')
    const agent = { fixtureAgent: true }
    const proxyConfig = { type: 'socks5', host: 'proxy.example', port: 1080 }
    accounts = [account('fixture-proxied', { proxy: JSON.stringify(proxyConfig) })]
    jest.spyOn(service, 'getValidAccessToken').mockResolvedValue('synthetic-access-token-only')
    proxy.createProxyAgent.mockReturnValue(agent)
    axios.get.mockResolvedValue({ status: 200, data: usage })
    service.startClaudeUsageRefresh(1000)
    await jest.advanceTimersByTimeAsync(1000)
    expect(proxy.createProxyAgent).toHaveBeenCalledWith(JSON.stringify(proxyConfig), {
      required: true
    })
    expect(axios.get).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        headers: expect.objectContaining({ Authorization: 'Bearer synthetic-access-token-only' })
      })
    )
    expect(update).toHaveBeenCalledWith('fixture-proxied', usage)
  })
})
