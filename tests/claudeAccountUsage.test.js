const mockStore = new Map()

jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn(async (id) => mockStore.get(id) || {}),
  setClaudeAccount: jest.fn(async (id, data) => {
    mockStore.set(id, { ...data })
  }),
  client: { hdel: jest.fn(async () => 1) }
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

jest.mock('../src/services/tokenRefreshService', () => ({}))
jest.mock('../src/utils/tokenRefreshLogger', () => ({}))
jest.mock('../src/utils/webhookNotifier', () => ({ sendAccountAnomalyNotification: jest.fn() }))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  recordErrorHistory: jest.fn(() => ({ catch: jest.fn() })),
  markTempUnavailable: jest.fn(() => ({ catch: jest.fn() })),
  parseRetryAfter: jest.fn(() => null)
}))
jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('axios', () => ({}))

const _realSetInterval = global.setInterval
global.setInterval = (fn, ms, ...args) => {
  const timer = _realSetInterval(fn, ms, ...args)
  if (timer && typeof timer.unref === 'function') timer.unref()
  return timer
}
const claudeAccountService = require('../src/services/account/claudeAccountService')
global.setInterval = _realSetInterval

const ACCOUNT_ID = 'acct-usage-test'
const resetAt = (hours) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()

describe('Claude OAuth usage windows', () => {
  beforeEach(() => {
    mockStore.clear()
    mockStore.set(ACCOUNT_ID, { id: ACCOUNT_ID, name: 'Max account' })
  })

  it('stores and returns the dynamic limits array, including Fable', async () => {
    await claudeAccountService.updateClaudeUsageSnapshot(ACCOUNT_ID, {
      five_hour: { utilization: 3, resets_at: resetAt(3) },
      seven_day: { utilization: 8, resets_at: resetAt(120) },
      seven_day_sonnet: null,
      seven_day_opus: null,
      limits: [
        {
          kind: 'session',
          group: 'session',
          percent: 3,
          severity: 'normal',
          resets_at: resetAt(3),
          scope: null,
          is_active: true
        },
        {
          kind: 'weekly_all',
          group: 'weekly',
          percent: 8,
          severity: 'normal',
          resets_at: resetAt(120),
          scope: null,
          is_active: false
        },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 16,
          severity: 'normal',
          resets_at: resetAt(120),
          scope: { model: { id: null, display_name: 'Fable' }, surface: null },
          is_active: false
        }
      ]
    })

    const stored = mockStore.get(ACCOUNT_ID)
    const cachedWindows = JSON.parse(stored.claudeUsageWindows)
    expect(cachedWindows).toHaveLength(3)
    expect(cachedWindows[2]).toMatchObject({
      kind: 'weekly_scoped',
      utilization: 16,
      scope: { model: 'Fable', surface: null }
    })

    const snapshot = claudeAccountService.buildClaudeUsageSnapshot(stored)
    expect(snapshot.windows).toHaveLength(3)
    expect(snapshot.windows[0].remainingSeconds).toBeGreaterThan(0)
    expect(snapshot.windows[2].scope.model).toBe('Fable')
    expect(snapshot.sevenDaySonnet).toBeNull()
    expect(snapshot.sevenDayOpus).toBeNull()
  })

  it('does not create empty Sonnet or Opus rows when the upstream fields are null', () => {
    const windows = claudeAccountService._normalizeClaudeUsageWindows({
      five_hour: { utilization: 0, resets_at: resetAt(5) },
      seven_day: { utilization: 0, resets_at: resetAt(140) },
      seven_day_sonnet: null,
      seven_day_opus: null
    })

    expect(windows.map((window) => window.kind)).toEqual(['session', 'weekly_all'])
  })

  it('keeps legacy Redis snapshots readable and identifies the old field as Sonnet', () => {
    const snapshot = claudeAccountService.buildClaudeUsageSnapshot({
      id: ACCOUNT_ID,
      claudeUsageUpdatedAt: new Date().toISOString(),
      claudeFiveHourUtilization: '12',
      claudeFiveHourResetsAt: resetAt(2),
      claudeSevenDayUtilization: '34',
      claudeSevenDayResetsAt: resetAt(100),
      claudeSevenDayOpusUtilization: '56',
      claudeSevenDayOpusResetsAt: resetAt(100)
    })

    expect(snapshot.windows).toHaveLength(3)
    expect(snapshot.windows[2]).toMatchObject({
      kind: 'weekly_scoped',
      utilization: 56,
      scope: { model: 'Sonnet', surface: null }
    })
    expect(snapshot.sevenDayOpus).toBe(snapshot.sevenDaySonnet)
  })

  it('keeps future model-scoped limits without hard-coded model names', () => {
    const windows = claudeAccountService._normalizeClaudeUsageWindows({
      limits: [
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 22.5,
          resets_at: resetAt(90),
          scope: { model: { display_name: 'Future Model' } }
        }
      ]
    })

    expect(windows).toEqual([
      expect.objectContaining({
        kind: 'weekly_scoped',
        utilization: 22.5,
        scope: { model: 'Future Model', surface: null }
      })
    ])
  })
})
