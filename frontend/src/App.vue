<script setup>
// 全局布局
</script>

<template>
  <div id="bz-header">
    <div class="logo">DCA</div>
    <div class="tagline">长期定投 · 收益与成本模拟 · 记账本</div>
  </div>
  <div id="bz-nav">
    <router-link to="/portfolio">持仓概览</router-link>
    <router-link to="/ledger">记账本</router-link>
    <router-link to="/">模拟器</router-link>
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
