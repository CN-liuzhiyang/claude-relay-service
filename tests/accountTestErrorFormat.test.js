const { EventEmitter } = require('events')
const { Readable } = require('stream')
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
  getAccount: jest.fn(async () => ({ id: 'account-1', name: 'synthetic' })),
  getValidAccessToken: jest.fn(async () => 'synthetic-access-token'),
  clearExpiredOpusRateLimit: jest.fn(async () => {}),
  isAccountOpusRateLimited: jest.fn(async () => false),
  isAccountOverloaded: jest.fn(async () => false),
  clearInternalErrors: jest.fn(async () => {}),
  markAccountOverloaded: jest.fn(async () => {})
}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  isAccountRateLimited: jest.fn(async () => false),
  clearSessionMapping: jest.fn(async () => {}),
  markAccountBlocked: jest.fn(async () => {})
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
jest.mock('axios', () => jest.fn())

const axios = require('axios')
const {
  formatUpstreamError,
  sendStreamTestRequest,
  createClaudeTestPayload
} = require('../src/utils/testPayloadHelper')
const claudeRelayService = require('../src/services/relay/claudeRelayService')

const notFoundBody = {
  type: 'error',
  error: { type: 'not_found_error', message: 'model: claude-retired-model' }
}

const sseResponse = () => ({
  headersSent: false,
  destroyed: false,
  writableEnded: false,
  socket: { destroyed: false },
  chunks: [],
  getHeader: jest.fn(() => null),
  writeHead: jest.fn(function writeHead() {
    this.headersSent = true
  }),
  write: jest.fn(function write(chunk) {
    this.chunks.push(chunk)
  }),
  end: jest.fn(function end() {
    this.writableEnded = true
  }),
  on: jest.fn(),
  once: jest.fn()
})

const events = (stream) =>
  stream.chunks
    .join('')
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))

describe('upstream test error formatting', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    axios.mockReset()
  })

  test.each([
    [404, notFoundBody, '', 'HTTP 404 not_found_error: model: claude-retired-model'],
    [
      400,
      { error: { type: 'invalid_request_error', code: 'model_not_found', message: 'bad' } },
      '',
      'HTTP 400 invalid_request_error: bad'
    ],
    [
      404,
      { error: { code: 404, status: 'NOT_FOUND', message: 'gone' } },
      '',
      'HTTP 404 NOT_FOUND: gone'
    ],
    [502, null, 'Bad Gateway', 'HTTP 502: Bad Gateway'],
    [503, null, '', 'HTTP 503']
  ])('formats status %s with type and message', (status, body, fallback, expected) => {
    expect(formatUpstreamError(status, body, fallback).message).toBe(expected)
  })

  it('test payload no longer pins a legacy model or sampling parameters', () => {
    const payload = createClaudeTestPayload(undefined, { stream: true })
    expect(payload.model).not.toBe('claude-sonnet-4-5-20250929')
    expect(payload).not.toHaveProperty('temperature')
  })

  it('stream test helper reports HTTP status and error type for a 404', async () => {
    axios.mockResolvedValue({
      status: 404,
      data: Readable.from([Buffer.from(JSON.stringify(notFoundBody))])
    })
    const stream = sseResponse()
    await sendStreamTestRequest({
      apiUrl: 'https://upstream.example/v1/messages',
      responseStream: stream
    })

    const complete = events(stream).find((event) => event.type === 'test_complete')
    expect(complete).toEqual({
      type: 'test_complete',
      success: false,
      error: 'HTTP 404 not_found_error: model: claude-retired-model'
    })
  })

  it('OAuth account test sends the chosen model and surfaces 404 status and type', async () => {
    jest.spyOn(claudeRelayService, '_prepareAccountForTest').mockResolvedValue({
      account: { id: 'account-1', name: 'synthetic' },
      accessToken: 'synthetic-access-token',
      proxyAgent: null
    })
    const prepare = jest
      .spyOn(claudeRelayService, '_prepareRequestHeadersAndPayload')
      .mockImplementation(async (body) => ({
        bodyString: JSON.stringify(body),
        headers: {},
        toolNameMap: new Map()
      }))
    jest.spyOn(https, 'request').mockImplementation((_options, callback) => {
      const req = new EventEmitter()
      req.destroyed = false
      req.write = jest.fn()
      req.destroy = jest.fn()
      req.setTimeout = jest.fn()
      req.end = jest.fn(() => {
        const res = new EventEmitter()
        res.statusCode = 404
        res.headers = {}
        res.resume = jest.fn()
        callback(res)
        setImmediate(() => {
          res.emit('data', Buffer.from(JSON.stringify(notFoundBody)))
          res.emit('end')
        })
      })
      return req
    })

    const stream = sseResponse()
    await expect(
      claudeRelayService.testAccountConnection('account-1', stream, 'claude-retired-model')
    ).rejects.toThrow('Claude API error: 404')

    expect(prepare.mock.calls[0][0].model).toBe('claude-retired-model')
    const error = events(stream).find((event) => event.type === 'error')
    expect(error).toEqual({
      type: 'error',
      error: 'HTTP 404 not_found_error: model: claude-retired-model',
      status: 404,
      errorType: 'not_found_error'
    })
  })
})
