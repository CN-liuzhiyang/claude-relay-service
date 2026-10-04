const express = require('express')
const request = require('supertest')

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => next()
}))
jest.mock('../src/services/relay/claudeRelayService', () => ({
  testAccountConnection: jest.fn(async (accountId, res) => res.status(200).json({ accountId })),
  testAccountConnectionSync: jest.fn(async () => ({ success: true }))
}))
jest.mock('../src/services/account/claudeAccountService', () => ({
  getAccount: jest.fn(async () => ({ id: 'account-1' }))
}))
jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/services/accountTestSchedulerService', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/models/redis', () => ({
  getAccountTestConfig: jest.fn(async () => null),
  saveAccountTestResult: jest.fn(async () => {}),
  setAccountLastTestTime: jest.fn(async () => {})
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/utils/oauthHelper', () => ({}))
jest.mock('../src/utils/costCalculator', () => ({}))
jest.mock('../src/utils/webhookNotifier', () => ({}))
jest.mock('../src/routes/admin/utils', () => ({
  formatAccountExpiry: jest.fn((account) => account),
  mapExpiryField: jest.fn((updates) => updates)
}))

const claudeRelayService = require('../src/services/relay/claudeRelayService')
const redis = require('../src/models/redis')
const { CLAUDE_MODELS } = require('../config/models')
const claudeAccountsRouter = require('../src/routes/admin/claudeAccounts')

const buildApp = () => {
  const app = express()
  app.use(express.json())
  app.use('/admin', claudeAccountsRouter)
  return app
}

describe('Claude OAuth account test model', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('passes the model selected in the UI through to the relay test', async () => {
    const response = await request(buildApp())
      .post('/admin/claude-accounts/account-1/test')
      .send({ model: ' claude-sonnet-5-5 ' })

    expect(response.status).toBe(200)
    expect(claudeRelayService.testAccountConnection).toHaveBeenCalledWith(
      'account-1',
      expect.any(Object),
      'claude-sonnet-5-5'
    )
  })

  it('keeps a custom model typed in the UI unchanged', async () => {
    await request(buildApp())
      .post('/admin/claude-accounts/account-1/test')
      .send({ model: 'claude-custom-preview' })

    expect(claudeRelayService.testAccountConnection.mock.calls[0][2]).toBe('claude-custom-preview')
  })

  it('uses the configured model list instead of a hardcoded legacy model', async () => {
    await request(buildApp()).post('/admin/claude-accounts/account-1/test').send({})

    const model = claudeRelayService.testAccountConnection.mock.calls[0][2]
    expect(model).toBe(CLAUDE_MODELS[0].value)
    expect(model).not.toBe('claude-sonnet-4-5-20250929')
  })

  it('sync test prefers the request model, then the scheduled test config', async () => {
    const app = buildApp()
    await request(app)
      .post('/admin/claude-accounts/account-1/test-sync')
      .send({ model: 'claude-haiku-4-5-20251001' })
    expect(claudeRelayService.testAccountConnectionSync).toHaveBeenLastCalledWith(
      'account-1',
      'claude-haiku-4-5-20251001'
    )

    redis.getAccountTestConfig.mockResolvedValueOnce({ model: 'claude-opus-4-8' })
    await request(app).post('/admin/claude-accounts/account-1/test-sync').send({})
    expect(claudeRelayService.testAccountConnectionSync).toHaveBeenLastCalledWith(
      'account-1',
      'claude-opus-4-8'
    )
  })

  it('returns the configured default for an unset scheduled test config', async () => {
    const response = await request(buildApp()).get('/admin/claude-accounts/account-1/test-config')
    expect(response.body.data.config.model).toBe(CLAUDE_MODELS[0].value)
  })
})
