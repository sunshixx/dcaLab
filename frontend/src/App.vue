<script setup>
// 全局布局：Bugzilla 式顶部黑条 + 链接式 tab 导航
</script>

<template>
  <div id="bz-header">
    <div class="logo">DCA-Lab <span>— 定投成本实验室</span></div>
    <div class="tagline">长期定投 · 收益与成本模拟 · 记账本 | Bugzilla-style retro UI</div>
  </div>
  <div id="bz-nav">
    <router-link to="/">模拟器</router-link>
    <router-link to="/ledger">记账本</router-link>
    <router-link to="/portfolio">持仓概览</router-link>
    <router-link to="/compare">方案对比</router-link>
    <router-link to="/review">市场复盘</router-link>
  </div>
  <div id="bz-main">
    <router-view />
  </div>
  <footer id="bz-footer">
    本工具为教育用途的确定性模拟，不构成投资建议。费用与收益假设由用户设定；行情数据来自东方财富公开接口，可能有延迟。
  </footer>
</template>
