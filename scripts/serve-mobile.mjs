// 手机模式：构建前端 → 起预览服务（HTTPS，若已生成本地 CA 证书）→ 打印手机可访问地址
//
// 后端复用策略：3001 上已经有服务（比如你正在跑 npm run dev）就直接用，
// 没有再自己起一个，避免端口冲突导致"预览页一片空白"。
//
// 另外会在 4180 起一个纯 HTTP 的小服务，只为把根证书发给手机安装
// （HTTP 是为了不弹"不安全"提示，装完证书就再也不用了）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4173
const CA_PORT = 4180
const API_PORT = 3001
const certDir = path.join(root, 'frontend', '.cert')

const lanIps = Object.values(os.networkInterfaces())
  .flat()
  .filter((item) => item && item.family === 'IPv4' && !item.internal)
  .map((item) => item.address)

const https = fs.existsSync(path.join(certDir, 'cert.pem'))
const scheme = https ? 'https' : 'http'
const hostForPhone = lanIps[0] || 'localhost'

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

// ── 证书分发（仅 HTTPS 模式下需要）────────────────────────────
if (https) {
  const files = {
    '/ca.crt': { file: 'ca.crt', type: 'application/x-x509-ca-cert' },
    '/ca.mobileconfig': { file: 'ca.mobileconfig', type: 'application/x-apple-aspen-config' }
  }
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0]
    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px/1.6 -apple-system,sans-serif;padding:24px">' +
          '<h2>DCA-Lab 证书安装</h2>' +
          '<p><a href="/ca.mobileconfig">iOS：下载描述文件</a></p>' +
          '<p><a href="/ca.crt">Android：下载 CA 证书</a></p>' +
          '<p style="color:#666;font-size:14px">装完即可免警告访问，之后这个页面不用再打开。</p></body>'
      )
      return
    }
    const entry = files[pathname]
    if (!entry) {
      res.writeHead(404).end('not found')
      return
    }
    const full = path.join(certDir, entry.file)
    if (!fs.existsSync(full)) {
      res.writeHead(404).end('证书未生成，请先运行 npm run mobile:https')
      return
    }
    res.writeHead(200, {
      'Content-Type': entry.type,
      'Content-Disposition': `attachment; filename="${entry.file}"`
    })
    fs.createReadStream(full).pipe(res)
  })
  server.listen(CA_PORT, '0.0.0.0')
  children.push(server)
}

if (!apiRunning) {
  console.log('→ 3001 上没有后端，自动启动一个')
  run('npm', ['--prefix', 'backend', 'run', 'start'], root)
} else {
  console.log('→ 3001 上已有后端在跑，直接复用')
}

run('npm', ['--prefix', 'frontend', 'run', 'preview'], root)

const lines = ['', '手机模式已启动：', `  电脑：${scheme}://localhost:${PORT}`]
for (const ip of lanIps) lines.push(`  手机：${scheme}://${ip}:${PORT}`)
lines.push('')
if (https) {
  lines.push('如果手机第一次访问提示证书不受信任（只需处理一次）：')
  lines.push(`  1) 手机浏览器打开  http://${hostForPhone}:${CA_PORT}/`)
  lines.push('  2) iOS：安装描述文件 → 设置 → 通用 → 关于本机 → 证书信任设置 → 打开开关')
  lines.push('     Android：下载 ca.crt → 设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书')
  lines.push('  3) 之后重新打开上面的 https 地址，不会再提示')
} else {
  lines.push('当前是 HTTP（没有证书）：不会有任何警告，但 Android 无法“安装应用”')
  lines.push('想要可安装的 PWA，运行 npm run mobile:https')
}
lines.push('', '手机需与电脑在同一个 Wi-Fi。Ctrl+C 停止。', '')
console.log(lines.join('\n'))
