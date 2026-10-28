// 生成本地 CA + 由它签发的服务器证书。
//
// 为什么不用"自签名证书"：自签名证书每台设备都不认，每次访问都要点"仍然前往"。
// 改成「本地 CA → 签发服务器证书」后，只要把 CA 在手机/电脑上装一次并信任，
// 之后同一个 CA 签的所有证书都不会再报警告。
//
// 产物（都在 frontend/.cert/，已 gitignore）：
//   ca.crt          本地根证书（安装到设备上）
//   ca.mobileconfig iOS 描述文件（内嵌 CA，一次点装）
//   cert.pem        服务器证书（含 CA 链，vite 用）
//   key.pem         服务器私钥
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'frontend', '.cert')
fs.mkdirSync(dir, { recursive: true })

const at = (name) => path.join(dir, name)
const caKey = at('ca.key')
const caCrt = at('ca.crt')
const srvKey = at('key.pem')
const srvCsr = at('server.csr')
const srvCrt = at('server.crt')
const chainCrt = at('cert.pem')
const extFile = at('server.ext')

const lanIps = Object.values(os.networkInterfaces())
  .flat()
  .filter((item) => item && item.family === 'IPv4' && !item.internal)
  .map((item) => item.address)

const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanIps.map((ip) => `IP:${ip}`)].join(',')

const openssl = (...args) => execFileSync('openssl', args, { stdio: 'pipe' })

// 1) 根证书（10 年，CA:TRUE）。已存在就复用，避免设备上装过的旧 CA 失效。
if (fs.existsSync(caKey) && fs.existsSync(caCrt)) {
  console.log('→ 复用已存在的本地 CA（frontend/.cert/ca.crt）')
} else {
  openssl(
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', caKey,
    '-out', caCrt,
    '-days', '3650',
    '-subj', '/CN=DCA-Lab Local CA/O=DCA-Lab',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign,digitalSignature'
  )
  console.log('→ 已生成新的本地 CA：frontend/.cert/ca.crt')
}

// 2) 服务器证书（由 CA 签发，825 天，Apple 对 TLS 证书的有效期上限）
fs.writeFileSync(
  extFile,
  [
    `subjectAltName=${san}`,
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth'
  ].join('\n')
)

openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', srvKey, '-out', srvCsr, '-subj', '/CN=DCA-Lab')
openssl(
  'x509', '-req', '-in', srvCsr,
  '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial',
  '-out', srvCrt, '-days', '825', '-extfile', extFile
)

// vite 需要 cert.pem 里同时含服务器证书和 CA，才能把完整链发给客户端
fs.writeFileSync(chainCrt, fs.readFileSync(srvCrt, 'utf8') + fs.readFileSync(caCrt, 'utf8'))

// 3) iOS 描述文件：内嵌 CA（DER），Safari 打开即可安装
const caDer = execFileSync('openssl', ['x509', '-in', caCrt, '-outform', 'der'], { stdio: 'pipe' })
const caBase64 = caDer.toString('base64')
const uuid = () => crypto.randomUUID().toUpperCase()

const mobileconfig = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>ca.crt</string>
      <key>PayloadContent</key>
      <data>${caBase64}</data>
      <key>PayloadDescription</key>
      <string>DCA-Lab 本地根证书（仅用于局域网访问本机服务）</string>
      <key>PayloadDisplayName</key>
      <string>DCA-Lab Local CA</string>
      <key>PayloadIdentifier</key>
      <string>local.dcalab.ca.${uuid()}</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${uuid()}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>安装后即可免警告访问 DCA-Lab 手机端</string>
  <key>PayloadDisplayName</key>
  <string>DCA-Lab 根证书</string>
  <key>PayloadIdentifier</key>
  <string>local.dcalab.profile</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${uuid()}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`
fs.writeFileSync(at('ca.mobileconfig'), mobileconfig, 'utf8')

for (const temp of [srvCsr, extFile]) fs.rmSync(temp, { force: true })

console.log('→ 服务器证书已由本地 CA 签发')
console.log(`   覆盖地址：localhost, 127.0.0.1${lanIps.length ? ', ' + lanIps.join(', ') : ''}`)
console.log('   有效期 825 天')
console.log('')
console.log('把这个 CA 装到手机上（只需一次），之后不会再提示证书问题：')
console.log('  iOS：Safari 打开 http://<电脑IP>:4180/ca.mobileconfig → 安装描述文件')
console.log('       再到 设置 → 通用 → 关于本机 → 证书信任设置 → 打开 DCA-Lab Local CA 开关')
console.log('  Android：浏览器打开 http://<电脑IP>:4180/ca.crt 下载')
console.log('       再到 设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书 → 选择下载的文件')
