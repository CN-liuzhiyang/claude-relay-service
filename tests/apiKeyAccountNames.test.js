const express = require('express')
const request = require('supertest')

jest.mock('../config/config', () => ({
  security: { apiKeyPrefix: 'cr_' },
  system: { timezoneOffset: 8 }
}))
jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (_req, _res, next) => next()
}))
jest.mock('../src/models/redis', () => ({
  getApiKey: jest.fn(),
  setApiKey: jest.fn(),
  getAllApiKeys: jest.fn(),
  getClientSafe: jest.fn(() => ({})),
  getUsageStats: jest.fn(async () => ({})),
  getCostStats: jest.fn(async () => ({})),
  getConcurrency: jest.fn(async () => 0),
  getDailyCost: jest.fn(async () => 0),
  getWeeklyOpusCost: jest.fn(async () => 0),
  getUsageRecords: jest.fn(async () => []),
  scanApiKeyIds: jest.fn(),
  batchGetApiKeys: jest.fn(),
  batchGetApiKeyStats: jest.fn(async () => new Map())
}))
jest.mock('../src/utils/logger', () => new Proxy({}, { get: () => jest.fn() }))
jest.mock('../src/services/serviceRatesService', () => ({}))
jest.mock('../src/services/requestDetailService', () => ({}))
jest.mock('../src/services/costRankService', () => ({ addKeyToIndexes: jest.fn() }))
jest.mock('../src/services/apiKeyIndexService', () => ({
  addToIndex: jest.fn(),
  updateIndex: jest.fn()
}))

const redis = require('../src/models/redis')
const apiKeyService = require('../src/services/apiKeyService')
const app = express()
app.use(express.json())
app.use('/admin', require('../src/routes/admin/apiKeys'))

describe('admin API key account-name settings', () => {
  let records
  beforeEach(() => {
    jest.clearAllMocks()
    records = new Map()
    redis.getApiKey.mockImplementation(async (id) => structuredClone(records.get(id)))
    redis.setApiKey.mockImplementation(async (id, record) =>
      records.set(id, structuredClone(record))
    )
    redis.getAllApiKeys.mockImplementation(async () => structuredClone([...records.values()]))
    redis.scanApiKeyIds.mockImplementation(async () => [...records.keys()])
    redis.batchGetApiKeys.mockImplementation(async () => structuredClone([...records.values()]))
  })

  test.each([undefined, false, true])(
    'creates, reads, edits and lists setting %s',
    async (value) => {
      const body = { name: 'Fixture key' }
      if (value !== undefined) {
        body.showAccountNames = value
      }
      const created = await request(app).post('/admin/api-keys').send(body)
      expect(created.status).toBe(200)
      const { id } = created.body.data
      expect(created.body.data.showAccountNames).toBe(value === true)
      expect(records.get(id).showAccountNames).toBe(String(value === true))
      expect((await apiKeyService.getApiKeyById(id)).showAccountNames).toBe(value === true)
      for (const nextValue of [true, false]) {
        const edited = await request(app)
          .put(`/admin/api-keys/${id}`)
          .send({ showAccountNames: nextValue })
        expect(edited.status).toBe(200)
        expect(records.get(id).showAccountNames).toBe(String(nextValue))
        expect((await apiKeyService.getApiKeyById(id)).showAccountNames).toBe(nextValue)
        expect((await apiKeyService.getAllApiKeys())[0].showAccountNames).toBe(nextValue)
        expect((await apiKeyService.getAllApiKeysFast())[0].showAccountNames).toBe(nextValue)
        expect((await apiKeyService.getUserApiKeys(''))[0].showAccountNames).toBe(nextValue)
      }
      await request(app).put(`/admin/api-keys/${id}`).send({ name: 'Renamed fixture' }).expect(200)
      expect(records.get(id).showAccountNames).toBe('false')
    }
  )

  test('reads legacy keys with no setting as disabled through every full read/list path', async () => {
    const created = await apiKeyService.generateApiKey({ name: 'Legacy fixture' })
    delete records.get(created.id).showAccountNames
    expect((await apiKeyService.getApiKeyById(created.id)).showAccountNames).toBe(false)
    expect((await apiKeyService.getAllApiKeys())[0].showAccountNames).toBe(false)
    expect((await apiKeyService.getAllApiKeysFast())[0].showAccountNames).toBe(false)
    expect((await apiKeyService.getUserApiKeys(''))[0].showAccountNames).toBe(false)
  })

  test.each([true, false])(
    'persists setting %s through batch create and batch edit',
    async (value) => {
      const created = await request(app)
        .post('/admin/api-keys/batch')
        .send({ baseName: 'Fixture batch', count: 2, showAccountNames: value })
      expect(created.status).toBe(200)
      const keyIds = created.body.data.map((key) => key.id)
      expect(keyIds).toHaveLength(2)
      expect(created.body.data.every((key) => key.showAccountNames === value)).toBe(true)
      const edited = await request(app)
        .put('/admin/api-keys/batch')
        .send({ keyIds, updates: { showAccountNames: !value } })
      expect(edited.status).toBe(200)
      expect(edited.body.data.successCount).toBe(2)
      for (const id of keyIds) {
        expect((await apiKeyService.getApiKeyById(id)).showAccountNames).toBe(!value)
      }
    }
  )

  test.each(['true', 'false', 1, null])(
    'rejects non-boolean setting %s in every admin write API',
    async (value) => {
      await request(app)
        .post('/admin/api-keys')
        .send({ name: 'Fixture', showAccountNames: value })
        .expect(400)
      await request(app)
        .post('/admin/api-keys/batch')
        .send({ baseName: 'Fixture', count: 2, showAccountNames: value })
        .expect(400)
      await request(app)
        .put('/admin/api-keys/fixture')
        .send({ showAccountNames: value })
        .expect(400)
      await request(app)
        .put('/admin/api-keys/batch')
        .send({ keyIds: ['fixture'], updates: { showAccountNames: value } })
        .expect(400)
      expect(redis.setApiKey).not.toHaveBeenCalled()
    }
  )
})
