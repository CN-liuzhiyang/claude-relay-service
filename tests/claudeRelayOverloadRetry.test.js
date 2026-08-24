const { EventEmitter } = require('events')
const https = require('https')

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  api: jest.fn(),
  performance: jest.fn()
}))

jest.mock('../src/utils/sessionHelper', () => ({
  generateSessionHash: jest.fn(() => 'session-hash')
}))

jest.mock('../src/services/account/claudeAccountService', () => ({
  getAccount: jest.fn(async () => ({ id: 'account-1', name: 'claude0' })),
  getValidAccessToken: jest.fn(async () => 'access-token'),
  clearExpiredOpusRateLimit: jest.fn(async () => {}),
  isAccountOpusRateLimited: jest.fn(async () => false),
  isAccountOverloaded: jest.fn(async () => false),
  clearInternalErrors: jest.fn(async () => {}),
  markAccountOverloaded: jest.fn(async () => {})
}))

jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  selectAccountForApiKey: jest.fn(async () => ({
    accountId: 'account-1',
    accountType: 'claude-official'
  })),
  isAccountRateLimited: jest.fn(async () => false),
  clearSessionMapping: jest.fn(async () => {})
}))

jest.mock('../src/services/userMessageQueueService', () => ({
  isUserMessageRequest: jest.fn(() => false),
  releaseQueueLock: jest.fn(async () => {})
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(async () => ({ success: true, ttlSeconds: 600 })),
  parseRetryAfter: jest.fn(() => null)
}))

jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/services/claudeCodeHeadersService', () => ({
  storeAccountHeaders: jest.fn(async () => {})
}))
jest.mock('../src/services/requestIdentityService', () => ({
  transform: jest.fn(({ body, headers }) => ({ body, headers }))
}))
jest.mock('../src/utils/testPayloadHelper', () => ({ createClaudeTestPayload: jest.fn() }))

const claudeRelayService = require('../src/services/relay/claudeRelayService')
const claudeAccountService = require('../src/services/account/claudeAccountService')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')

const overloadResponse = () => ({
  statusCode: 529,
  headers: {
    'content-type': 'application/json',
    'x-should-retry': 'true'
  },
  body: JSON.stringify({
    type: 'error',
    error: { type: 'overloaded_error', message: 'Overloaded' },
    request_id: 'req_overload_test'
  })
})

const successResponse = () => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: 'msg_test',
    type: 'message',
    model: 'claude-opus-5',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 }
  })
})

describe('claudeRelayService 529 overload retry', () => {
  const requestBody = {
    model: 'claude-opus-5',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }]
  }
  const apiKeyData = { id: 'key-1', name: 'test-key' }

  beforeEach(() => {
    jest.clearAllMocks()
    claudeRelayService.bodyStore.clear()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('retries non-stream 529 three times and returns an explicit 10-minute cooldown', async () => {
    jest.spyOn(claudeRelayService, '_isActualClaudeCodeRequest').mockReturnValue(true)
    jest.spyOn(claudeRelayService, '_processRequestBody').mockReturnValue(requestBody)
    jest.spyOn(claudeRelayService, '_getProxyAgent').mockResolvedValue(undefined)
    const makeRequest = jest
      .spyOn(claudeRelayService, '_makeClaudeRequest')
      .mockResolvedValueOnce(overloadResponse())
      .mockResolvedValueOnce(overloadResponse())
      .mockResolvedValueOnce(overloadResponse())
      .mockResolvedValueOnce(overloadResponse())
    const sleep = jest.spyOn(claudeRelayService, '_sleep').mockResolvedValue(undefined)

    const response = await claudeRelayService.relayRequest(
      requestBody,
      apiKeyData,
      null,
      null,
      {},
      {}
    )

    expect(makeRequest).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([1000, 2000, 4000])
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledTimes(1)
    expect(response.statusCode).toBe(529)
    expect(response.headers['retry-after']).toBe('600')
    expect(response.headers['x-relay-retry-count']).toBe('3')

    const body = JSON.parse(response.body)
    expect(body.error.type).toBe('overloaded_error')
    expect(body.error.message).toContain('中转已自动重试 3 次')
    expect(body.error.message).toContain('10 分钟后再试')
    expect(body.request_id).toBe('req_overload_test')
    expect(body.retry_after_seconds).toBe(600)
    expect(body.relay_retry_count).toBe(3)
  })

  it('returns a successful non-stream response when an overload retry recovers', async () => {
    jest.spyOn(claudeRelayService, '_isActualClaudeCodeRequest').mockReturnValue(true)
    jest.spyOn(claudeRelayService, '_processRequestBody').mockReturnValue(requestBody)
    jest.spyOn(claudeRelayService, '_getProxyAgent').mockResolvedValue(undefined)
    const makeRequest = jest
      .spyOn(claudeRelayService, '_makeClaudeRequest')
      .mockResolvedValueOnce(overloadResponse())
      .mockResolvedValueOnce(overloadResponse())
      .mockResolvedValueOnce(successResponse())
    const sleep = jest.spyOn(claudeRelayService, '_sleep').mockResolvedValue(undefined)
    jest.spyOn(claudeRelayService, 'clearUnauthorizedErrors').mockResolvedValue(undefined)

    const response = await claudeRelayService.relayRequest(
      requestBody,
      apiKeyData,
      null,
      null,
      {},
      {}
    )

    expect(makeRequest).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([1000, 2000])
    expect(response.statusCode).toBe(200)
    expect(upstreamErrorHelper.markTempUnavailable).not.toHaveBeenCalled()
    expect(claudeAccountService.clearInternalErrors).toHaveBeenCalledWith('account-1')
    expect(unifiedClaudeScheduler.isAccountRateLimited).toHaveBeenCalled()
  })

  it('retries stream 529 three times before returning the cooldown body', async () => {
    jest.spyOn(claudeRelayService, '_prepareRequestHeadersAndPayload').mockResolvedValue({
      bodyString: JSON.stringify(requestBody),
      headers: {},
      toolNameMap: new Map()
    })
    const sleep = jest.spyOn(claudeRelayService, '_sleep').mockResolvedValue(undefined)

    const upstreamBody = overloadResponse().body
    const request = jest.spyOn(https, 'request').mockImplementation((_options, callback) => {
      const req = new EventEmitter()
      req.destroyed = false
      req.write = jest.fn()
      req.destroy = jest.fn(() => {
        req.destroyed = true
      })
      req.end = jest.fn(() => {
        const res = new EventEmitter()
        res.statusCode = 529
        res.headers = { 'x-should-retry': 'true' }
        res.resume = jest.fn()
        callback(res)
        setImmediate(() => {
          res.emit('data', Buffer.from(upstreamBody))
          res.emit('end')
        })
      })
      return req
    })

    const responseHeaders = {}
    const responseChunks = []
    const responseStream = {
      headersSent: false,
      destroyed: false,
      writableEnded: false,
      socket: { destroyed: false },
      status: jest.fn(function setStatus(statusCode) {
        this.statusCode = statusCode
        return this
      }),
      setHeader: jest.fn((name, value) => {
        responseHeaders[name.toLowerCase()] = value
      }),
      on: jest.fn(),
      write: jest.fn((chunk) => {
        responseChunks.push(chunk)
      }),
      end: jest.fn(function end() {
        this.writableEnded = true
      })
    }

    const bodyStoreId = 999
    claudeRelayService.bodyStore.set(bodyStoreId, JSON.stringify(requestBody))

    await claudeRelayService._makeClaudeStreamRequestWithUsageCapture(
      requestBody,
      'access-token',
      null,
      {},
      responseStream,
      null,
      'account-1',
      'claude-official',
      'session-hash',
      null,
      { bodyStoreId, isRealClaudeCodeRequest: true }
    )

    expect(request).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([1000, 2000, 4000])
    expect(responseStream.status).toHaveBeenCalledWith(529)
    expect(responseHeaders['retry-after']).toBe('600')
    expect(responseHeaders['x-relay-retry-count']).toBe('3')

    const body = JSON.parse(responseChunks.join(''))
    expect(body.error.message).toContain('中转已自动重试 3 次')
    expect(body.error.message).toContain('10 分钟后再试')
    expect(body.retry_after_seconds).toBe(600)
    expect(claudeRelayService.bodyStore.has(bodyStoreId)).toBe(false)
  })
})
