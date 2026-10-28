import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router.js'
import './assets/bugzilla.css'
// 移动端增强样式：只在 ≤700px 生效，桌面不受影响
import './assets/mobile.css'

createApp(App).use(createPinia()).use(router).mount('#app')

// 只在生产构建注册 Service Worker：开发模式的 HMR 会和缓存打架
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 注册失败不影响正常使用 */
    })
  })
}
