<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between">
      <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-300">
        直连本机上游（不走代理）
      </h4>
      <label class="flex cursor-pointer items-center">
        <input
          :checked="modelValue"
          class="h-4 w-4 rounded border-gray-300 bg-gray-100 text-blue-600 focus:ring-blue-500"
          type="checkbox"
          @change="$emit('update:modelValue', $event.target.checked)"
        />
        <span class="ml-2 text-sm text-gray-700 dark:text-gray-300">启用直连</span>
      </label>
    </div>

    <div
      v-if="modelValue"
      class="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-4 text-xs dark:border-gray-600 dark:bg-gray-800"
    >
      <p class="text-gray-700 dark:text-gray-300">
        仅适用于 API URL 指向本机 loopback 地址（如
        <code>http://127.0.0.1:端口</code>）的账号，例如本机隧道或本地网关。
      </p>
      <p class="text-gray-700 dark:text-gray-300">
        开启后该账号请求不经代理，下方代理设置不生效；非 loopback 地址保存会被拒绝。
      </p>
      <p class="text-gray-500 dark:text-gray-400">
        服务器已放通的本机直连端口：
        <span v-if="loading">加载中…</span>
        <span v-else-if="policy.allowedPorts.length" class="font-mono">
          {{ policy.allowedPorts.join(', ') }}
        </span>
        <span v-else>无</span>
        <span v-if="!loading && !policy.proxyRequired">（本服务器未强制代理）</span>
      </p>
      <p v-if="status.level === 'error'" class="text-red-500">
        <i class="fas fa-times-circle mr-1" />{{ status.message }}
      </p>
      <p v-else-if="status.level === 'warn'" class="text-amber-600 dark:text-amber-400">
        <i class="fas fa-exclamation-triangle mr-1" />{{ status.message }}
      </p>
      <p v-else-if="status.level === 'ok'" class="text-green-600">
        <i class="fas fa-check-circle mr-1" />{{ status.message }}
      </p>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import * as httpApis from '@/utils/http_apis'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  apiUrl: { type: String, default: '' }
})

defineEmits(['update:modelValue'])

const loading = ref(true)
const policy = ref({ proxyRequired: false, allowedPorts: [] })

onMounted(async () => {
  const res = await httpApis.getClaudeConsoleDirectLoopbackPolicyApi()
  if (res?.success && res.data) {
    policy.value = {
      proxyRequired: !!res.data.proxyRequired,
      allowedPorts: Array.isArray(res.data.allowedPorts) ? res.data.allowedPorts : []
    }
  }
  loading.value = false
})

const isLoopbackHost = (hostname) => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.')[0] === '127'
  }
  return host === '::1'
}

const status = computed(() => {
  let url
  try {
    url = new URL(props.apiUrl)
  } catch {
    return { level: 'error', message: '请先填写有效的 API URL' }
  }
  if (!['http:', 'https:'].includes(url.protocol) || !isLoopbackHost(url.hostname)) {
    return { level: 'error', message: 'API URL 不是 loopback 地址，不能直连（请使用 127.0.0.1）' }
  }
  if (loading.value) {
    return { level: '', message: '' }
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  const enforced = policy.value.proxyRequired || policy.value.allowedPorts.length > 0
  if (enforced && !policy.value.allowedPorts.includes(port)) {
    return {
      level: 'warn',
      message: `端口 ${port} 尚未在服务器放通，请求会被拒绝。需由服务器 root 把该端口加入直连端口列表并同步防火墙、重启服务后生效。`
    }
  }
  return { level: 'ok', message: `端口 ${port} 已放通，可直连` }
})
</script>
