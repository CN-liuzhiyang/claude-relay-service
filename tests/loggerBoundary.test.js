const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

test('actual main/auth/security/refresh file and console transports never emit credentials', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crs-log-boundary-'))
  const secret = 'synthetic-credential-only-123'
  try {
    const script = `
      const logger = require('./src/utils/logger')
      const refresh = require('./src/utils/tokenRefreshLogger')
      const secret = 'synthetic-credential-only-123'
      logger.info('request preview', { headers: { Authorization: 'Bearer ' + secret },
        nested: [{ password: secret, cookies: secret }], preview: JSON.stringify({ apiKey: secret }) })
      logger.error(new Error('upstream 401 refresh_token=' + secret))
      logger.security('test audit', { request: { refreshToken: secret, status: 401 } })
      logger.authDetail('exchange status', { access_token: secret, refresh_token: secret,
        scope: 'user:inference', expires_in: 3600, account: { password: secret } })
      refresh.logRefreshSuccess('synthetic-account', 'fixture', 'claude', { accessToken: secret })
      refresh.logRefreshError('synthetic-account', 'fixture', 'claude', {
        message: 'Authorization: Bearer ' + secret, response: { status: 401, data: { token: secret } } })
      setTimeout(() => process.exit(0), 300)
    `
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, NODE_ENV: 'test', LOG_DIR: directory, LOG_LEVEL: 'debug' }
    })
    expect(result.status).toBe(0)
    const files = fs.readdirSync(directory).filter((name) => name.endsWith('.log'))
    expect(files.length).toBeGreaterThanOrEqual(4)
    const output =
      result.stdout +
      result.stderr +
      files.map((name) => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n')
    expect(output).not.toContain(secret)
    expect(output).toContain('user:inference')
    expect(output).toContain('3600')
    expect(output).toContain('401')
    for (const name of files) {
      expect(fs.statSync(path.join(directory, name)).mode & 0o777).toBe(0o600)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
