<script setup>
// 全局布局
import { onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

// 手机上导航条是横向滚动的：切页后把当前 tab 滚进可视区，
// 否则从主屏幕快捷方式直接进 /review 时，高亮项可能在屏幕外。
function revealActiveTab() {
  const nav = document.getElementById('bz-nav')
  if (!nav) return
  if (nav.scrollWidth <= nav.clientWidth + 1) return
  const active = nav.querySelector('a.router-link-active')
  if (!active) return
  active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
}

watch(() => route.path, () => requestAnimationFrame(revealActiveTab), { flush: 'post' })
onMounted(revealActiveTab)
</script>

<template>
  <div id="bz-header">
    <div class="logo">DCA</div>
    <div class="tagline">长期定投 · 目标配置 · 收益与成本模拟 · 记账本</div>
  </div>
  <div id="bz-nav">
    <router-link to="/">目标配置</router-link>
    <router-link to="/portfolio">持仓概览</router-link>
    <router-link to="/ledger">记账本</router-link>
    <router-link to="/simulator">模拟器</router-link>
    <router-link to="/compare">方案对比</router-link>
    <router-link to="/review">市场复盘</router-link>
  </div>
  <div id="bz-main">
    <router-view />
  </div>
  <footer id="bz-footer">
    本工具为模拟记账工具，不构成投资建议。行情数据来自东方财富公开接口，可能有延迟。
  </footer>
</template>
