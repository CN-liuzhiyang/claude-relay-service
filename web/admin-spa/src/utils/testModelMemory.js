/**
 * 测试模型记忆
 *
 * 连通性测试弹窗每次打开都会重置成列表里的第一个模型，自定义模型更是关掉就丢，
 * 这里用 localStorage 按「作用域」记住上次选择，并维护一份自定义模型的最近使用列表。
 *
 * 作用域 = 账户模式下的 platform / API Key 模式下的 serviceType，
 * 按作用域隔离，避免 Claude 的选择污染 OpenAI。
 */

const STORAGE_KEY = 'crs.testModel'
const MAX_CUSTOM_MODELS = 5

const readStore = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { last: {}, custom: {} }
    }
    const parsed = JSON.parse(raw)
    return {
      last: parsed?.last && typeof parsed.last === 'object' ? parsed.last : {},
      custom: parsed?.custom && typeof parsed.custom === 'object' ? parsed.custom : {}
    }
  } catch (e) {
    // localStorage 不可用或数据损坏时静默退化为「无记忆」
    return { last: {}, custom: {} }
  }
}

const writeStore = (store) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch (e) {
    // 隐私模式 / 配额超限，忽略即可，不影响测试功能
  }
}

/** 读取该作用域上次使用的模型 */
export const getRememberedModel = (scope) => {
  if (!scope) {
    return ''
  }
  const store = readStore()
  const model = store.last[scope]
  return typeof model === 'string' ? model : ''
}

/** 读取该作用域的自定义模型最近使用列表 */
export const getCustomModels = (scope) => {
  if (!scope) {
    return []
  }
  const store = readStore()
  const list = store.custom[scope]
  return Array.isArray(list) ? list.filter((m) => typeof m === 'string' && m) : []
}

/**
 * 记住一次成功的模型选择
 * @param {string} scope
 * @param {string} model
 * @param {boolean} isCustom - 是否是手输的自定义模型（会额外进 MRU 列表）
 */
export const rememberModel = (scope, model, isCustom = false) => {
  if (!scope || !model || typeof model !== 'string') {
    return
  }

  const store = readStore()
  store.last[scope] = model

  if (isCustom) {
    const existing = Array.isArray(store.custom[scope]) ? store.custom[scope] : []
    store.custom[scope] = [model, ...existing.filter((m) => m !== model)].slice(
      0,
      MAX_CUSTOM_MODELS
    )
  }

  writeStore(store)
}

/** 从 MRU 列表移除一个自定义模型 */
export const forgetCustomModel = (scope, model) => {
  if (!scope || !model) {
    return
  }
  const store = readStore()
  const existing = Array.isArray(store.custom[scope]) ? store.custom[scope] : []
  store.custom[scope] = existing.filter((m) => m !== model)
  if (store.last[scope] === model) {
    delete store.last[scope]
  }
  writeStore(store)
}

/**
 * 解析弹窗打开时应该选中的模型
 * 记忆值必须仍然合法（在预设列表或自定义 MRU 里）才采用，否则回落到默认值，
 * 避免平台模型列表变化后一直选中一个已经不可用的模型
 */
export const resolveInitialModel = (scope, presetModels, defaultModel) => {
  const remembered = getRememberedModel(scope)
  if (!remembered) {
    return defaultModel
  }

  const inPresets = (presetModels || []).some((m) => m.value === remembered)
  const inCustom = getCustomModels(scope).includes(remembered)

  return inPresets || inCustom ? remembered : defaultModel
}
