<template>
  <div v-if="windows.length" class="space-y-2">
    <div
      v-for="(window, index) in windows"
      :key="getWindowKey(window, index)"
      class="rounded-lg bg-gray-50 p-2 dark:bg-gray-700/70"
    >
      <div class="flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-1.5">
          <span
            class="inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium"
            :class="getBadgeClass(window)"
          >
            {{ getWindowLabel(window) }}
          </span>
          <el-tooltip
            v-if="isFableWindow(window)"
            content="Fable 会同时消耗本周总额度；此窗口表示 Fable 模型上限，最多可占总周额度的 50%，不是额外额度。"
            placement="top"
          >
            <i
              class="fas fa-info-circle cursor-help text-[11px] text-purple-400 hover:text-purple-600 dark:text-purple-300"
            />
          </el-tooltip>
        </div>
        <span class="shrink-0 text-xs font-semibold text-gray-800 dark:text-gray-100">
          已用 {{ formatPercent(window.utilization) }}
        </span>
      </div>

      <div class="mt-1.5 h-2 w-full rounded-full bg-gray-200 dark:bg-gray-600">
        <div
          class="h-2 rounded-full transition-all duration-300"
          :class="getUsageBarClass(window)"
          :style="{ width: getUsageWidth(window) }"
        />
      </div>

      <div
        class="mt-1 flex items-center justify-between gap-2 text-[11px] text-gray-500 dark:text-gray-400"
      >
        <span>剩余 {{ formatRemainingPercent(window.utilization) }}</span>
        <span class="text-right">{{ formatResetCountdown(window) }}</span>
      </div>

      <div
        v-if="isFableWindow(window)"
        class="mt-1 text-[10px] leading-4 text-purple-500 dark:text-purple-300"
      >
        计入本周总额度 · 上限为周额度 50%
      </div>
    </div>

    <div
      v-if="usage?.updatedAt"
      class="text-right text-[10px] text-gray-400 dark:text-gray-500"
      :title="`用量更新时间：${formatFullTime(usage.updatedAt)}`"
    >
      更新于 {{ formatUpdatedTime(usage.updatedAt) }} · 最多缓存 5 分钟
    </div>
  </div>

  <div v-else class="text-xs text-gray-400 dark:text-gray-500">暂无可用额度窗口</div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  usage: { type: Object, default: null }
})

const toFiniteNumber = (value) => {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const normalizeLegacyWindow = (kind, window, scope = null) => {
  const utilization = toFiniteNumber(window?.utilization)
  if (utilization === null) return null
  return {
    kind,
    group: kind === 'session' ? 'session' : 'weekly',
    utilization,
    resetsAt: window?.resetsAt || null,
    remainingSeconds: window?.remainingSeconds ?? null,
    scope
  }
}

const windows = computed(() => {
  if (Array.isArray(props.usage?.windows)) {
    return props.usage.windows.filter(
      (window) => window?.kind && toFiniteNumber(window.utilization) !== null
    )
  }

  // 兼容尚未刷新到新版缓存结构的账户。
  return [
    normalizeLegacyWindow('session', props.usage?.fiveHour),
    normalizeLegacyWindow('weekly_all', props.usage?.sevenDay),
    normalizeLegacyWindow(
      'weekly_scoped',
      props.usage?.sevenDaySonnet || props.usage?.sevenDayOpus,
      { model: 'Sonnet', surface: null }
    )
  ].filter(Boolean)
})

const getScopeName = (window) => {
  const model = window?.scope?.model
  const surface = window?.scope?.surface
  const normalizeName = (value) => {
    if (typeof value === 'string') return value
    return value?.displayName || value?.display_name || value?.name || value?.id || ''
  }
  return normalizeName(model) || normalizeName(surface)
}

const getWindowLabel = (window) => {
  if (window.kind === 'session') return '5 小时'
  if (window.kind === 'weekly_all') return '本周总额度'
  if (window.kind === 'weekly_scoped') {
    const scopeName = getScopeName(window)
    return scopeName ? `${scopeName} 周上限` : '模型周上限'
  }
  return window.kind.replaceAll('_', ' ')
}

const getWindowKey = (window, index) => `${window.kind}:${getScopeName(window) || 'all'}:${index}`

const getBadgeClass = (window) => {
  if (window.kind === 'session') {
    return 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-300'
  }
  if (window.kind === 'weekly_all') {
    return 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-300'
  }
  return 'bg-purple-100 text-purple-600 dark:bg-purple-500/20 dark:text-purple-300'
}

const getUsageBarClass = (window) => {
  const utilization = toFiniteNumber(window?.utilization) ?? 0
  if (utilization < 60) return 'bg-gradient-to-r from-blue-500 to-indigo-600'
  if (utilization < 90) return 'bg-gradient-to-r from-yellow-500 to-orange-500'
  return 'bg-gradient-to-r from-red-500 to-red-600'
}

const getUsageWidth = (window) => {
  const utilization = toFiniteNumber(window?.utilization) ?? 0
  return `${Math.min(100, Math.max(0, utilization))}%`
}

const formatPercentValue = (value) => {
  const number = toFiniteNumber(value) ?? 0
  return Number.isInteger(number) ? String(number) : number.toFixed(1)
}

const formatPercent = (value) => `${formatPercentValue(value)}%`

const formatRemainingPercent = (value) => {
  const utilization = toFiniteNumber(value) ?? 0
  return `${formatPercentValue(Math.max(0, 100 - utilization))}%`
}

const formatRemainingTime = (seconds) => {
  const totalSeconds = toFiniteNumber(seconds)
  if (totalSeconds === null) return null
  if (totalSeconds <= 0) return '即将重置'

  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)

  if (days > 0) return `${days}天${hours > 0 ? `${hours}小时` : ''}后重置`
  if (hours > 0) return `${hours}小时${minutes > 0 ? `${minutes}分钟` : ''}后重置`
  if (minutes > 0) return `${minutes}分钟后重置`
  return `${Math.floor(totalSeconds)}秒后重置`
}

const formatResetCountdown = (window) => {
  const remainingText = formatRemainingTime(window?.remainingSeconds)
  if (remainingText) return remainingText

  const resetTimestamp = window?.resetsAt ? new Date(window.resetsAt).getTime() : NaN
  if (!Number.isFinite(resetTimestamp)) return '未提供重置时间'
  return formatRemainingTime(Math.max(0, Math.floor((resetTimestamp - Date.now()) / 1000)))
}

const isFableWindow = (window) => getScopeName(window).toLowerCase().includes('fable')

const formatUpdatedTime = (value) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

const formatFullTime = (value) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', { hour12: false })
}
</script>
