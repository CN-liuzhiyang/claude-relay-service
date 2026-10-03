jest.mock('../src/utils/logger', () => ({ warn: jest.fn(), debug: jest.fn() }))
jest.mock('../config/config', () => ({ proxy: { required: true, allowedEndpoints: [] } }))

const ProxyHelper = require('../src/utils/proxyHelper')
const config = require('../config/config')

describe('required proxy policy', () => {
  afterEach(() => {
    for (const agent of ProxyHelper._agentCache.values()) {
      agent.destroy()
    }
    ProxyHelper._agentCache.clear()
    config.proxy.allowedEndpoints = []
    jest.restoreAllMocks()
  })

  test.each([
    null,
    undefined,
    '',
    '{bad json',
    {},
    'null',
    [],
    { type: 'socks5', host: '127.0.0.1' },
    { type: 'unsupported', host: '127.0.0.1', port: 17894 },
    { type: 'http', host: '127.0.0.1', port: '17894junk' },
    { type: 'http', host: '127.0.0.1', port: true },
    { type: 'http', host: '127.0.0.1', port: '0x44' },
    { type: 'http', host: '127.0.0.1', port: 0 },
    { type: 'http', host: '127.0.0.1', port: 65536 },
    { type: 'http', host: 'user:password@host', port: 17894 },
    { type: 'http', host: '127.0.0.1', port: 17894, username: 'only-user' }
  ])('refuses invalid or absent configuration: %p', (value) => {
    expect(() => ProxyHelper.createProxyAgent(value)).toThrow()
    try {
      ProxyHelper.createProxyAgent(value)
    } catch (error) {
      expect(error.code).toBe('PROXY_POLICY_REJECTED')
      expect(error.statusCode).toBe(503)
    }
  })

  test('allows only the dedicated endpoint and caches successful agents', () => {
    config.proxy.allowedEndpoints = ['socks5://127.0.0.1:17894']
    const proxy = { type: 'socks5', host: '127.0.0.1', port: 17894 }
    expect(ProxyHelper.createProxyAgent(proxy)).toBe(ProxyHelper.createProxyAgent(proxy))
    expect(ProxyHelper.createProxyAgent(proxy).shouldLookup).toBe(false)
    expect(() => ProxyHelper.createProxyAgent({ ...proxy, port: 7890 })).toThrow('allowed list')
  })

  test('constructor failure cannot become a direct agent', () => {
    jest.resetModules()
    jest.doMock('socks-proxy-agent', () => ({
      SocksProxyAgent: jest.fn(() => {
        throw new Error('password=synthetic-private')
      })
    }))
    const helper = require('../src/utils/proxyHelper')
    expect(() =>
      helper.createProxyAgent({ type: 'socks5', host: '127.0.0.1', port: 17894 })
    ).toThrow('Unable to create required proxy agent')
    jest.dontMock('socks-proxy-agent')
  })
})
