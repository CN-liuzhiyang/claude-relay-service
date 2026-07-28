/**
 * Codex（ChatGPT 订阅账号）会话窗口展示辅助
 * 供 AccountsView / StatsOverview 共用
 *
 * 说明：上游窗口长度是动态的（OpenAI 已把 primary 从 5 小时改成 7 天、并取消 secondary），
 * 因此标签必须由 windowMinutes 推导，不能按 primary/secondary 硬编码。
 */

const toFiniteNumber = (value) => {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * 判断某个窗口是否有可展示的数据
 * 上游取消 secondary 后会返回全 0，这类窗口不应该占用界面空间
 */
export const hasCodexWindowData = (usageItem) => {
  if (!usageItem) {
    return false
  }

  const windowMinutes = toFiniteNumber(usageItem.windowMinutes)
  if (windowMinutes !== null && windowMinutes > 0) {
    return true
  }

  // 历史数据可能没有 windowMinutes，退而检查用量字段
  const usedPercent = toFiniteNumber(usageItem.usedPercent)
  const resetAfterSeconds = toFiniteNumber(usageItem.resetAfterSeconds)
  return (
    (usedPercent !== null && usedPercent > 0) ||
    (resetAfterSeconds !== null && resetAfterSeconds > 0)
  )
}

/**
 * 时间窗口标签，按 windowMinutes 推导（10080 → 7天，300 → 5h）
 * @param {object} usageItem - codexUsage.primary / codexUsage.secondary
 * @param {string} type - 'primary' | 'secondary'，仅在缺少 windowMinutes 时用于回落
 */
export const formatCodexWindowLabel = (usageItem, type) => {
  const minutes = toFiniteNumber(usageItem?.windowMinutes)

  if (minutes === null || minutes <= 0) {
    // 兼容没有 windowMinutes 的历史数据
    return type === 'secondary' ? '周限' : '5h'
  }

  if (minutes >= 1440) {
    return `${Math.round(minutes / 1440)}天`
  }
  if (minutes >= 60) {
    const hours = minutes / 60
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`
  }
  return `${Math.round(minutes)}m`
}

// 归一化使用率：窗口已过重置时间时视为 0
export const normalizeCodexUsagePercent = (usageItem) => {
  if (!usageItem) {
    return null
  }

  const basePercent = toFiniteNumber(usageItem.usedPercent)
  const resetAfterSeconds = toFiniteNumber(usageItem.resetAfterSeconds)
  const remainingSeconds =
    typeof usageItem.remainingSeconds === 'number' ? usageItem.remainingSeconds : null
  const resetAtMs = usageItem.resetAt ? Date.parse(usageItem.resetAt) : null

  const resetElapsed =
    resetAfterSeconds !== null &&
    ((remainingSeconds !== null && remainingSeconds <= 0) ||
      (resetAtMs !== null && !Number.isNaN(resetAtMs) && Date.now() >= resetAtMs))

  if (resetElapsed) {
    return 0
  }
  if (basePercent === null) {
    return null
  }
  return Math.max(0, Math.min(100, basePercent))
}

// 进度条颜色
export const getCodexUsageBarClass = (usageItem) => {
  const percent = normalizeCodexUsagePercent(usageItem)
  if (percent === null) {
    return 'bg-gradient-to-r from-gray-300 to-gray-400'
  }
  if (percent >= 90) {
    return 'bg-gradient-to-r from-red-500 to-red-600'
  }
  if (percent >= 75) {
    return 'bg-gradient-to-r from-yellow-500 to-orange-500'
  }
  return 'bg-gradient-to-r from-emerald-500 to-teal-500'
}

// 进度条宽度
export const getCodexUsageWidth = (usageItem) => {
  const percent = normalizeCodexUsagePercent(usageItem)
  if (percent === null) {
    return '0%'
  }
  return `${percent}%`
}

// 百分比文本
export const formatCodexUsagePercent = (usageItem) => {
  const percent = normalizeCodexUsagePercent(usageItem)
  if (percent === null) {
    return '--'
  }
  return `${percent.toFixed(1)}%`
}

// 剩余重置时间文本
export const formatCodexRemaining = (usageItem) => {
  if (!usageItem) {
    return '--'
  }

  let seconds = usageItem.remainingSeconds
  if (seconds === null || seconds === undefined) {
    seconds = usageItem.resetAfterSeconds
  }
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) {
    return '--'
  }

  seconds = Math.max(0, Math.floor(Number(seconds)))

  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (days > 0) {
    return hours > 0 ? `${days}天${hours}小时` : `${days}天`
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`
  }
  if (minutes > 0) {
    return `${minutes}分钟`
  }
  return `${secs}秒`
}

/**
 * 返回该账号需要渲染的窗口列表，自动过滤掉无数据的窗口
 * @returns {Array<{ type: string, item: object, label: string }>}
 */
export const getCodexWindows = (codexUsage) => {
  if (!codexUsage) {
    return []
  }
  return ['primary', 'secondary']
    .filter((type) => hasCodexWindowData(codexUsage[type]))
    .map((type) => ({
      type,
      item: codexUsage[type],
      label: formatCodexWindowLabel(codexUsage[type], type)
    }))
}
