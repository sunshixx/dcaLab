import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = process.argv[2]
const target = process.env.DB_PATH || path.join(root, 'backend', 'data', 'app.db')
if (!source) throw new Error('用法：node scripts/db-restore.mjs backup.db')
if (!fs.existsSync(source)) throw new Error(`备份不存在：${source}`)
fs.mkdirSync(path.dirname(target), { recursive: true })
if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.before-restore`)
fs.copyFileSync(path.resolve(source), target)
console.log(`数据库已恢复：${target}`)
