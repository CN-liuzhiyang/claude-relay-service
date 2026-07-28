<template>
  <div class="flex items-center gap-2">
    <!-- 下拉选择模式 -->
    <select
      v-if="!customMode"
      class="flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
      :disabled="disabled"
      :value="modelValue"
      @change="handleSelectChange"
    >
      <option v-for="m in models" :key="m.value" :value="m.value">
        {{ m.label }}
      </option>
      <optgroup v-if="customOptions.length > 0" label="最近使用的自定义模型">
        <option v-for="m in customOptions" :key="`custom-${m}`" :value="m">
          {{ m }}
        </option>
      </optgroup>
      <option value="__custom__">自定义模型...</option>
    </select>

    <!-- 自定义输入模式 -->
    <template v-else>
      <input
        class="flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 placeholder-gray-400 transition focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:placeholder-gray-500"
        :disabled="disabled"
        :placeholder="placeholder"
        type="text"
        :value="modelValue"
        @input="$emit('update:modelValue', $event.target.value)"
      />
      <button
        class="flex-shrink-0 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-500 transition hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600"
        :disabled="disabled"
        title="返回列表"
        @click="exitCustomMode"
      >
        <i class="fas fa-list text-[10px]" />
      </button>
    </template>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  models: { type: Array, default: () => [] },
  // 自定义模型的最近使用列表，作为下拉里的一个分组展示
  customOptions: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
  placeholder: { type: String, default: '输入模型 ID...' }
})

const emit = defineEmits(['update:modelValue'])

const customMode = ref(false)

// 当前值是否属于下拉里已有的选项
const isKnownOption = (value) =>
  props.models.some((m) => m.value === value) || props.customOptions.includes(value)

// 外部传入一个不在列表里的模型（例如从记忆恢复的自定义模型）时，
// 自动切到输入模式并回填，避免下拉显示空白
watch(
  () => [props.modelValue, props.models, props.customOptions],
  () => {
    if (props.modelValue && !isKnownOption(props.modelValue)) {
      customMode.value = true
    }
  },
  { immediate: true, deep: true }
)

const handleSelectChange = (e) => {
  if (e.target.value === '__custom__') {
    customMode.value = true
    emit('update:modelValue', '')
  } else {
    emit('update:modelValue', e.target.value)
  }
}

const exitCustomMode = () => {
  customMode.value = false
  // 切回列表时选中第一个预设模型
  if (props.models.length > 0) {
    emit('update:modelValue', props.models[0].value)
  }
}
</script>
