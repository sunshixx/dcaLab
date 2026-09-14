<script setup>
// ECharts 通用容器：复古哑光主题
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import * as echarts from 'echarts'
import { RETRO_COLORS } from '../chartTheme.js'

const props = defineProps({
  title: { type: String, default: '' },
  option: { type: Object, required: true },
  height: { type: String, default: '330px' }
})

const el = ref(null)
let chart = null

function baseOption(opt) {
  return {
    color: RETRO_COLORS,
    animationDuration: 300,
    grid: { left: 70, right: 24, top: 36, bottom: 42 },
    legend: { top: 4, textStyle: { fontSize: 11, fontFamily: 'Verdana' } },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#ffffcc',
      borderColor: '#999',
      textStyle: { color: '#000', fontSize: 12, fontFamily: 'Verdana' }
    },
    ...opt,
    xAxis: {
      axisLine: { lineStyle: { color: '#999' } },
      axisLabel: { fontSize: 11, color: '#333' },
      splitLine: { lineStyle: { color: '#eee' } },
      ...(opt.xAxis || {})
    },
    yAxis: {
      axisLine: { lineStyle: { color: '#999' } },
      axisLabel: { fontSize: 11, color: '#333' },
      splitLine: { lineStyle: { color: '#ddd' } },
      scale: true,
      ...(opt.yAxis || {})
    }
  }
}

onMounted(() => {
  chart = echarts.init(el.value)
  chart.setOption(baseOption(props.option))
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  chart && chart.dispose()
})
function onResize() {
  chart && chart.resize()
}
watch(
  () => props.option,
  (opt) => chart && chart.setOption(baseOption(opt), true),
  { deep: true }
)
</script>

<template>
  <div class="chart-box">
    <div v-if="title" class="chart-title">{{ title }}</div>
    <div ref="el" class="chart-body" :style="{ height, overflow: 'hidden' }"></div>
  </div>
</template>
