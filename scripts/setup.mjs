import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const envPath = path.join(root, '.env.local')
const proxyUrl = 'http://127.0.0.1:7897'

function portIsOpen(host, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port })
    socket.setTimeout(1200)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(false))
  })
}

fs.writeFileSync(envPath, `MARKET_PROXY_URL=${proxyUrl}\n`, 'utf8')
const reachable = await portIsOpen('127.0.0.1', 7897)
console.log(`已写入本地代理配置：${proxyUrl}`)
if (reachable) {
  console.log('代理端口 7897 可连接。')
} else {
  console.warn('警告：127.0.0.1:7897 当前不可连接，请启动 VPN 并确认 Mixed/HTTP 代理端口为 7897。')
}