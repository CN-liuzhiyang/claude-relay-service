jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: jest.fn(),
  _createProxyAgent: jest.fn(),
  isDirectLoopback: jest.fn((account) => account?.directLoopback === true)
}))

jest.mock('../config/config', () => ({}), {
  virtual: true
})
jest.mock('../src/models/redis', () => ({}))

jest.mock('../src/utils/testPayloadHelper', () => ({
  createClaudeTestPayload: jest.fn(),
  sendStreamTestRequest: jest.fn()
}))

const claudeConsoleRelayService = require('../src/services/relay/claudeConsoleRelayService')
const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')
const { createClaudeTestPayload, sendStreamTestRequest } = require('../src/utils/testPayloadHelper')

describe('claudeConsoleRelayService.testAccountConnection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('passes selected model stream payload and bearer auth for non sk-ant key', async () => {
    claudeConsoleAccountService.getAccount.mockResolvedValue({
      name: 'Console A1',
      apiUrl: 'https://console.example.com',
      apiKey: 'test-key',
      proxy: null,
      userAgent: null
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)

    const payload = {
      model: 'claude-sonnet-4-6',
      stream: true
    }
    createClaudeTestPayload.mockReturnValue(payload)
    sendStreamTestRequest.mockResolvedValue(undefined)

    const res = {}
    await claudeConsoleRelayService.testAccountConnection('a1', res, 'claude-sonnet-4-6')

    expect(createClaudeTestPayload).toHaveBeenCalledWith('claude-sonnet-4-6', { stream: true })
    expect(sendStreamTestRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload,
        authorization: 'Bearer test-key'
      })
    )
  })

  it('passes selected model stream payload and x-api-key for sk-ant key', async () => {
    claudeConsoleAccountService.getAccount.mockResolvedValue({
      name: 'Console A1',
      apiUrl: 'https://console.example.com',
      apiKey: 'sk-ant-test-key',
      proxy: null,
      userAgent: null
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)

    const payload = {
      model: 'claude-sonnet-4-6',
      stream: true
    }
    createClaudeTestPayload.mockReturnValue(payload)
    sendStreamTestRequest.mockResolvedValue(undefined)

    const res = {}
    await claudeConsoleRelayService.testAccountConnection('a1', res, 'claude-sonnet-4-6')

    expect(createClaudeTestPayload).toHaveBeenCalledWith('claude-sonnet-4-6', { stream: true })
    const requestOptions = sendStreamTestRequest.mock.calls[0][0]
    expect(requestOptions).toEqual(
      expect.objectContaining({
        payload,
        extraHeaders: expect.objectContaining({
          'x-api-key': 'sk-ant-test-key'
        })
      })
    )
    expect(requestOptions).not.toHaveProperty('authorization')
  })

  it('marks direct loopback accounts so the test request bypasses env proxies', async () => {
    const account = {
      name: 'Local tunnel',
      apiUrl: 'http://127.0.0.1:23456',
      apiKey: 'test-key',
      proxy: null,
      directLoopback: true
    }
    claudeConsoleAccountService.getAccount.mockResolvedValue(account)
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(null)
    createClaudeTestPayload.mockReturnValue({ model: 'claude-sonnet-5-5', stream: true })
    sendStreamTestRequest.mockResolvedValue(undefined)

    await claudeConsoleRelayService.testAccountConnection('a1', {}, 'claude-sonnet-5-5')

    expect(claudeConsoleAccountService._createProxyAgent).toHaveBeenCalledWith(null, account)
    expect(sendStreamTestRequest.mock.calls[0][0]).toEqual(
      expect.objectContaining({ proxyAgent: null, direct: true })
    )
  })
})
