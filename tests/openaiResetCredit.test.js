const mockAccount = {
  id: 'account-1',
  name: 'Codex Test Account',
  accessToken: 'access-token',
  expiresAt: '2099-01-01T00:00:00.000Z',
  isActive: 'true',
  status: 'active',
  rateLimitStatus: 'limited',
  rateLimitedAt: '2026-07-31T00:00:00.000Z',
  rateLimitResetAt: '2026-08-07T00:00:00.000Z',
  schedulable: 'false'
}

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn()
}))

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'redeem-request-id')
}))

jest.mock('../src/models/redis', () => {
  const mockClient = {
    hgetall: jest.fn(async () => ({ ...mockAccount })),
    hset: jest.fn(async (_key, updates) => Object.assign(mockAccount, updates))
  }

  return {
    getClientSafe: jest.fn(() => mockClient),
    __mockClient: mockClient
  }
})

jest.mock('../src/utils/commonHelper', () => ({
  createEncryptor: jest.fn(() => ({
    encrypt: (value) => value,
    decrypt: (value) => value,
    clearCache: jest.fn(),
    getStats: jest.fn(() => ({}))
  }))
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null)
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  clearTempUnavailable: jest.fn(),
  recordErrorHistory: jest.fn()
}))

jest.mock('../src/services/tokenRefreshService', () => ({}))
jest.mock('../src/utils/tokenRefreshLogger', () => ({}))
jest.mock('../src/utils/testPayloadHelper', () => ({
  createOpenAITestPayload: jest.fn(),
  extractErrorMessage: jest.fn()
}))

jest.useFakeTimers()

const axios = require('axios')
const redis = require('../src/models/redis')
const openaiAccountService = require('../src/services/account/openaiAccountService')

describe('consumeResetCredit', () => {
  beforeEach(() => {
    Object.assign(mockAccount, {
      id: 'account-1',
      name: 'Codex Test Account',
      accessToken: 'access-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      isActive: 'true',
      status: 'active',
      rateLimitStatus: 'limited',
      rateLimitedAt: '2026-07-31T00:00:00.000Z',
      rateLimitResetAt: '2026-08-07T00:00:00.000Z',
      schedulable: 'false'
    })
    jest.clearAllMocks()
  })

  afterAll(() => {
    openaiAccountService.stopCodexUsageRefresh()
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('refreshes usage and restores scheduling after a reset card is consumed', async () => {
    axios.post.mockResolvedValue({ status: 200, data: { redeemed: true } })
    axios.get
      .mockResolvedValueOnce({
        status: 200,
        data: {
          rate_limit: {
            primary_window: {
              used_percent: 0,
              reset_after_seconds: 604800,
              limit_window_seconds: 604800
            },
            secondary_window: null
          },
          credits: { has_credits: false, unlimited: false, balance: 0 },
          rate_limit_reset_credits: { available_count: 0, applicable_available_count: 0 }
        }
      })
      .mockResolvedValueOnce({ status: 200, data: { credits: [] } })

    const result = await openaiAccountService.consumeResetCredit('account-1', 'credit-1')

    expect(axios.post).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
      { redeem_request_id: 'redeem-request-id', credit_id: 'credit-1' },
      expect.any(Object)
    )
    expect(result.codexUsage.primary.usedPercent).toBe(0)
    expect(result.rateLimitCleared).toBe(true)
    expect(mockAccount.rateLimitStatus).toBe('normal')
    expect(mockAccount.rateLimitedAt).toBeNull()
    expect(mockAccount.rateLimitResetAt).toBeNull()
    expect(mockAccount.schedulable).toBe('true')
    expect(redis.__mockClient.hset).toHaveBeenCalledWith(
      'openai:account:account-1',
      expect.objectContaining({ rateLimitStatus: 'normal', schedulable: 'true' })
    )
  })
})
