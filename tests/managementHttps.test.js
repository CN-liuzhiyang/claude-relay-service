const { createManagementHttpsGuard } = require('../src/middleware/managementHttps')

describe('management HTTPS policy with legacy HTTP inference', () => {
  const guard = createManagementHttpsGuard({ enabled: true, publicUrl: 'https://192.0.2.1' })
  const invoke = (path, method = 'GET', peer = '198.51.100.2', headers = {}) => {
    const req = { path, method, socket: { remoteAddress: peer }, headers }
    const res = { setHeader: jest.fn(), redirect: jest.fn(), status: jest.fn(), json: jest.fn() }
    res.status.mockReturnValue(res)
    const next = jest.fn()
    guard(req, res, next)
    return { req, res, next }
  }

  test.each(['/admin-next/', '/admin-next/login', '/ADMIN-NEXT/accounts', '/'])(
    'redirects only management pages to the fixed trusted origin: %s',
    (route) => {
      const { res, next } = invoke(route, 'GET', '198.51.100.2', { host: 'evil.invalid' })
      expect(next).not.toHaveBeenCalled()
      expect(res.redirect).toHaveBeenCalledWith(
        302,
        `https://192.0.2.1${route === '/' ? '/admin-next/login' : route}`
      )
    }
  )

  test.each([
    '/web/auth/login',
    '/web/auth/change-password',
    '/admin/claude-accounts',
    '/admin/webhook/config',
    '/users/login',
    '/apiStats/api/get-key-id',
    '/metrics'
  ])('rejects management APIs before authentication/body handling: %s', (route) => {
    const { res, next } = invoke(route, 'POST', '198.51.100.2', {
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '127.0.0.1',
      forwarded: 'proto=https'
    })
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.redirect).not.toHaveBeenCalled()
  })

  test.each([
    '/api/v1/messages',
    '/claude/v1/messages',
    '/openai/v1/responses',
    '/gemini/v1/models',
    '/antigravity/api/v1/messages',
    '/droid/v1/messages',
    '/health'
  ])('preserves old model/API routes over HTTP: %s', (route) => {
    expect(invoke(route, 'POST').next).toHaveBeenCalledTimes(1)
  })

  test.each(['127.0.0.1', '::ffff:127.0.0.1', '::1'])(
    'accepts HTTPS forwarded only by a loopback peer: %s',
    (peer) => {
      expect(
        invoke('/web/auth/login', 'POST', peer, { 'x-forwarded-proto': 'https' }).next
      ).toHaveBeenCalledTimes(1)
      expect(
        invoke('/web/auth/login', 'POST', peer, { 'x-forwarded-proto': 'https,http' }).res.status
      ).toHaveBeenCalledWith(403)
    }
  )

  test('invalid enabled configuration fails startup rather than opening management', () => {
    expect(() => createManagementHttpsGuard({ enabled: true, publicUrl: '' })).toThrow()
    expect(() =>
      createManagementHttpsGuard({ enabled: true, publicUrl: 'http://192.0.2.1' })
    ).toThrow()
  })
})
