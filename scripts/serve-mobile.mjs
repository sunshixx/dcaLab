// 手机模式：构建前端 → 起预览服务（HTTPS，若存在自签证书）→ 打印手机可访问地址
//
// 后端复用策略：3001 上已经有服务（比如你正在跑 npm run dev）就直接用，
// 没有再自己起一个，避免端口冲突导致"预览页一片空白"。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4173
const API_PORT = 3001

const lanIps = Object.values(os.networkInterfaces())
  .flat()
  .filter((item) => item && item.family === 'IPv4' && !item.internal)
  .map((item) => item.address)

const https = fs.existsSync(path.join(root, 'frontend', '.cert', 'cert.pem'))
const scheme = https ? 'https' : 'http'

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    setTimeout(() => done(false), 800)
  })
}

const apiRunning = await portInUse(API_PORT)
const children = []

function run(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env })
  children.push(child)
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`子进程退出：${command} ${args.join(' ')}（code ${code}）`)
  })
  return child
}

function shutdown() {
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已经退出 */
    }
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

if (!apiRunning) {
  console.log('→ 3001 上没有后端，自动启动一个')
  run('npm', ['--prefix', 'backend', 'run', 'start'], root)
} else {
  console.log('→ 3001 上已有后端在跑，直接复用')
}

run('npm', ['--prefix', 'frontend', 'run', 'preview'], root)

const lines = ['', '手机模式已启动：', `  电脑：${scheme}://localhost:${PORT}`]
for (const ip of lanIps) lines.push(`  手机：${scheme}://${ip}:${PORT}`)
lines.push(
  '',
  https
    ? '  首次访问会提示证书不受信任（自签证书），选择“继续访问”即可。'
    : '  当前是 HTTP：iOS 可“添加到主屏幕”，Android 要完整安装请用 npm run mobile:https',
  '  手机需与电脑在同一个 Wi-Fi。Ctrl+C 停止。',
  ''
)
console.log(lines.join('\n'))
