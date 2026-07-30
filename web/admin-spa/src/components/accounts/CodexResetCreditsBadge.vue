<template>
  <div v-if="resetCredits && resetCredits.availableCount > 0" class="flex items-center gap-1.5">
    <el-tooltip effect="dark" placement="top" :show-after="150">
      <template #content>
        <div class="max-w-xs space-y-1.5 text-xs">
          <div class="font-semibold">重置卡 {{ resetCredits.availableCount }} 张可用</div>
          <div v-for="item in resetCredits.items" :key="item.id" class="leading-relaxed">
            <span class="font-medium">{{ item.title }}</span>
            <span v-if="item.remainingDays !== null"> — {{ formatExpiry(item) }} </span>
          </div>
          <div class="border-t border-gray-500/40 pt-1 opacity-80">
            {{
              resetCredits.applicableCount > 0
                ? `当前可用 ${resetCredits.applicableCount} 张`
                : '当前未触发限流，暂时用不上'
            }}
          </div>
        </div>
      </template>
      <span
        class="inline-flex cursor-default items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
        :class="badgeClass"
      >
        <i class="fas fa-ticket-alt text-[10px]" />
        重置卡 ×{{ resetCredits.availableCount }}
      </span>
    </el-tooltip>
    <button
      v-if="resetCredits.applicableCount > 0"
      class="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700 transition-colors hover:bg-blue-200 disabled:opacity-50 dark:bg-blue-500/20 dark:text-blue-300 dark:hover:bg-blue-500/30"
      :disabled="using"
      title="使用一张重置卡（立即生效，不可撤销）"
      @click="$emit('use-credit', resetCredits.items[0]?.id)"
    >
      <i class="fas" :class="using ? 'fa-spinner fa-spin' : 'fa-bolt'" />
      使用
    </button>
    <span
      v-if="creditsBalanceText"
      class="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-500/20 dark:text-violet-300"
    >
      <i class="fas fa-coins text-[10px]" />
      {{ creditsBalanceText }}
    </span>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  resetCredits: { type: Object, default: null },
  credits: { type: Object, default: null },
  using: { type: Boolean, default: false }
})

defineEmits(['use-credit'])

// 最早过期的那张卡决定徽章颜色：≤3天红、≤7天黄、其余绿
const soonestRemainingDays = computed(() => {
  const days = (props.resetCredits?.items || [])
    .map((item) => item.remainingDays)
    .filter((d) => typeof d === 'number')
  return days.length > 0 ? Math.min(...days) : null
})

const badgeClass = computed(() => {
  const days = soonestRemainingDays.value
  if (days !== null && days <= 3) {
    return 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300'
  }
  if (days !== null && days <= 7) {
    return 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300'
  }
  return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
})

const formatExpiry = (item) => {
  if (item.remainingDays === null) {
    return ''
  }
  if (item.remainingDays <= 0) {
    return '今日过期'
  }
  return `${item.remainingDays} 天后过期`
}

const creditsBalanceText = computed(() => {
  const c = props.credits
  if (!c) {
    return ''
  }
  if (c.unlimited) {
    return '积分不限'
  }
  const balance = Number(c.balance)
  return Number.isFinite(balance) && balance > 0 ? `积分 ${balance}` : ''
})
</script>
