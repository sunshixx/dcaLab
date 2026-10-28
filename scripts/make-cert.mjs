// 生成手机模式（PWA）用的自签 HTTPS 证书。
//
// 浏览器只允许在 HTTPS（或 localhost）下注册 Service Worker，手机通过局域网 IP
// 访问时是 HTTP，必须换成 HTTPS 才能"安装"成 app。自签证书会有一次安全警告，
// 手动点"继续访问"即可；证书里已经把本机所有局域网 IP 写进 SAN。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'frontend', '.cert')
const certFile = path.join(dir, 'cert.pem')
const keyFile = path.join(dir, 'key.pem')

const lanIps = Object.values(os.networkInterfaces())
  .flat()
  .filter((item) => item && item.family === 'IPv4' && !item.internal)
  .map((item) => item.address)

if (lanIps.length === 0) {
  console.warn('未检测到局域网 IPv4 地址，证书只包含 localhost')
}

const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanIps.map((ip) => `IP:${ip}`)].join(',')

fs.mkdirSync(dir, { recursive: true })

execFileSync(
  'openssl',
  [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile,
    '-out', certFile,
    '-days', '825',
    '-subj', '/CN=DCA-Lab',
    '-addext', `subjectAltName=${san}`
  ],
  { stdio: 'pipe' }
)

console.log(`证书已生成：${certFile}`)
console.log(`覆盖地址：localhost, 127.0.0.1${lanIps.length ? ', ' + lanIps.join(', ') : ''}`)
