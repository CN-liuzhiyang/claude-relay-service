const mockRedisData = new Map()
const mockMemoryCache = new Map()
const mockClient = {
  get: jest.fn(async (key) => mockRedisData.get(key) || null),
  setex: jest.fn(async (key, _ttl, value) => mockRedisData.set(key, value)),
  expire: jest.fn(async () => 1)
}

jest.mock('../src/models/redis', () => ({
  client: mockClient,
  getClient: () => mockClient
}))
jest.mock('../config/config', () => ({
  claude: { apiVersion: '2023-06-01', betaHeader: 'oauth-2025-04-20' }
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  api: jest.fn()
}))
jest.mock('../src/utils/performanceOptimizer', () => ({
  getCachedConfig: (key) => mockMemoryCache.get(key),
  setCachedConfig: (key, value) => mockMemoryCache.set(key, value),
  deleteCachedConfig: (key) => mockMemoryCache.delete(key)
}))
jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('../src/utils/sessionHelper', () => ({}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({}))
jest.mock('../src/services/requestIdentityService', () => ({}))
jest.mock('../src/services/userMessageQueueService', () => ({}))
jest.mock('../src/services/pricingService', () => ({}))
jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (_req, _res, next) => next()
}))
jest.mock('axios', () => jest.fn())

const version = require('../src/utils/claudeCodeVersion')
const headersService = require('../src/services/claudeCodeHeadersService')
const relay = require('../src/services/relay/claudeRelayService')
const axios = require('axios')
const originalVersion = process.env.CLAUDE_CODE_VERSION
const dailyKey = 'claude_code_user_agent:daily'
const latestUA = 'claude-cli/2.1.289 (external, cli)'
const newerUA = 'claude-cli/2.2.0 (external, vscode)'
const capturedHeaders = {
  'user-agent': 'claude-cli/2.1.173 (external, cli)',
  'x-stainless-package-version': '0.55.1',
  'x-stainless-os': 'Windows',
  'x-stainless-runtime-version': 'v20.19.2'
}

beforeEach(() => {
  delete process.env.CLAUDE_CODE_VERSION
  jest.clearAllMocks()
  mockRedisData.clear()
  mockMemoryCache.clear()
})
afterEach(() => {
  jest.restoreAllMocks()
  if (originalVersion === undefined) {
    delete process.env.CLAUDE_CODE_VERSION
  } else {
    process.env.CLAUDE_CODE_VERSION = originalVersion
  }
})

describe('configured CC version declaration', () => {
  test('admin metadata exposes the configured declaration even when the daily cache is empty', async () => {
    const router = require('../src/routes/admin/system')
    const route = router.stack.find((layer) => layer.route?.path === '/claude-code-version')
    const response = { json: jest.fn() }
    await route.route.stack[route.route.stack.length - 1].handle({}, response)
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredVersion: '2.1.289',
        defaultUserAgent: latestUA,
        userAgent: null,
        isActive: false
      })
    )
  })

  test('defaults to the verified release and accepts a stable version override', () => {
    expect(version.getDefaultUserAgent()).toBe(latestUA)
    process.env.CLAUDE_CODE_VERSION = '2.1.300'
    expect(version.getDefaultUserAgent()).toBe('claude-cli/2.1.300 (external, cli)')
    expect(version.withMinimumVersion(latestUA)).toBe('claude-cli/2.1.300 (external, cli)')
    expect(version.withMinimumVersion(newerUA)).toBe(newerUA)
  })

  test.each(['not-a-version', '2.1', '2.1.300\r\nInjected: header'])(
    'rejects invalid configured version without returning an injected header',
    (value) => {
      process.env.CLAUDE_CODE_VERSION = value
      expect(() => version.getDefaultUserAgent()).toThrow('major.minor.patch')
    }
  )

  test.each([
    ['claude-cli/1.0.57 (external, cli)', latestUA],
    ['claude-cli/1.0.119 (external, cli)', latestUA],
    ['claude-cli/2.1.286 (external, vscode)', 'claude-cli/2.1.289 (external, vscode)'],
    [latestUA, latestUA],
    [newerUA, newerUA],
    ['Anthropic/Python 0.55.1', 'Anthropic/Python 0.55.1'],
    [undefined, latestUA]
  ])('upgrades only older CC versions in %s', (input, expected) => {
    expect(version.withMinimumVersion(input)).toBe(expected)
  })
})

describe('captured client metadata and outgoing declarations', () => {
  test.each(['redis', 'memory'])(
    'upgrades outgoing %s headers without changing their capture',
    async (source) => {
      const key = 'claude_code_headers:synthetic-account'
      if (source === 'redis') {
        mockRedisData.set(key, JSON.stringify({ headers: capturedHeaders, version: '2.1.173' }))
      } else {
        mockMemoryCache.set(key, capturedHeaders)
      }
      const result = await headersService.getAccountHeaders('synthetic-account')
      expect(result).toEqual({ ...capturedHeaders, 'user-agent': latestUA })
      expect(capturedHeaders['user-agent']).toContain('2.1.173')
      expect(mockMemoryCache.get(key)['user-agent']).toContain('2.1.173')
      expect(mockClient.setex).not.toHaveBeenCalled()
    }
  )

  test('keeps genuine captures and only replaces them with a newer client version', async () => {
    await headersService.storeAccountHeaders('synthetic-account', capturedHeaders)
    expect(JSON.parse(mockRedisData.get('claude_code_headers:synthetic-account')).version).toBe(
      '2.1.173'
    )
    expect((await headersService.getAccountHeaders('synthetic-account'))['user-agent']).toBe(
      latestUA
    )
    await headersService.storeAccountHeaders('synthetic-account', { 'user-agent': newerUA })
    await headersService.storeAccountHeaders('synthetic-account', capturedHeaders)
    expect(
      JSON.parse(mockRedisData.get('claude_code_headers:synthetic-account')).headers['user-agent']
    ).toBe(newerUA)
    expect((await headersService.getAccountHeaders('synthetic-account'))['user-agent']).toBe(
      newerUA
    )
  })

  test('ignores non-CC capture and retains the SDK defaults', async () => {
    await headersService.storeAccountHeaders('synthetic-account', { 'user-agent': 'Python/3.12' })
    expect(mockClient.setex).not.toHaveBeenCalled()
    const headers = await headersService.getAccountHeaders('synthetic-account')
    expect(headers['user-agent']).toBe(latestUA)
    expect(headers['x-stainless-package-version']).toBe('0.55.1')
    expect(headers['x-stainless-os']).toBe('Windows')
    expect(headers['x-stainless-runtime-version']).toBe('v20.19.2')
  })
})

describe('unified daily declaration', () => {
  test.each([null, 'claude-cli/1.0.119 (external, cli)', 'unrelated-client/1.0'])(
    'seeds or repairs %s without requiring a real client request',
    async (cached) => {
      if (cached) mockRedisData.set(dailyKey, cached)
      expect(await relay.captureAndGetUnifiedUserAgent({}, { useUnifiedUserAgent: 'true' })).toBe(
        latestUA
      )
      expect(mockClient.setex).toHaveBeenCalledWith(dailyKey, 90000, latestUA)
    }
  )

  test('retains newer captures and refreshes TTL instead of accepting a downgrade', async () => {
    mockRedisData.set(dailyKey, newerUA)
    expect(
      await relay.captureAndGetUnifiedUserAgent(
        { 'user-agent': latestUA },
        { useUnifiedUserAgent: 'true' }
      )
    ).toBe(newerUA)
    expect(mockClient.setex).not.toHaveBeenCalled()
    expect(mockClient.expire).toHaveBeenCalledWith(dailyKey, 90000)
  })

  test('captures a newer real client including its context', async () => {
    mockRedisData.set(dailyKey, latestUA)
    expect(
      await relay.captureAndGetUnifiedUserAgent(
        { 'User-Agent': newerUA },
        { useUnifiedUserAgent: 'true' }
      )
    ).toBe(newerUA)
    expect(mockClient.setex).toHaveBeenCalledWith(dailyKey, 90000, newerUA)
  })

  test('chooses the newer real client context before applying the configured version floor', async () => {
    mockRedisData.set(dailyKey, 'claude-cli/2.1.173 (external, cli)')
    const clientUA = 'claude-cli/2.1.286 (external, vscode)'
    const expected = 'claude-cli/2.1.289 (external, vscode)'
    expect(
      await relay.captureAndGetUnifiedUserAgent(
        { 'user-agent': clientUA },
        { useUnifiedUserAgent: 'true' }
      )
    ).toBe(expected)
    expect(mockClient.setex).toHaveBeenCalledWith(dailyKey, 90000, expected)
  })

  test('disabled account setting never reads or writes the daily cache', async () => {
    const account = { useUnifiedUserAgent: 'false', unifiedClientId: 'synthetic-id' }
    expect(
      await relay.captureAndGetUnifiedUserAgent({ 'user-agent': latestUA }, account)
    ).toBeNull()
    expect(mockClient.get).not.toHaveBeenCalled()
    expect(mockClient.setex).not.toHaveBeenCalled()
    expect(account).toEqual({ useUnifiedUserAgent: 'false', unifiedClientId: 'synthetic-id' })
  })
})

describe('Claude model header preparation', () => {
  test.each([true, false])(
    'uses the effective version for stream=%s with unified mode disabled',
    async (isStream) => {
      jest
        .spyOn(relay, '_applyRequestIdentityTransform')
        .mockImplementation((body, headers) => ({ body, headers }))
      const clientHeaders = { ...capturedHeaders, 'anthropic-version': '2023-06-01' }
      const result = await relay._prepareRequestHeadersAndPayload(
        { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'synthetic' }] },
        clientHeaders,
        'synthetic-account',
        'synthetic-access-only',
        {
          account: { useUnifiedUserAgent: 'false' },
          isStream,
          requestOptions: { isRealClaudeCodeRequest: true }
        }
      )
      expect(result.headers['User-Agent']).toBe(latestUA)
      expect(result.headers['anthropic-version']).toBe('2023-06-01')
      expect(result.headers['x-stainless-package-version']).toBe('0.55.1')
      expect(result.headers['x-stainless-os']).toBe('Windows')
      expect(result.headers['x-stainless-runtime-version']).toBe('v20.19.2')
      expect(clientHeaders['user-agent']).toContain('2.1.173')
      expect(mockClient.setex).not.toHaveBeenCalled()
    }
  )

  test('converted requests upgrade old captured headers and preserve identity fields', async () => {
    mockMemoryCache.set('claude_code_headers:synthetic-account', capturedHeaders)
    jest
      .spyOn(relay, '_applyRequestIdentityTransform')
      .mockImplementation((body, headers) => ({ body, headers }))
    jest.spyOn(relay, '_transformToolNamesInRequestBody').mockReturnValue(null)
    const account = { useUnifiedUserAgent: 'false', unifiedClientId: 'synthetic-id' }
    const result = await relay._prepareRequestHeadersAndPayload(
      { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'synthetic' }] },
      {},
      'synthetic-account',
      'synthetic-access-only',
      { account, requestOptions: { isRealClaudeCodeRequest: false } }
    )
    expect(result.headers['User-Agent']).toBe(latestUA)
    expect(result.headers['x-stainless-os']).toBe('Windows')
    expect(account.unifiedClientId).toBe('synthetic-id')
  })

  test('the admin stream test uses the same version without an upstream request', async () => {
    axios.mockRejectedValue(new Error('synthetic transport stop'))
    const response = { writeHead: jest.fn(), write: jest.fn(), end: jest.fn() }
    await require('../src/utils/testPayloadHelper').sendStreamTestRequest({
      apiUrl: 'https://upstream.invalid/v1/messages',
      responseStream: response,
      payload: {}
    })
    expect(axios.mock.calls[0][0].headers['User-Agent']).toBe(latestUA)
  })
})
