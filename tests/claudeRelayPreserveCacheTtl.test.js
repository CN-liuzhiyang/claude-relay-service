jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  api: jest.fn()
}))

jest.mock('../config/config', () => ({
  claude: { preserveCacheTtl: false }
}))

jest.mock('../src/models/redis', () => ({}))

// 这些依赖在 require 阶段会建连接/起定时器，测试只关心请求体处理，全部置空
jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('../src/utils/sessionHelper', () => ({}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))
jest.mock('../src/utils/testPayloadHelper', () => ({ createClaudeTestPayload: jest.fn() }))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({}))
jest.mock('../src/services/claudeCodeHeadersService', () => ({}))
jest.mock('../src/services/requestIdentityService', () => ({}))
jest.mock('../src/services/userMessageQueueService', () => ({}))

const config = require('../config/config')
const claudeRelayService = require('../src/services/relay/claudeRelayService')

const buildBody = () => ({
  model: 'claude-opus-5',
  max_tokens: 64,
  system: [
    { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
    { type: 'text', text: 'project context', cache_control: { type: 'ephemeral', ttl: '1h' } }
  ],
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }]
    }
  ]
})

describe('claudeRelayService._processRequestBody cache_control ttl', () => {
  afterEach(() => {
    config.claude.preserveCacheTtl = false
  })

  it('strips ttl from system and messages by default', () => {
    const body = buildBody()
    const processed = claudeRelayService._processRequestBody(body, null, true)

    expect(processed.system[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(processed.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' })
    // 不修改调用方原始请求体
    expect(body.system[1].cache_control.ttl).toBe('1h')
  })

  it('keeps ttl in system and messages when preserveCacheTtl is enabled', () => {
    config.claude.preserveCacheTtl = true
    const processed = claudeRelayService._processRequestBody(buildBody(), null, true)

    expect(processed.system[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(processed.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h'
    })
  })
})
