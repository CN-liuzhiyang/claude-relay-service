jest.mock('../src/services/account/openaiAccountService', () => ({
  setAccountRateLimited: jest.fn(),
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  markAccountRateLimited: jest.fn(),
  updateAccount: jest.fn()
}))

jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}))
jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: jest.fn((value) => value !== false && value !== 'false'),
  sortAccountsByPriority: jest.fn((accounts) => accounts)
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({ isTempUnavailable: jest.fn() }))

const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

describe('UnifiedOpenAIScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test.each(['openai', 'openai-responses'])(
    'a temporarily unavailable dedicated %s account cannot use the shared pool',
    async (accountType) => {
      const account = { id: 'fixture-account', name: 'fixture', isActive: true, status: 'active' }
      openaiAccountService.getAccount.mockResolvedValue(account)
      openaiResponsesAccountService.getAccount.mockResolvedValue(account)
      upstreamErrorHelper.isTempUnavailable.mockResolvedValue(true)
      const pool = jest.spyOn(unifiedOpenAIScheduler, '_getAllAvailableAccounts')
      try {
        await expect(
          unifiedOpenAIScheduler.selectAccountForApiKey({
            openaiAccountId:
              accountType === 'openai' ? 'fixture-account' : 'responses:fixture-account'
          })
        ).rejects.toMatchObject({ code: 'OPENAI_DEDICATED_UNAVAILABLE', statusCode: 503 })
        expect(pool).not.toHaveBeenCalled()
      } finally {
        pool.mockRestore()
      }
    }
  )

  describe('markAccountRateLimited', () => {
    it('does not disable scheduling again when OpenAI-Responses auto protection is disabled', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'true'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.markAccountRateLimited).toHaveBeenCalledWith(
        'account-1',
        2
      )
      expect(openaiResponsesAccountService.updateAccount).not.toHaveBeenCalled()
    })

    it('keeps disabling scheduling for protected OpenAI-Responses accounts', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'false'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.updateAccount).toHaveBeenCalledWith(
        'account-1',
        expect.objectContaining({
          schedulable: 'false'
        })
      )
    })
  })
})
