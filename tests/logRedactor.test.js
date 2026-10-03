const { redact, redactString } = require('../src/utils/logRedactor')
const { maskToken } = require('../src/utils/tokenMask')

describe('logging credential boundary', () => {
  const secret = 'synthetic-credential-only'

  test.each([
    'access_token',
    'refreshToken',
    'Authorization',
    'X-API-Key',
    'apiKey',
    'password',
    'cookies',
    'client_secret',
    'sessionKey',
    'codeVerifier',
    'tokenPrefix'
  ])('redacts nested %s without changing source data', (key) => {
    const source = { status: 401, response: [{ [key]: secret, accountId: 'local-account' }] }
    const output = redact(source)
    expect(JSON.stringify(output)).not.toContain(secret)
    expect(source.response[0][key]).toBe(secret)
    expect(output.response[0].accountId).toBe('local-account')
    expect(output.status).toBe(401)
  })

  test.each([
    `request failed Bearer ${secret}`,
    `Authorization: Basic c3ludGhldGljLW9ubHk=`,
    `refresh_token=${secret}&status=401`,
    `request preview: {"access_token":"${secret}","status":401}`,
    `Cookie: session=${secret}; other=${secret}`,
    `https://user:${secret}@proxy.invalid`,
    `password='${secret}'`,
    `API Key: ${secret}`,
    JSON.stringify({ preview: JSON.stringify({ headers: { Authorization: `Bearer ${secret}` } }) })
  ])('redacts serialized previews and text: %s', (value) => {
    expect(redactString(value)).not.toContain(secret)
    expect(redactString(value)).not.toContain('c3ludGhldGljLW9ubHk=')
  })

  test('handles non-enumerable Error properties, cycles, symbols, binary and accessors', () => {
    const error = new Error(`upstream rejected Bearer ${secret}`)
    error.config = { headers: { Authorization: secret } }
    error.cause = error
    error[Symbol.for('splat')] = [{ password: secret }]
    error.bytes = Buffer.from(secret)
    Object.defineProperty(error, 'unsafe', {
      get: () => {
        throw new Error(secret)
      }
    })
    const output = redact(error)
    expect(JSON.stringify(output)).not.toContain(secret)
    expect(output.stack).toContain('upstream rejected')
    expect(output.cause).toBe('[Circular]')
    expect(output[Symbol.for('splat')][0].password).toBe('[REDACTED]')
  })

  test('retains auth presence, expiry and numerical usage without token fragments', () => {
    expect(redact({ hasAccessToken: true, expiresIn: 3600, input_tokens: 42 })).toEqual({
      hasAccessToken: true,
      expiresIn: 3600,
      input_tokens: 42
    })
    expect(maskToken(secret, 100)).toBe('[REDACTED]')
    expect(redact({ code: 'ECONNREFUSED' }).code).toBe('ECONNREFUSED')
    expect(redact({ code: secret }).code).toBe('[REDACTED]')
  })
})
