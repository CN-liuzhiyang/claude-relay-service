jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../config/config', () => ({
  proxy: {
    required: true,
    allowedEndpoints: ['socks5://127.0.0.1:23001'],
    directLoopbackPorts: []
  },
  security: { encryptionSalt: 'test-salt' }
}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('axios', () => jest.fn())

const axios = require('axios')
const config = require('../config/config')

// 服务构造时会注册缓存清理定时器，测试中改为 unref 避免 Jest 挂起
const realSetInterval = global.setInterval
global.setInterval = (...args) => realSetInterval(...args).unref()
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const BaseBalanceProvider = require('../src/services/balanceProviders/baseBalanceProvider')
global.setInterval = realSetInterval

const proxy = { type: 'socks5', host: '127.0.0.1', port: 23001 }

describe('OpenAI-Responses account agent selection', () => {
  afterEach(() => {
    config.proxy.directLoopbackPorts = []
    jest.clearAllMocks()
  })

  test('direct loopback account returns no agent only after the policy check', () => {
    config.proxy.directLoopbackPorts = [23456]
    const account = { baseApi: 'http://127.0.0.1:23456/v1', directLoopback: true }
    expect(openaiResponsesAccountService._createProxyAgent(null, account)).toBeNull()
    expect(openaiResponsesAccountService.isDirectLoopback({ directLoopback: 'true' })).toBe(true)
    expect(openaiResponsesAccountService.isDirectLoopback({ directLoopback: false })).toBe(false)
  })

  test('direct flag cannot reach a remote upstream or a port the server did not enable', () => {
    config.proxy.directLoopbackPorts = [23456]
    for (const baseApi of ['https://api.openai.com/v1', 'http://127.0.0.1:23457']) {
      expect(() =>
        openaiResponsesAccountService._createProxyAgent(null, { baseApi, directLoopback: true })
      ).toThrow(expect.objectContaining({ code: 'PROXY_POLICY_REJECTED' }))
    }
  })

  test('accounts without the direct flag still require an allowed proxy', () => {
    config.proxy.directLoopbackPorts = [23456]
    const account = { baseApi: 'http://127.0.0.1:23456/v1', directLoopback: false }
    expect(() => openaiResponsesAccountService._createProxyAgent(null, account)).toThrow(
      'Proxy configuration is required'
    )
    expect(() => openaiResponsesAccountService._createProxyAgent(null, null)).toThrow(
      'Proxy configuration is required'
    )
    expect(() =>
      openaiResponsesAccountService._createProxyAgent({ ...proxy, port: 23999 }, account)
    ).toThrow('Proxy endpoint is outside the allowed list')
    expect(openaiResponsesAccountService._createProxyAgent(proxy, account)).toBeTruthy()
  })
})

describe('balance provider direct request', () => {
  class Provider extends BaseBalanceProvider {}

  afterEach(() => {
    config.proxy.directLoopbackPorts = []
    jest.clearAllMocks()
  })

  test('ignores environment proxies and does not follow redirects', async () => {
    config.proxy.directLoopbackPorts = [23456]
    axios.mockResolvedValue({ status: 200, data: {}, headers: {} })
    const result = await new Provider('openai-responses').makeRequest(
      'http://127.0.0.1:23456/v1/usage',
      {},
      { directLoopback: true }
    )
    expect(result.success).toBe(true)
    const [requestConfig] = axios.mock.calls[0]
    expect(requestConfig.proxy).toBe(false)
    expect(requestConfig.maxRedirects).toBe(0)
    expect(requestConfig.httpAgent).toBeUndefined()
  })

  test('refuses a direct request to a non-loopback address without sending it', async () => {
    config.proxy.directLoopbackPorts = [23456]
    const result = await new Provider('openai-responses').makeRequest(
      'https://api.openai.com/v1/usage',
      {},
      { directLoopback: true }
    )
    expect(result.success).toBe(false)
    expect(axios).not.toHaveBeenCalled()
  })
})
