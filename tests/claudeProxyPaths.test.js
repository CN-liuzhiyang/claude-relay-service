const mockStore = new Map()

jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn(async (id) => mockStore.get(id) || {}),
  setClaudeAccount: jest.fn(async (id, data) => mockStore.set(id, { ...data }))
}))
jest.mock('../config/config', () => ({
  security: { encryptionKey: 'synthetic-encryption-key-for-test' },
  claude: {},
  proxy: {
    required: true,
    allowedEndpoints: ['socks5://127.0.0.1:17894', 'socks5://127.0.0.1:17897']
  }
}))
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  authDetail: jest.fn()
}))
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }))
jest.mock('../src/services/tokenRefreshService', () => ({
  acquireRefreshLock: jest.fn(async () => true),
  releaseRefreshLock: jest.fn(async () => {})
}))
jest.mock('../src/utils/tokenRefreshLogger', () => ({
  logRefreshStart: jest.fn(),
  logRefreshSuccess: jest.fn(),
  logRefreshError: jest.fn(),
  logTokenUsage: jest.fn(),
  logRefreshSkipped: jest.fn()
}))
jest.mock('../src/utils/webhookNotifier', () => ({ sendAccountAnomalyNotification: jest.fn() }))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({}))
jest.mock('../src/services/claudeCodeHeadersService', () => ({}))
jest.mock('../src/services/requestIdentityService', () => ({}))
jest.mock('../src/services/userMessageQueueService', () => ({}))

const realSetInterval = global.setInterval
global.setInterval = (fn, ms, ...args) => {
  const timer = realSetInterval(fn, ms, ...args)
  timer.unref()
  return timer
}
const accounts = require('../src/services/account/claudeAccountService')
const relay = require('../src/services/relay/claudeRelayService')
global.setInterval = realSetInterval
const oauth = require('../src/utils/oauthHelper')
const axios = require('axios')
const ProxyHelper = require('../src/utils/proxyHelper')
const https = require('https')
const { EventEmitter } = require('events')

describe('Claude account-specific egress with synthetic OAuth only', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockStore.clear()
    for (const [id, port] of [
      ['primary', 17894],
      ['secondary', 17897]
    ]) {
      mockStore.set(id, {
        id,
        name: 'Synthetic account',
        scopes: 'user:profile user:inference',
        proxy: JSON.stringify({ type: 'socks5', host: '127.0.0.1', port }),
        accessToken: accounts._encryptSensitiveData('synthetic-access-only'),
        refreshToken: accounts._encryptSensitiveData('synthetic-refresh-only')
      })
    }
    axios.post.mockResolvedValue({
      status: 200,
      data: {
        access_token: 'synthetic-replacement-access',
        refresh_token: 'synthetic-replacement-refresh',
        expires_in: 3600,
        scope: 'user:inference user:profile'
      }
    })
    axios.get.mockResolvedValue({
      status: 200,
      data: {
        account: { email: 'fixture@example.invalid' },
        five_hour: { utilization: 0 }
      }
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
    for (const agent of ProxyHelper._agentCache.values()) {
      agent.destroy()
    }
    ProxyHelper._agentCache.clear()
  })

  test.each(['primary', 'secondary'])(
    'exchange, refresh, profile and usage retain %s egress',
    async (id) => {
      const record = mockStore.get(id)
      const proxy = JSON.parse(record.proxy)
      const agent = ProxyHelper.createProxyAgent(proxy)
      await oauth.exchangeCodeForTokens(
        'synthetic-code',
        'synthetic-verifier',
        'synthetic-state',
        proxy
      )
      await accounts.refreshAccountToken(id)
      await accounts.fetchOAuthUsage(id, 'synthetic-replacement-access')
      expect(axios.post).toHaveBeenCalledTimes(2)
      expect(axios.get).toHaveBeenCalledTimes(2)
      for (const call of [...axios.post.mock.calls, ...axios.get.mock.calls]) {
        const options = call[call.length - 1]
        expect(options.httpAgent).toBe(agent)
        expect(options.httpsAgent).toBe(agent)
        expect(options.proxy).toBe(false)
        expect(options.headers['User-Agent']).toBe(
          require('../src/utils/claudeCodeVersion').getDefaultUserAgent()
        )
      }
      const saved = mockStore.get(id)
      expect(saved.accessToken).not.toContain('synthetic-replacement-access')
      expect(saved.refreshToken).not.toContain('synthetic-replacement-refresh')
      expect(accounts._decryptSensitiveData(saved.refreshToken)).toBe(
        'synthetic-replacement-refresh'
      )
      expect(saved.proxy).toBe(record.proxy)
    }
  )

  test.each([null, '{invalid', { type: 'http', host: '127.0.0.1', port: 7890 }])(
    'invalid assigned egress makes no exchange, refresh, profile or usage request',
    async (proxy) => {
      mockStore.get('secondary').proxy = proxy
      await expect(
        oauth.exchangeCodeForTokens('synthetic-code', 'verifier', 'state', proxy)
      ).rejects.toThrow()
      await expect(accounts.refreshAccountToken('secondary')).rejects.toThrow()
      await expect(
        accounts.fetchAndUpdateAccountProfile('secondary', 'synthetic-access-only')
      ).rejects.toThrow()
      expect(await accounts.fetchOAuthUsage('secondary', 'synthetic-access-only')).toBeNull()
      await expect(relay._getProxyAgent('secondary')).rejects.toMatchObject({
        code: 'PROXY_POLICY_REJECTED'
      })
      expect(axios.post).not.toHaveBeenCalled()
      expect(axios.get).not.toHaveBeenCalled()
    }
  )

  test('model transport passes the assigned agent and returns a synthetic response', async () => {
    const agent = await relay._getProxyAgent('secondary')
    jest.spyOn(relay, '_prepareRequestHeadersAndPayload').mockResolvedValue({
      bodyString: '{}',
      headers: {},
      isRealClaudeCode: true
    })
    const request = jest.spyOn(https, 'request').mockImplementation((options, callback) => {
      expect(options.agent).toBe(agent)
      const req = new EventEmitter()
      req.write = jest.fn()
      req.end = () => {
        const res = new EventEmitter()
        res.statusCode = 200
        res.headers = {}
        callback(res)
        res.emit(
          'data',
          Buffer.from('{"content":[{"text":"OK"}],"usage":{"input_tokens":1,"output_tokens":1}}')
        )
        res.emit('end')
      }
      return req
    })
    const response = await relay._makeClaudeRequest(
      {},
      'synthetic-access-only',
      agent,
      {},
      'secondary'
    )
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body).usage.output_tokens).toBe(1)
    expect(request).toHaveBeenCalledTimes(1)
  })

  test.each([true, false])(
    'stream transport retains its assigned egress on success=%s',
    async (success) => {
      const agent = await relay._getProxyAgent('secondary')
      jest
        .spyOn(relay, '_prepareRequestHeadersAndPayload')
        .mockResolvedValue({ bodyString: '{}', headers: {} })
      jest.spyOn(relay, 'clearUnauthorizedErrors').mockResolvedValue()
      jest.spyOn(accounts, 'clearInternalErrors').mockResolvedValue()
      jest.spyOn(accounts, 'isAccountOverloaded').mockResolvedValue(false)
      require('../src/services/scheduler/unifiedClaudeScheduler').isAccountRateLimited = jest.fn(
        async () => false
      )
      const stream = {
        headersSent: true,
        destroyed: false,
        writableEnded: false,
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn()
      }
      const usage = jest.fn()
      const request = jest.spyOn(https, 'request').mockImplementation((options, callback) => {
        expect(options.agent).toBe(agent)
        const req = new EventEmitter()
        req.write = jest.fn()
        req.end = () => {
          if (!success) {
            req.emit(
              'error',
              Object.assign(new Error('Synthetic closed proxy'), { code: 'ECONNREFUSED' })
            )
            return
          }
          const res = new EventEmitter()
          res.statusCode = 200
          res.headers = {}
          callback(res)
          res.emit(
            'data',
            Buffer.from(
              'data: {"type":"message_start","message":{"model":"synthetic-model","usage":{"input_tokens":1}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":1}}\n\n'
            )
          )
          res.emit('end')
        }
        return req
      })
      const result = relay._makeClaudeStreamRequestWithUsageCapture(
        {},
        'synthetic-access-only',
        agent,
        {},
        stream,
        usage,
        'secondary',
        'claude-official',
        null
      )
      if (success) {
        await result
        expect(usage).toHaveBeenCalledWith(
          expect.objectContaining({ input_tokens: 1, output_tokens: 1 })
        )
      } else {
        await expect(result).rejects.toMatchObject({ code: 'ECONNREFUSED' })
        expect(usage).not.toHaveBeenCalled()
      }
      expect(request).toHaveBeenCalledTimes(1)
      expect(stream.end).toHaveBeenCalled()
    }
  )
})
