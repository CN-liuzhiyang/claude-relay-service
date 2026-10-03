// The public model API may remain HTTP, but management credentials must use TLS.
// Read the socket peer directly: Express trust-proxy / forwarded IP headers are untrusted here.
const createManagementHttpsGuard = ({ enabled = false, publicUrl = '' } = {}) => {
  if (!enabled) {
    return (_req, _res, next) => next()
  }
  const origin = new URL(publicUrl)
  if (origin.protocol !== 'https:' || origin.username || origin.password) {
    throw new Error('Management HTTPS policy requires a public HTTPS origin')
  }
  const protectedPath = /^\/(?:admin-next|admin|web|users|apistats)(?:\/|$)/i
  const pagePath = /^\/admin-next(?:\/|$)/i
  return (req, res, next) => {
    const route = req.path
    if (route !== '/' && route.toLowerCase() !== '/metrics' && !protectedPath.test(route)) {
      return next()
    }
    const peer = req.socket.remoteAddress
    const localProxy = ['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(peer)
    if (req.socket.encrypted || (localProxy && req.headers['x-forwarded-proto'] === 'https')) {
      return next()
    }
    res.setHeader('Cache-Control', 'no-store')
    if (['GET', 'HEAD'].includes(req.method) && (route === '/' || pagePath.test(route))) {
      // Use the configured origin, never the client-controlled Host/Forwarded headers.
      const target = route === '/' ? '/admin-next/login' : route
      return res.redirect(302, `${origin.origin}${target}`)
    }
    // Do not redirect credential-bearing requests: they must be retried over HTTPS.
    return res.status(403).json({
      error: 'Management HTTPS required',
      message: 'Use the HTTPS management address',
      managementUrl: `${origin.origin}/admin-next/login`
    })
  }
}

module.exports = { createManagementHttpsGuard }
