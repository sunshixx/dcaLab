import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const root = path.dirname(fileURLToPath(import.meta.url))

// 手机要装成 PWA，浏览器要求 HTTPS。这里在 frontend/.cert 里找自签证书，
// 只在 preview（手机模式）启用；开发服务器仍然是纯 HTTP，桌面端不受影响。
const certFile = path.join(root, '.cert', 'cert.pem')
const keyFile = path.join(root, '.cert', 'key.pem')
const https =
  fs.existsSync(certFile) && fs.existsSync(keyFile)
    ? { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
    : undefined

const proxy = { '/api': 'http://127.0.0.1:3001' }

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // 监听所有网卡，手机在同一 Wi-Fi 下可直接访问电脑 IP
    host: true,
    proxy
  },
  preview: {
    port: 4173,
    host: true,
    https,
    proxy
  }
})
