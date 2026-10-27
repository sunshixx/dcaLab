<script setup>
// 复古方块进度条：细边框 + 实色填充 + 斜纹，跟 Bugzilla 风格一致
import { computed } from 'vue'

const props = defineProps({
  value: { type: Number, default: null }, // 0~1；null 表示无目标
  large: { type: Boolean, default: false }
})

const width = computed(() => {
  if (props.value == null || !Number.isFinite(props.value)) return '0%'
  return `${Math.max(0, Math.min(1, props.value)) * 100}%`
})

const state = computed(() => {
  if (props.value == null || !Number.isFinite(props.value)) return ''
  if (props.value > 1.001) return 'over'
  if (props.value >= 0.999) return 'full'
  return ''
})
</script>

<template>
  <span class="allocation-progress" :class="{ large }">
    <i :style="{ width }" :class="state"></i>
  </span>
</template>
