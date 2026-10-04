const crypto = require('crypto')
const claudeCodeVersion = require('./claudeCodeVersion')
const { mapToErrorCode } = require('./errorSanitizer')
const modelsConfig = require('../../config/models')

// 将原始错误信息映射为安全的标准错误码消息
const sanitizeErrorMsg = (msg) => {
  const mapped = mapToErrorCode({ message: msg }, { logOriginal: false })
  return `[${mapped.code}] ${mapped.message}`
}

/**
 * 平台测试的默认模型：取 config/models.js 中该平台测试模型列表的第一项（与前端下拉框一致）
 * @param {string} platform - 平台标识（claude / claude-console / gemini / openai ...）
 * @returns {string} 模型名，平台无列表时返回空字符串
 */
function getDefaultTestModel(platform) {
  const list = modelsConfig.PLATFORM_TEST_MODELS?.[platform]
  return Array.isArray(list) && typeof list[0]?.value === 'string' ? list[0].value : ''
}

/**
 * 解析测试模型：优先使用界面选择/填写的模型，未提供时回退到平台默认模型
 * @param {string} platform - 平台标识
 * @param {*} requestedModel - 请求体中的 model
 * @returns {string} 模型名
 */
function resolveTestModel(platform, requestedModel) {
  const model = typeof requestedModel === 'string' ? requestedModel.trim() : ''
  return model || getDefaultTestModel(platform)
}

/**
 * 生成随机十六进制字符串
 * @param {number} bytes - 字节数
 * @returns {string} 十六进制字符串
 */
function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex')
}

/**
 * 生成 Claude Code 风格的会话字符串
 * @returns {string} 会话字符串，格式: user_{64位hex}_account__session_{uuid}
 */
function generateSessionString() {
  const hex64 = randomHex(32) // 32 bytes => 64 hex characters
  const uuid = crypto.randomUUID()
  return `user_${hex64}_account__session_${uuid}`
}

/**
 * 生成 Claude 测试请求体
 * @param {string} model - 模型名称
 * @param {object} options - 可选配置
 * @param {boolean} options.stream - 是否流式（默认false）
 * @param {string} options.prompt - 自定义提示词（默认 'hi'）
 * @param {number} options.maxTokens - 最大输出 token（默认 1000）
 * @returns {object} 测试请求体
 */
function createClaudeTestPayload(model = getDefaultTestModel('claude'), options = {}) {
  const { stream, prompt = 'hi', maxTokens = 1000 } = options
  const payload = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt,
            cache_control: {
              type: 'ephemeral'
            }
          }
        ]
      }
    ],
    system: [
      {
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: {
          type: 'ephemeral'
        }
      }
    ],
    metadata: {
      user_id: generateSessionString()
    },
    max_tokens: maxTokens
  }

  if (stream) {
    payload.stream = true
  }

  return payload
}

/**
 * 发送流式测试请求并处理SSE响应
 * @param {object} options - 配置选项
 * @param {string} options.apiUrl - API URL
 * @param {string} options.authorization - Authorization header值
 * @param {object} options.responseStream - Express响应流
 * @param {object} [options.payload] - 请求体（默认使用createClaudeTestPayload）
 * @param {object} [options.proxyAgent] - 代理agent
 * @param {boolean} [options.direct] - 已通过策略校验的本机直连（无代理）
 * @param {number} [options.timeout] - 超时时间（默认30000）
 * @param {object} [options.extraHeaders] - 额外的请求头
 * @returns {Promise<void>}
 */
async function sendStreamTestRequest(options) {
  const axios = require('axios')
  const logger = require('./logger')

  const {
    apiUrl,
    authorization,
    responseStream,
    payload = createClaudeTestPayload(getDefaultTestModel('claude'), { stream: true }),
    proxyAgent = null,
    direct = false,
    timeout = 30000,
    extraHeaders = {},
    sanitize = false
  } = options

  const sendSSE = (type, data = {}) => {
    if (!responseStream.destroyed && !responseStream.writableEnded) {
      try {
        responseStream.write(`data: ${JSON.stringify({ type, ...data })}\n\n`)
      } catch {
        // ignore
      }
    }
  }

  const endTest = (success, error = null) => {
    if (!responseStream.destroyed && !responseStream.writableEnded) {
      try {
        responseStream.write(
          `data: ${JSON.stringify({ type: 'test_complete', success, error: error || undefined })}\n\n`
        )
        responseStream.end()
      } catch {
        // ignore
      }
    }
  }

  // 设置响应头
  if (!responseStream.headersSent) {
    responseStream.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
  }

  sendSSE('test_start', { message: 'Test started' })

  const requestConfig = {
    method: 'POST',
    url: apiUrl,
    data: payload,
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'User-Agent': claudeCodeVersion.getDefaultUserAgent(),
      ...(authorization ? { authorization } : {}),
      ...extraHeaders
    },
    timeout,
    responseType: 'stream',
    validateStatus: () => true
  }

  if (proxyAgent) {
    requestConfig.httpAgent = proxyAgent
    requestConfig.httpsAgent = proxyAgent
    requestConfig.proxy = false
  } else if (direct) {
    // 直连本机上游：忽略环境代理变量，且不跟随重定向
    requestConfig.proxy = false
    requestConfig.maxRedirects = 0
  }

  try {
    const response = await axios(requestConfig)
    logger.debug(`🌊 Test response status: ${response.status}`)

    // 处理非200响应
    if (response.status !== 200) {
      return new Promise((resolve) => {
        const chunks = []
        response.data.on('data', (chunk) => chunks.push(chunk))
        response.data.on('end', () => {
          const errorData = Buffer.concat(chunks).toString()
          let json = null
          try {
            json = JSON.parse(errorData)
          } catch {
            // 非 JSON 错误体，短文本直接作为错误信息
          }
          const fallback = !json && errorData.length < 200 ? errorData : ''
          const upstream = formatUpstreamError(response.status, json, fallback)
          const errorMsg = sanitize
            ? [upstream.prefix, sanitizeErrorMsg(upstream.detail)].filter(Boolean).join(': ')
            : upstream.message
          endTest(false, errorMsg)
          resolve()
        })
        response.data.on('error', (err) => {
          endTest(false, sanitize ? sanitizeErrorMsg(err.message) : err.message)
          resolve()
        })
      })
    }

    // 处理成功的流式响应
    return new Promise((resolve) => {
      let buffer = ''

      response.data.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data:')) {
            continue
          }
          const jsonStr = line.substring(5).trim()
          if (!jsonStr || jsonStr === '[DONE]') {
            continue
          }

          try {
            const data = JSON.parse(jsonStr)

            if (data.type === 'content_block_delta' && data.delta?.text) {
              sendSSE('content', { text: data.delta.text })
            }
            if (data.type === 'message_stop') {
              sendSSE('message_stop')
            }
            if (data.type === 'error' || data.error) {
              const errMsg = data.error?.message || data.message || data.error || 'Unknown error'
              sendSSE('error', { error: errMsg })
            }
          } catch {
            // ignore parse errors
          }
        }
      })

      response.data.on('end', () => {
        if (!responseStream.destroyed && !responseStream.writableEnded) {
          endTest(true)
        }
        resolve()
      })

      response.data.on('error', (err) => {
        endTest(false, err.message)
        resolve()
      })
    })
  } catch (error) {
    logger.error('❌ Stream test request failed:', error.message)
    endTest(false, error.message)
  }
}

/**
 * 生成 Gemini 测试请求体
 * @param {string} model - 模型名称
 * @param {object} options - 可选配置
 * @param {string} options.prompt - 自定义提示词（默认 'hi'）
 * @param {number} options.maxTokens - 最大输出 token（默认 100）
 * @returns {object} 测试请求体
 */
function createGeminiTestPayload(_model = getDefaultTestModel('gemini'), options = {}) {
  const { prompt = 'hi', maxTokens = 100 } = options
  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 1
    }
  }
}

/**
 * 生成 OpenAI Responses 测试请求体
 * @param {string} model - 模型名称
 * @param {object} options - 可选配置
 * @param {string} options.prompt - 自定义提示词（默认 'hi'）
 * @param {number} options.maxTokens - 最大输出 token（默认 100）
 * @returns {object} 测试请求体
 */
function createOpenAITestPayload(model = getDefaultTestModel('openai-responses'), options = {}) {
  const { prompt = 'hi', maxTokens = 100, stream = true } = options
  return {
    model,
    input: [
      {
        role: 'user',
        content: prompt
      }
    ],
    max_output_tokens: maxTokens,
    stream
  }
}

/**
 * 生成 Chat Completions 测试请求体（用于 Azure OpenAI 等 Chat Completions 端点）
 * @param {string} model - 模型名称
 * @param {object} options - 可选配置
 * @param {string} options.prompt - 自定义提示词（默认 'hi'）
 * @param {number} options.maxTokens - 最大输出 token（默认 100）
 * @returns {object} 测试请求体
 */
function createChatCompletionsTestPayload(model = 'gpt-4o-mini', options = {}) {
  const { prompt = 'hi', maxTokens = 100 } = options
  return {
    model,
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ],
    max_tokens: maxTokens
  }
}

/**
 * 格式化上游错误：带 HTTP 状态码和错误类型，例如 "HTTP 404 not_found_error: model: xxx"
 * @param {number} status - 上游 HTTP 状态码
 * @param {object|null} json - 解析后的错误响应体（可为空）
 * @param {string} [fallback] - 无法从响应体提取信息时使用的文本
 * @returns {{message: string, prefix: string, detail: string, status: number, errorType: string}}
 */
function formatUpstreamError(status, json, fallback = '') {
  const error = json && typeof json === 'object' ? json.error : null
  const typeCandidates = [
    error?.type,
    error?.status,
    error?.code,
    json?.type !== 'error' ? json?.type : ''
  ]
  const errorType = typeCandidates.find((value) => typeof value === 'string' && value) || ''
  const detail = extractErrorMessage(json, fallback) || ''
  const prefix = [status ? `HTTP ${status}` : '', errorType].filter(Boolean).join(' ')
  return {
    message: [prefix, detail].filter(Boolean).join(': ') || 'Unknown error',
    prefix,
    detail,
    status,
    errorType
  }
}

/**
 * 从各种格式的错误响应中提取可读错误信息
 * 支持格式: {message}, {error:{message}}, {msg:{error:{message}}}, {error:"string"} 等
 * @param {object} json - 解析后的 JSON 错误响应
 * @param {string} fallback - 提取失败时的回退信息
 * @returns {string} 错误信息
 */
function extractErrorMessage(json, fallback) {
  if (!json || typeof json !== 'object') {
    return fallback
  }
  // 直接 message
  if (json.message && typeof json.message === 'string') {
    return json.message
  }
  // {error: {message: "..."}}
  if (json.error?.message) {
    return json.error.message
  }
  // {msg: {error: {message: "..."}}} (relay 包装格式)
  if (json.msg?.error?.message) {
    return json.msg.error.message
  }
  if (json.msg?.message) {
    return json.msg.message
  }
  // {error: "string"}
  if (typeof json.error === 'string') {
    return json.error
  }
  // {msg: "string"}
  if (typeof json.msg === 'string') {
    return json.msg
  }
  return fallback
}

module.exports = {
  getDefaultTestModel,
  resolveTestModel,
  formatUpstreamError,
  randomHex,
  generateSessionString,
  createClaudeTestPayload,
  createGeminiTestPayload,
  createOpenAITestPayload,
  createChatCompletionsTestPayload,
  extractErrorMessage,
  sanitizeErrorMsg,
  sendStreamTestRequest
}
