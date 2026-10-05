// Regression test for 5h auto-stop recovery timing.
//
// Bug: the local session window was guessed by flooring the first request time to the
// hour, so an account auto-stopped on allowed_warning stayed unschedulable until that
// guessed window ended — hours after the real upstream 5h window had already reset.
//
// Fix: updateSessionWindowStatus accepts the anthropic-ratelimit-unified-5h-reset header
// and aligns sessionWindowStart/End to it; the recovery task keys off sessionWindowEnd.

const mockStore = new Map()

jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn(async (id) => mockStore.get(id) || {}),
  setClaudeAccount: jest.fn(async (id, data) => {
    mockStore.set(id, { ...data })
  }),
  client: {
    hdel: jest.fn(async () => 1)
  }
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

// Side-effectful deps the session-window methods never touch.
jest.mock('../src/services/tokenRefreshService', () => ({}))
jest.mock('../src/utils/tokenRefreshLogger', () => ({}))
jest.mock('../src/utils/webhookNotifier', () => ({
  sendAccountAnomalyNotification: jest.fn()
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  recordErrorHistory: jest.fn(() => ({ catch: jest.fn() })),
  markTempUnavailable: jest.fn(() => ({ catch: jest.fn() })),
  parseRetryAfter: jest.fn(() => null)
}))
jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('axios', () => ({}))

// The service constructor starts a cache-cleanup setInterval at load. Unref it so the
// timer never keeps the Jest process alive (avoids needing --forceExit for this file).
const _realSetInterval = global.setInterval
global.setInterval = (fn, ms, ...args) => {
  const timer = _realSetInterval(fn, ms, ...args)
  if (timer && typeof timer.unref === 'function') {
    timer.unref()
  }
  return timer
}
const claudeAccountService = require('../src/services/account/claudeAccountService')
global.setInterval = _realSetInterval

const ACCOUNT_ID = 'acct-5h-reset-test'
const HOUR = 60 * 60 * 1000

describe('updateSessionWindowStatus with upstream 5h reset', () => {
  beforeEach(() => {
    mockStore.clear()
    mockStore.set(ACCOUNT_ID, {
      name: 'test',
      autoStopOnWarning: 'true',
      schedulable: 'true',
      sessionWindowStart: new Date(Date.now() - HOUR).toISOString(),
      sessionWindowEnd: new Date(Date.now() + 4 * HOUR).toISOString()
    })
  })

  it('aligns the window to the upstream reset before auto-stopping', async () => {
    const resetSec = Math.floor((Date.now() + HOUR) / 1000)
    await claudeAccountService.updateSessionWindowStatus(
      ACCOUNT_ID,
      'allowed_warning',
      String(resetSec)
    )
    const account = mockStore.get(ACCOUNT_ID)
    expect(account.sessionWindowEnd).toBe(new Date(resetSec * 1000).toISOString())
    expect(account.sessionWindowStart).toBe(new Date(resetSec * 1000 - 5 * HOUR).toISOString())
    expect(account.schedulable).toBe('false')
    expect(account.fiveHourAutoStopped).toBe('true')
    expect(account.fiveHourWarningWindow).toBe(account.sessionWindowEnd)
  })

  it('keeps the existing window when the header is missing or implausible', async () => {
    const before = mockStore.get(ACCOUNT_ID).sessionWindowEnd
    for (const reset of [undefined, 'garbage', String(Math.floor(Date.now() / 1000) - 60)]) {
      await claudeAccountService.updateSessionWindowStatus(ACCOUNT_ID, 'allowed', reset)
      expect(mockStore.get(ACCOUNT_ID).sessionWindowEnd).toBe(before)
    }
    const tooFar = String(Math.floor((Date.now() + 6 * HOUR) / 1000))
    await claudeAccountService.updateSessionWindowStatus(ACCOUNT_ID, 'allowed', tooFar)
    expect(mockStore.get(ACCOUNT_ID).sessionWindowEnd).toBe(before)
  })
})
