/* DCA-Lab Service Worker
 *
 * 目的只有两个：
 *   1. 让"添加到主屏幕"后能像 app 一样启动（配合 manifest 的 standalone）
 *   2. 断网/弱网时至少能打开界面，不会白屏
 *
 * 策略：
 *   - 导航请求（打开页面）：网络优先，失败回退到缓存的 index.html
 *   - 静态资源（/assets、/icons）：缓存优先，后台更新
 *   - /api 请求：完全不碰，永远走网络（记账数据绝不能读到旧值）
 */

const CACHE = 'dca-shell-v1'
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // 行情与记账接口一律走网络，缓存会导致数据看起来"不更新"
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/index.html').then((hit) => hit || caches.match('/'))
      )
    )
    return
  }

  const isStatic =
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest'

  if (!isStatic) return

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit
      return fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone()
            caches.open(CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(() => hit)
    })
  )
})
