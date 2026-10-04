const express = require('express')
const request = require('supertest')

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => next()
}))

jest.mock('../src/services/relay/claudeConsoleRelayService', () => ({
  testAccountConnection: jest.fn(async (accountId, res) =>
    res.status(200).json({ success: true, accountId })
  )
}))

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  createAccount: jest.fn(async (data) => ({ id: 'new-account', ...data })),
  getAccount: jest.fn(),
  updateAccount: jest.fn(async () => ({ success: true }))
}))
jest.mock('../config/config', () => ({
  proxy: { required: true, allowedEndpoints: [], directLoopbackPorts: [23456] }
}))
jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/utils/webhookNotifier', () => ({}))
jest.mock('../src/routes/admin/utils', () => ({
  formatAccountExpiry: jest.fn((account) => account),
  mapExpiryField: jest.fn((updates) => updates)
}))

const claudeConsoleRelayService = require('../src/services/relay/claudeConsoleRelayService')
const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')
const { CLAUDE_MODELS } = require('../config/models')
const claudeConsoleAccountsRouter = require('../src/routes/admin/claudeConsoleAccounts')

describe('POST /admin/claude-console-accounts/:accountId/test', () => {
  const buildApp = () => {
    const app = express()
    app.use(express.json())
    app.use('/admin', claudeConsoleAccountsRouter)
    return app
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('falls back to the configured default test model when model is missing', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/admin/claude-console-accounts/account-1/test')
      .send({ model: '  ' })

    expect(response.status).toBe(200)
    expect(claudeConsoleRelayService.testAccountConnection).toHaveBeenCalledWith(
      'account-1',
      expect.any(Object),
      CLAUDE_MODELS[0].value
    )
  })

  it('passes model through to relay service when provided', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/admin/claude-console-accounts/account-1/test')
      .send({ model: 'claude-sonnet-4-6' })

    expect(response.status).toBe(200)
    expect(claudeConsoleRelayService.testAccountConnection).toHaveBeenCalledTimes(1)
    expect(claudeConsoleRelayService.testAccountConnection).toHaveBeenCalledWith(
      'account-1',
      expect.any(Object),
      'claude-sonnet-4-6'
    )
  })
})

describe('Claude Console direct loopback configuration', () => {
  const buildApp = () => {
    const app = express()
    app.use(express.json())
    app.use('/admin', claudeConsoleAccountsRouter)
    return app
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('exposes the read-only direct loopback policy', async () => {
    const response = await request(buildApp()).get(
      '/admin/claude-console-accounts/direct-loopback-policy'
    )
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ proxyRequired: true, allowedPorts: [23456] })
  })

  it('rejects creating a direct account whose API URL is not loopback', async () => {
    const response = await request(buildApp()).post('/admin/claude-console-accounts').send({
      name: 'remote',
      apiUrl: 'https://upstream.example',
      apiKey: 'synthetic-key',
      directLoopback: true
    })
    expect(response.status).toBe(400)
    expect(claudeConsoleAccountService.createAccount).not.toHaveBeenCalled()
  })

  it('creates a direct loopback account with the normalized flag', async () => {
    const response = await request(buildApp()).post('/admin/claude-console-accounts').send({
      name: 'tunnel',
      apiUrl: 'http://127.0.0.1:23456',
      apiKey: 'synthetic-key',
      directLoopback: 'true'
    })
    expect(response.status).toBe(200)
    expect(claudeConsoleAccountService.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ directLoopback: true })
    )
  })

  it('blocks moving a direct account to a remote URL but allows enabling on loopback', async () => {
    claudeConsoleAccountService.getAccount.mockResolvedValue({
      id: 'account-1',
      apiUrl: 'http://127.0.0.1:23456',
      accountType: 'shared',
      directLoopback: true
    })
    const app = buildApp()

    const remote = await request(app)
      .put('/admin/claude-console-accounts/account-1')
      .send({ apiUrl: 'https://upstream.example' })
    expect(remote.status).toBe(400)
    expect(claudeConsoleAccountService.updateAccount).not.toHaveBeenCalled()

    const enable = await request(app)
      .put('/admin/claude-console-accounts/account-1')
      .send({ directLoopback: 'true' })
    expect(enable.status).toBe(200)
    expect(claudeConsoleAccountService.updateAccount).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({ directLoopback: true })
    )

    const disable = await request(app)
      .put('/admin/claude-console-accounts/account-1')
      .send({ directLoopback: false, apiUrl: 'https://upstream.example' })
    expect(disable.status).toBe(200)
  })
})
