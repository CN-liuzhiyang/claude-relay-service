// Keep credentials out of every log transport, including serialized previews and Errors.
const REDACTED = '[REDACTED]'
const SAFE_ERROR_CODES = new Set([
  'PROXY_POLICY_REJECTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ERR_NETWORK',
  'ERR_BAD_REQUEST',
  'ERR_BAD_RESPONSE',
  'ERR_CANCELED'
])
const sensitiveKey = (key) => {
  const normalized = String(key)
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
  return (
    /token|password|passwd|authorization|cookie|credential|secret|privatekey|sessionkey|codeverifier|authorizationcode/.test(
      normalized
    ) || /^(apikey|xapikey|key|code|codeprefix)$/.test(normalized)
  )
}

const redactString = (input) => {
  // Parse structured previews before applying text rules. Never call user-provided toJSON.
  const trimmed = input.trim()
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 1000000) {
    try {
      return JSON.stringify(redact(JSON.parse(trimmed)))
    } catch (_error) {
      // Partial request previews and error messages still need text redaction.
    }
  }
  return input
    .replace(/\b(Bearer|Basic)\s+[a-z0-9._~+/=*-]+/gi, '$1 [REDACTED]')
    .replace(/\b(?:sk-(?:ant-)?[a-z0-9_-]+|cr_[a-z0-9_-]{8,})\b/gi, REDACTED)
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, REDACTED)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:set-cookie|cookie|authorization)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(
      /(["']?(?:[a-z_-]*token[a-z_-]*|[a-z_-]*password[a-z_-]*|passwd|authorization|[a-z_-]*api[ _-]?key|secret|client_secret|session[_-]?key|cookies?|code[_-]?verifier|authorization[_-]?code|code)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]\r\n]+)/gi,
      '$1[REDACTED]'
    )
}

function redact(value, seen = new WeakSet(), depth = 0) {
  if (depth > 20) {
    return '[Depth limit]'
  }
  if (typeof value === 'string') {
    return redactString(value)
  }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? String(value) : value
  }
  if (seen.has(value)) {
    return '[Circular]'
  }
  seen.add(value)
  if (Buffer.isBuffer(value)) {
    return '[Binary omitted]'
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  const result = Array.isArray(value) ? [] : {}
  for (const key of Reflect.ownKeys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (value instanceof Error && (key === 'stack' || key === 'message')) {
      try {
        result[key] = redactString(String(value[key]))
      } catch (_error) {
        result[key] = '[Error detail unavailable]'
      }
      continue
    }
    const safePresence =
      typeof key === 'string' &&
      /^has(?:access|refresh)?token$/i.test(key) &&
      typeof descriptor?.value === 'boolean'
    const safeUsage =
      typeof key === 'string' &&
      /^(?:input_tokens|output_tokens|cache_creation_input_tokens|cache_read_input_tokens)$/i.test(
        key
      ) &&
      typeof descriptor?.value === 'number'
    const safeErrorCode = key === 'code' && SAFE_ERROR_CODES.has(descriptor?.value)
    result[key] =
      typeof key === 'string' && sensitiveKey(key) && !safePresence && !safeUsage && !safeErrorCode
        ? REDACTED
        : descriptor && 'value' in descriptor
          ? redact(descriptor.value, seen, depth + 1)
          : '[Accessor omitted]'
  }
  return result
}

// Construct lazily so the utility can also be used by offline inventory scripts.
const createRedactionFormat = () => require('winston').format((info) => redact(info))()

module.exports = { redact, redactString, sensitiveKey, createRedactionFormat, REDACTED }
