// SQLite 持久层（方案 / 基金 / 交易流水 / 市场报告）
// 使用 Node 24 内置的 node:sqlite（DatabaseSync）。所有外部输入一律通过
// 预编译参数绑定（?）传入，禁止字符串拼接 SQL。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })
const DB_PATH = path.join(DATA_DIR, 'app.db')

let DatabaseSync
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch {
  console.error('node:sqlite 不可用：请使用 Node.js >= 23.4（当前推荐 24.x）运行本服务')
  process.exit(1)
}

export const db = new DatabaseSync(DB_PATH)

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations')
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\', \'localtime\')))')
const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version))
const migrations = fs.readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()
for (const name of migrations) {
  const version = name.split('_', 1)[0]
  if (applied.has(version)) continue
  db.exec('BEGIN')
  try {
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'))
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
db.prepare('PRAGMA foreign_keys = ON').run()

// 预编译语句缓存 + 参数化查询封装
const stmtCache = new Map()
function stmt(sqlText) {
  if (!stmtCache.has(sqlText)) stmtCache.set(sqlText, db.prepare(sqlText))
  return stmtCache.get(sqlText)
}

export const sql = {
  all: (text, ...params) => stmt(text).all(...params),
  get: (text, ...params) => stmt(text).get(...params),
  run: (text, ...params) => stmt(text).run(...params)
}
