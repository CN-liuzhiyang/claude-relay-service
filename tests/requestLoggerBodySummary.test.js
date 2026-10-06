// Regression test: request logging must not carry full request bodies.
//
// Bug: requestLogger passed req.body into log metadata. Claude Code request bodies can
// be several MB, and every log call redacts and serializes metadata synchronously
// (even debug lines that are later filtered), blocking the event loop for seconds and
// stalling concurrent streams.
//
// Fix: only a small summary (size, model, stream, message count) is logged.

const { EventEmitter } = require('events')

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  security: jest.fn(),
  api: jest.fn()
}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/services/userService', () => ({}))
jest.mock('../src/services/claudeRelayConfigService', () => ({}))
jest.mock('../src/validators/clientValidator', () => ({}))
jest.mock('../src/validators/clients/claudeCodeValidator', () => ({}))

const logger = require('../src/utils/logger')
const { requestLogger } = require('../src/middleware/auth')

const SECRET_TEXT = 'very long conversation content'

const run = (body, headers = {}) => {
  const res = new EventEmitter()
  res.statusCode = 200
  res.setHeader = jest.fn()
  res.get = jest.fn(() => undefined)
  res.json = jest.fn()
  const req = {
    method: 'POST',
    originalUrl: '/api/v1/messages?beta=true',
    body,
    ip: '127.0.0.1',
    get: (name) => headers[name.toLowerCase()]
  }
  requestLogger(req, res, () => {})
  res.emit('finish')
}

describe('requestLogger body summary', () => {
  beforeEach(() => jest.clearAllMocks())

  it('logs a summary instead of the request body', () => {
    run(
      {
        model: 'claude-opus-5-5',
        stream: true,
        messages: [
          { role: 'user', content: SECRET_TEXT },
          { role: 'assistant', content: 'x' }
        ]
      },
      { 'content-length': '123456' }
    )
    const debugMeta = logger.debug.mock.calls[0][1]
    const infoMeta = logger.info.mock.calls[0][1]
    for (const meta of [debugMeta.body, infoMeta.req]) {
      expect(meta).toEqual({
        bytes: 123456,
        model: 'claude-opus-5-5',
        stream: true,
        messages: 2
      })
    }
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(SECRET_TEXT)
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(SECRET_TEXT)
  })

  it('logs only top-level keys for non-model bodies', () => {
    run({ name: 'acct', proxy: { host: 'h' } })
    expect(logger.info.mock.calls[0][1].req).toEqual({ bytes: undefined, keys: ['name', 'proxy'] })
  })

  it('omits empty bodies', () => {
    run({})
    expect(logger.info.mock.calls[0][1].req).toBeUndefined()
  })
})
