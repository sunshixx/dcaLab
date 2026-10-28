// 手机模式：构建前端 → 起预览服务（HTTPS，若已生成本地 CA 证书）→ 打印手机可访问地址
//
// 后端复用策略：3001 上已经有服务（比如你正在跑 npm run dev）就直接用，
// 没有再自己起一个，避免端口冲突导致"预览页一片空白"。
//
// 另外在 4180 起一个"HTTP/HTTPS 双协议"的小服务，只为把根证书发给手机安装。
// 双协议是因为部分 Safari 版本会把 http:// 强制升级成 https://，只跑 HTTP 会
// 报"无法与服务器建立安全连接"。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4173
const CA_PORT = 4180
const API_PORT = 3001
const certDir = path.join(root, 'frontend', '.cert')
const distDir = path.join(root, 'frontend', 'dist')

const lanIps = Object.values(os.networkInterfaces())
  .flat()
  .filter((item) => item && item.family === 'IPv4' && !item.internal)
  .map((item) => item.address)

const hasCert = fs.existsSync(path.join(certDir, 'cert.pem'))
const scheme = hasCert ? 'https' : 'http'
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

// ── 证书分发 ────────────────────────────────────────────────
if (hasCert) {
  // 同时放进 dist，这样 4173 站点也能直接下载（多一条备用路径）
  for (const name of ['ca.crt', 'ca.mobileconfig']) {
    const src = path.join(certDir, name)
    if (fs.existsSync(src) && fs.existsSync(distDir)) {
      fs.copyFileSync(src, path.join(distDir, name))
    }
  }

  const files = {
    '/ca.crt': { file: 'ca.crt', type: 'application/x-x509-ca-cert' },
    '/ca.mobileconfig': { file: 'ca.mobileconfig', type: 'application/x-apple-aspen-config' }
  }

  const handler = (req, res) => {
    const pathname = (req.url || '/').split('?')[0]
    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<body style="font:16px/1.7 -apple-system,sans-serif;padding:24px;max-width:560px">' +
          '<h2>DCA-Lab 证书安装</h2>' +
          '<p style="color:#666;font-size:14px">装一次，之后访问不再提示证书问题。</p>' +
          '<p><a href="/ca.mobileconfig">iPhone：下载描述文件</a></p>' +
          '<p><a href="/ca.crt">Android：下载 CA 证书</a></p>' +
          '<p style="color:#666;font-size:13px;margin-top:24px">装完即可关闭本页。</p>' +
          '</body>'
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
  }

  // 同一个端口同时接受明文 HTTP 和 TLS：按首字节是否为 TLS 握手（0x16）分流
  const httpServer = http.createServer(handler)
  const httpsServer = https.createServer(
    {
      key: fs.readFileSync(path.join(certDir, 'key.pem')),
      cert: fs.readFileSync(path.join(certDir, 'cert.pem'))
    },
    handler
  )
  // 注意：必须用 'readable' + read() 取首字节；用 'data' 事件会把已消费的数据丢掉，
  // 导致 TLS 握手收不到 ClientHello（表现为“无法与服务器建立安全连接”）。
  const sniffer = net.createServer((socket) => {
    socket.setTimeout(15_000, () => socket.destroy())
    socket.once('readable', () => {
      const chunk = socket.read()
      if (!chunk) return
      const target = chunk[0] === 0x16 ? httpsServer : httpServer
      socket.unshift(chunk)
      target.emit('connection', socket)
    })
  })
  sniffer.listen(CA_PORT, '0.0.0.0')
  children.push(sniffer, httpServer, httpsServer)
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
if (hasCert) {
  lines.push('手机第一次访问会提示证书不受信任（只需处理一次）：')
  lines.push(`  A. 浏览器打开  http://${hostForPhone}:${CA_PORT}/`)
  lines.push(`     （若提示“无法建立安全连接”，改开 https://${hostForPhone}:${CA_PORT}/ 并选择继续访问）`)
  lines.push(`  B. iOS：安装描述文件 → 设置 → 通用 → 关于本机 → 证书信任设置 → 打开 DCA-Lab Local CA`)
  lines.push(`     Android：下载 ca.crt → 设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书`)
  lines.push(`  C. 回到 ${scheme}://${hostForPhone}:${PORT}，不再提示`)
  lines.push('')
  lines.push(`  备用（4180 打不开时）：${scheme}://${hostForPhone}:${PORT}/ca.crt`)
  lines.push('    iOS 也可用该地址下载，若 Safari 显示成文本，请以 4180 入口为准。')
} else {
  lines.push('当前是 HTTP（没有证书）：不会有任何警告，但 Android 无法“安装应用”')
  lines.push('想要可安装的 PWA，运行 npm run mobile:https')
}
lines.push('', '手机需与电脑在同一个 Wi-Fi。Ctrl+C 停止。', '')
console.log(lines.join('\n'))
