import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = process.env.DB_PATH || path.join(root, 'backend', 'data', 'app.db')
const target = process.argv[2] || `app-backup-${new Date().toISOString().slice(0, 10)}.db`
if (!fs.existsSync(source)) throw new Error(`数据库不存在：${source}`)
fs.copyFileSync(source, path.resolve(target))
console.log(`数据库备份已写入：${path.resolve(target)}`)
