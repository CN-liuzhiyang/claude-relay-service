<template>
  <div class="flex flex-wrap items-center gap-1.5">
    <template v-if="state">
      <el-tooltip effect="dark" placement="top" :show-after="150">
        <template #content>
          <div class="max-w-xs space-y-1.5 text-xs">
            <div class="font-semibold">
              {{
                state.availableCount > 0
                  ? `重置卡 ${state.availableCount} 张当前可用`
                  : '当前没有可用的重置卡'
              }}
            </div>
            <div v-for="(credit, index) in state.credits" :key="index" class="leading-relaxed">
              <span class="font-medium">{{ credit.label || '重置卡' }}</span>
              ×{{ credit.resetsLeft }}
              <span v-if="credit.clears.length">（可清 {{ clearsText(credit.clears) }}）</span>
              <span v-if="credit.expiresAt"> — {{ formatExpiry(credit.expiresAt) }}</span>
              <div v-if="!credit.redeemable" class="opacity-80">{{ unusableReason(credit) }}</div>
            </div>
            <div v-if="state.cooldownUntil" class="border-t border-gray-500/40 pt-1 opacity-80">
              冷却至 {{ formatTime(state.cooldownUntil) }}
            </div>
            <div class="border-t border-gray-500/40 pt-1 opacity-80">
              查询于 {{ formatTime(state.fetchedAt) }}
            </div>
          </div>
        </template>
        <span
          class="inline-flex cursor-default items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
          :class="badgeClass"
        >
          <i class="fas fa-ticket-alt text-[10px]" />
          重置卡 ×{{ totalLeft }}
        </span>
      </el-tooltip>
      <button
        v-if="state.availableCount > 0"
        class="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700 transition-colors hover:bg-blue-200 disabled:opacity-50 dark:bg-blue-500/20 dark:text-blue-300 dark:hover:bg-blue-500/30"
        :disabled="using"
        title="使用一张重置卡（立即生效，不可撤销）"
        @click="$emit('redeem')"
      >
        <i class="fas" :class="using ? 'fa-spinner fa-spin' : 'fa-bolt'" />
        使用
      </button>
    </template>
    <button
      class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-gray-500 transition-colors hover:text-blue-500 disabled:opacity-50 dark:text-gray-400 dark:hover:text-blue-400"
      :disabled="loading || using"
      title="查询重置卡（只读，不消耗额度，走账号代理）"
      @click="$emit('refresh')"
    >
      <i class="fas" :class="loading ? 'fa-spinner fa-spin' : 'fa-rotate-right'" />
      {{ state ? '' : '查重置卡' }}
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  state: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  using: { type: Boolean, default: false }
})

defineEmits(['refresh', 'redeem'])

const WINDOW_NAMES = {
  five_hour: '5 小时',
  seven_day: '周',
  seven_day_overage_included: '周（含超额）'
}

const clearsText = (clears) => clears.map((w) => WINDOW_NAMES[w] || w).join('、')

const totalLeft = computed(() =>
  (props.state?.credits || []).reduce((sum, credit) => sum + (credit.resetsLeft || 0), 0)
)

const soonestDays = computed(() => {
  const days = (props.state?.credits || [])
    .filter((c) => c.expiresAt)
    .map((c) => Math.ceil((new Date(c.expiresAt).getTime() - Date.now()) / 86400000))
  return days.length > 0 ? Math.min(...days) : null
})

const badgeClass = computed(() => {
  if (totalLeft.value === 0) {
    return 'bg-gray-100 text-gray-500 dark:bg-gray-500/20 dark:text-gray-400'
  }
  const days = soonestDays.value
  if (days !== null && days <= 3) {
    return 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300'
  }
  if (days !== null && days <= 7) {
    return 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300'
  }
  return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
})

const formatTime = (iso) => (iso ? new Date(iso).toLocaleString() : '')

const formatExpiry = (iso) => {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000)
  return days <= 0 ? '今日过期' : `${days} 天后过期`
}

const unusableReason = (credit) => {
  if (credit.blocking?.length) return `暂不可用：${credit.blocking.join('、')}`
  if (props.state?.cooldownUntil) return '冷却中'
  if (credit.useRequiresLimit) return '没撞到限流，暂时用不上'
  return '暂时用不上'
}
</script>
