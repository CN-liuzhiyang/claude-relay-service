const express = require('express')
const usageSnapshotService = require('../services/usageSnapshotService')

const router = express.Router()

router.get('/api/usage-snapshot', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.set('Vary', 'x-api-key, Authorization')
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '')
  const apiKey = req.get('x-api-key') || bearer?.[1]

  try {
    const result = await usageSnapshotService.getSnapshot(apiKey)
    return res.status(result.status).json(result.body)
  } catch {
    // Never serialize dependency errors: they can contain credentials or account identifiers.
    res.set('Retry-After', '30')
    return res.status(503).json({ error: 'snapshot_unavailable' })
  }
})

module.exports = router
