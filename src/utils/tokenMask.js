/**
 * Token 脱敏工具
 * 用于在日志中安全显示 token，不保留任何凭据字符
 */

/**
 * 对 token 进行脱敏处理
 * @param {string} token - 需要脱敏的 token
 * @param {number} visiblePercent - 旧参数，仅保留接口兼容性
 * @returns {string} 脱敏后的 token
 */
function maskToken(token, _visiblePercent) {
  return token && typeof token === 'string' ? '[REDACTED]' : '[EMPTY]'
}

/**
 * 对包含 token 的对象进行脱敏处理
 * @param {Object} obj - 包含 token 的对象
 * @param {Array<string>} tokenFields - 需要脱敏的字段名列表
 * @returns {Object} 脱敏后的对象副本
 */
function maskTokensInObject(
  obj,
  tokenFields = ['accessToken', 'refreshToken', 'access_token', 'refresh_token']
) {
  if (!obj || typeof obj !== 'object') {
    return obj
  }

  const masked = { ...obj }

  tokenFields.forEach((field) => {
    if (masked[field]) {
      masked[field] = maskToken(masked[field])
    }
  })

  return masked
}

/**
 * 格式化 token 刷新日志
 * @param {string} accountId - 账户 ID
 * @param {string} accountName - 账户名称
 * @param {Object} tokens - 包含 access_token 和 refresh_token 的对象
 * @param {string} status - 刷新状态 (success/failed)
 * @param {string} message - 额外的消息
 * @returns {Object} 格式化的日志对象
 */
function formatTokenRefreshLog(accountId, accountName, tokens, status, message = '') {
  const log = {
    timestamp: new Date().toISOString(),
    event: 'token_refresh',
    accountId,
    accountName,
    status,
    message
  }

  if (tokens) {
    log.tokens = {
      accessToken: tokens.accessToken ? maskToken(tokens.accessToken) : '[NOT_PROVIDED]',
      refreshToken: tokens.refreshToken ? maskToken(tokens.refreshToken) : '[NOT_PROVIDED]',
      expiresAt: tokens.expiresAt || '[NOT_PROVIDED]'
    }
  }

  return log
}

module.exports = {
  maskToken,
  maskTokensInObject,
  formatTokenRefreshLog
}
