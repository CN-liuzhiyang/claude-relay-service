jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../config/config', () => ({
  proxy: { required: true, allowedEndpoints: ['socks5://127.0.0.1:23001'], directLoopbackPorts: [] }
}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('axios', () => jest.fn())

const axios = require('axios')
const ProxyHelper = require('../src/utils/proxyHelper')
const config = require('../config/config')

describe('direct loopback upstream policy', () => {
  afterEach(() => {
    config.proxy.required = true
    config.proxy.directLoopbackPorts = []
    jest.clearAllMocks()
  })

  test('allows literal loopback URLs only on server-enabled ports', () => {
    config.proxy.directLoopbackPorts = [23456]
    for (const url of [
      'http://127.0.0.1:23456',
      'http://127.0.0.1:23456/v1/messages',
      'https://127.0.0.2:23456',
      'http://[::1]:23456'
    ]) {
      expect(ProxyHelper.checkDirectLoopbackTarget(url)).toEqual({ allowed: true, port: 23456 })
      expect(() => ProxyHelper.assertDirectLoopbackTarget(url)).not.toThrow()
    }
  })

  test.each([
    ['http://192.0.2.10:23456', 'not_loopback'],
    ['https://upstream.example', 'not_loopback'],
    ['http://localhost:23456', 'not_loopback'],
    ['http://127.0.0.1.upstream.example:23456', 'not_loopback'],
    ['http://user:secret@127.0.0.1:23456', 'invalid_url'],
    ['ftp://127.0.0.1:23456', 'invalid_url'],
    ['not a url', 'invalid_url'],
    ['http://127.0.0.1:23457', 'port_not_enabled'],
    ['http://127.0.0.1', 'port_not_enabled']
  ])('rejects %s (%s) and fails closed', (url, reason) => {
    config.proxy.directLoopbackPorts = [23456]
    expect(ProxyHelper.checkDirectLoopbackTarget(url).allowed).toBe(false)
    expect(ProxyHelper.checkDirectLoopbackTarget(url).reason).toBe(reason)
    try {
      ProxyHelper.assertDirectLoopbackTarget(url)
      throw new Error('expected rejection')
    } catch (error) {
      expect(error.code).toBe('PROXY_POLICY_REJECTED')
      expect(error.statusCode).toBe(503)
      expect(error.message).not.toContain('secret')
    }
  })

  test('required proxy mode with an empty port list rejects every direct target', () => {
    expect(ProxyHelper.checkDirectLoopbackTarget('http://127.0.0.1:23456')).toMatchObject({
      allowed: false,
      reason: 'port_not_enabled'
    })
  })

  test('non-required deployments allow any loopback port when no list is set', () => {
    config.proxy.required = false
    expect(ProxyHelper.checkDirectLoopbackTarget('http://127.0.0.1:23456').allowed).toBe(true)
    expect(ProxyHelper.checkDirectLoopbackTarget('http://192.0.2.10:23456').allowed).toBe(false)
  })

  test('exposes the read-only policy without leaking mutable config', () => {
    config.proxy.directLoopbackPorts = [23456]
    const policy = ProxyHelper.getDirectLoopbackPolicy()
    expect(policy).toEqual({ proxyRequired: true, allowedPorts: [23456] })
    policy.allowedPorts.push(1)
    expect(config.proxy.directLoopbackPorts).toEqual([23456])
  })
})

describe('Claude Console account agent selection', () => {
  // 服务构造时会注册缓存清理定时器，测试中改为 unref 避免 Jest 挂起
  const realSetInterval = global.setInterval
  global.setInterval = (...args) => realSetInterval(...args).unref()
  const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')
  global.setInterval = realSetInterval

  afterEach(() => {
    config.proxy.directLoopbackPorts = []
  })

  test('direct loopback account returns no agent only after the policy check', () => {
    config.proxy.directLoopbackPorts = [23456]
    const account = { apiUrl: 'http://127.0.0.1:23456', directLoopback: true }
    expect(claudeConsoleAccountService._createProxyAgent(null, account)).toBeNull()
    expect(claudeConsoleAccountService.isDirectLoopback({ directLoopback: 'true' })).toBe(true)
  })

  test('direct flag cannot reach a remote upstream or a port the server did not enable', () => {
    config.proxy.directLoopbackPorts = [23456]
    for (const apiUrl of ['https://upstream.example', 'http://127.0.0.1:23457']) {
      expect(() =>
        claudeConsoleAccountService._createProxyAgent(null, { apiUrl, directLoopback: true })
      ).toThrow(expect.objectContaining({ code: 'PROXY_POLICY_REJECTED' }))
    }
  })

  test('accounts without the direct flag still require a proxy', () => {
    config.proxy.directLoopbackPorts = [23456]
    const account = { apiUrl: 'http://127.0.0.1:23456', directLoopback: false }
    expect(() => claudeConsoleAccountService._createProxyAgent(null, account)).toThrow(
      'Proxy configuration is required'
    )
    expect(() => claudeConsoleAccountService._createProxyAgent(null, null)).toThrow(
      'Proxy configuration is required'
    )
  })
})

describe('direct stream test request', () => {
  const { sendStreamTestRequest } = require('../src/utils/testPayloadHelper')
  const { Readable } = require('stream')

  const responseStream = () => ({
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    chunks: [],
    writeHead: jest.fn(function writeHead() {
      this.headersSent = true
    }),
    write: jest.fn(function write(chunk) {
      this.chunks.push(chunk)
    }),
    end: jest.fn(function end() {
      this.writableEnded = true
    })
  })

  test('ignores environment proxies and does not follow redirects', async () => {
    axios.mockResolvedValue({ status: 200, data: Readable.from([]) })
    await sendStreamTestRequest({
      apiUrl: 'http://127.0.0.1:23456/v1/messages',
      responseStream: responseStream(),
      direct: true
    })
    const [requestConfig] = axios.mock.calls[0]
    expect(requestConfig.proxy).toBe(false)
    expect(requestConfig.maxRedirects).toBe(0)
    expect(requestConfig.httpAgent).toBeUndefined()
  })
})
