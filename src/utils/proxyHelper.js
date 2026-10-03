const { SocksProxyAgent } = require('socks-proxy-agent')
const { HttpsProxyAgent } = require('https-proxy-agent')
const logger = require('./logger')
const config = require('../../config/config')

/**
 * 统一的代理创建工具
 * 支持 SOCKS5 和 HTTP/HTTPS 代理，可配置 IPv4/IPv6
 */
class ProxyHelper {
  // 缓存代理 Agent，避免重复创建浪费连接
  static _agentCache = new Map()

  /**
   * 创建代理 Agent
   * @param {object|string|null} proxyConfig - 代理配置对象或 JSON 字符串
   * @param {object} options - 额外选项
   * @param {boolean|number} options.useIPv4 - 是否使用 IPv4 (true=IPv4, false=IPv6, undefined=auto)
   * @returns {Agent|null} 代理 Agent 实例或 null
   */
  static createProxyAgent(proxyConfig, options = {}) {
    if (!proxyConfig) {
      if (options.required || config.proxy?.required) {
        throw ProxyHelper._policyError('Proxy configuration is required')
      }
      return null
    }

    try {
      // 解析代理配置
      const proxy = typeof proxyConfig === 'string' ? JSON.parse(proxyConfig) : proxyConfig

      // 验证必要字段
      if (!ProxyHelper.validateProxyConfig(proxy)) {
        throw ProxyHelper._policyError('Invalid proxy configuration')
      }
      const address = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host
      const endpoint = `${proxy.type}://${address}:${Number(proxy.port)}`
      const allowedEndpoints = config.proxy?.allowedEndpoints || []
      if (allowedEndpoints.length && !allowedEndpoints.includes(endpoint)) {
        throw ProxyHelper._policyError('Proxy endpoint is outside the allowed list')
      }

      // 获取 IPv4/IPv6 配置
      const useIPv4 = ProxyHelper._getIPFamilyPreference(options.useIPv4)

      // 配置连接池与 Keep-Alive
      const proxySettings = config.proxy || {}
      const agentCommonOptions = {}

      if (typeof proxySettings.keepAlive === 'boolean') {
        agentCommonOptions.keepAlive = proxySettings.keepAlive
      }

      if (
        typeof proxySettings.maxSockets === 'number' &&
        Number.isFinite(proxySettings.maxSockets) &&
        proxySettings.maxSockets > 0
      ) {
        agentCommonOptions.maxSockets = proxySettings.maxSockets
      }

      if (
        typeof proxySettings.maxFreeSockets === 'number' &&
        Number.isFinite(proxySettings.maxFreeSockets) &&
        proxySettings.maxFreeSockets >= 0
      ) {
        agentCommonOptions.maxFreeSockets = proxySettings.maxFreeSockets
      }

      if (
        typeof proxySettings.timeout === 'number' &&
        Number.isFinite(proxySettings.timeout) &&
        proxySettings.timeout > 0
      ) {
        agentCommonOptions.timeout = proxySettings.timeout
      }

      // 缓存键：保证相同配置的代理可复用
      const cacheKey = JSON.stringify({
        type: proxy.type,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password,
        family: useIPv4,
        keepAlive: agentCommonOptions.keepAlive,
        maxSockets: agentCommonOptions.maxSockets,
        maxFreeSockets: agentCommonOptions.maxFreeSockets,
        timeout: agentCommonOptions.timeout
      })

      if (ProxyHelper._agentCache.has(cacheKey)) {
        return ProxyHelper._agentCache.get(cacheKey)
      }

      // 构建认证信息
      const auth = proxy.username
        ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
        : ''
      let agent = null

      // 根据代理类型创建 Agent
      if (proxy.type === 'socks5') {
        const socksUrl = `socks5h://${auth}${address}:${Number(proxy.port)}`
        const socksOptions = { ...agentCommonOptions }

        // 设置 IP 协议族（如果指定）
        if (useIPv4 !== null) {
          socksOptions.family = useIPv4 ? 4 : 6
        }

        agent = new SocksProxyAgent(socksUrl, socksOptions)
      } else if (proxy.type === 'http' || proxy.type === 'https') {
        const proxyUrl = `${proxy.type}://${auth}${address}:${Number(proxy.port)}`
        const httpOptions = { ...agentCommonOptions }

        // HttpsProxyAgent 支持 family 参数（通过底层的 agent-base）
        if (useIPv4 !== null) {
          httpOptions.family = useIPv4 ? 4 : 6
        }

        agent = new HttpsProxyAgent(proxyUrl, httpOptions)
      } else {
        throw ProxyHelper._policyError('Unsupported proxy type')
      }

      if (agent) {
        ProxyHelper._agentCache.set(cacheKey, agent)
      }

      return agent
    } catch (error) {
      // Constructor and JSON errors may contain credentials. Expose a fixed safe error only.
      if (error.code === 'PROXY_POLICY_REJECTED') {
        throw error
      }
      throw ProxyHelper._policyError('Unable to create required proxy agent')
    }
  }

  static _policyError(message) {
    const error = new Error(message)
    error.code = 'PROXY_POLICY_REJECTED'
    error.statusCode = 503
    return error
  }

  /**
   * 获取 IP 协议族偏好设置
   * @param {boolean|number|string} preference - 用户偏好设置
   * @returns {boolean|null} true=IPv4, false=IPv6, null=auto
   * @private
   */
  static _getIPFamilyPreference(preference) {
    // 如果没有指定偏好，使用配置文件或默认值
    if (preference === undefined) {
      // 从配置文件读取默认设置，默认使用 IPv4
      const defaultUseIPv4 = config.proxy?.useIPv4
      if (defaultUseIPv4 !== undefined) {
        return defaultUseIPv4
      }
      // 默认值：IPv4（兼容性更好）
      return true
    }

    // 处理各种输入格式
    if (typeof preference === 'boolean') {
      return preference
    }
    if (typeof preference === 'number') {
      return preference === 4 ? true : preference === 6 ? false : null
    }
    if (typeof preference === 'string') {
      const lower = preference.toLowerCase()
      if (lower === 'ipv4' || lower === '4') {
        return true
      }
      if (lower === 'ipv6' || lower === '6') {
        return false
      }
      if (lower === 'auto' || lower === 'both') {
        return null
      }
    }

    // 无法识别的值，返回默认（IPv4）
    return true
  }

  /**
   * 验证代理配置
   * @param {object|string} proxyConfig - 代理配置
   * @returns {boolean} 是否有效
   */
  static validateProxyConfig(proxyConfig) {
    if (!proxyConfig) {
      return false
    }

    try {
      const proxy = typeof proxyConfig === 'string' ? JSON.parse(proxyConfig) : proxyConfig

      // 检查必要字段
      if (
        !proxy ||
        typeof proxy !== 'object' ||
        Array.isArray(proxy) ||
        typeof proxy.host !== 'string' ||
        !proxy.host ||
        /[\s/@?#[\]]/.test(proxy.host)
      ) {
        return false
      }

      // 检查支持的类型
      if (!['socks5', 'http', 'https'].includes(proxy.type)) {
        return false
      }

      // 检查端口范围
      if (
        !['number', 'string'].includes(typeof proxy.port) ||
        (typeof proxy.port === 'string' && !/^\d+$/.test(proxy.port))
      ) {
        return false
      }
      const port = Number(proxy.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return false
      }

      if (!!proxy.username !== !!proxy.password) {
        return false
      }
      if (
        (proxy.username && typeof proxy.username !== 'string') ||
        (proxy.password && typeof proxy.password !== 'string')
      ) {
        return false
      }
      new URL(
        `${proxy.type}://${proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host}:${port}`
      )

      return true
    } catch (error) {
      return false
    }
  }

  /**
   * 获取代理配置的描述信息
   * @param {object|string} proxyConfig - 代理配置
   * @returns {string} 代理描述
   */
  static getProxyDescription(proxyConfig) {
    if (!proxyConfig) {
      return 'No proxy'
    }

    try {
      const proxy = typeof proxyConfig === 'string' ? JSON.parse(proxyConfig) : proxyConfig
      const hasAuth = proxy.username && proxy.password
      return `${proxy.type}://${proxy.host}:${proxy.port}${hasAuth ? ' (with auth)' : ''}`
    } catch (error) {
      return 'Invalid proxy config'
    }
  }

  /**
   * 脱敏代理配置信息用于日志记录
   * @param {object|string} proxyConfig - 代理配置
   * @returns {string} 脱敏后的代理信息
   */
  static maskProxyInfo(proxyConfig) {
    if (!proxyConfig) {
      return 'No proxy'
    }

    try {
      const proxy = typeof proxyConfig === 'string' ? JSON.parse(proxyConfig) : proxyConfig

      let proxyDesc = `${proxy.type}://${proxy.host}:${proxy.port}`

      // 如果有认证信息，进行脱敏处理
      if (proxy.username && proxy.password) {
        const maskedUsername =
          proxy.username.length <= 2
            ? proxy.username
            : proxy.username[0] +
              '*'.repeat(Math.max(1, proxy.username.length - 2)) +
              proxy.username.slice(-1)
        const maskedPassword = '*'.repeat(Math.min(8, proxy.password.length))
        proxyDesc += ` (auth: ${maskedUsername}:${maskedPassword})`
      }

      return proxyDesc
    } catch (error) {
      return 'Invalid proxy config'
    }
  }

  /**
   * 创建代理 Agent（兼容旧的函数接口）
   * @param {object|string|null} proxyConfig - 代理配置
   * @param {boolean} useIPv4 - 是否使用 IPv4
   * @returns {Agent|null} 代理 Agent 实例或 null
   * @deprecated 使用 createProxyAgent 替代
   */
  static createProxy(proxyConfig, useIPv4 = true) {
    logger.warn('⚠️ ProxyHelper.createProxy is deprecated, use createProxyAgent instead')
    return ProxyHelper.createProxyAgent(proxyConfig, { useIPv4 })
  }
}

module.exports = ProxyHelper
