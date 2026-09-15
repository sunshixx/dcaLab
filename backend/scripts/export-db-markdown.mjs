// 把 SQLite 数据库导出为 Markdown（结构 + 数据）
//
// 用法:
//   node backend/scripts/export-db-markdown.mjs                      # 含全部数据 → docs/database-backup.md
//   node backend/scripts/export-db-markdown.mjs --schema-only        # 仅结构     → docs/database-schema.md
//   node backend/scripts/export-db-markdown.mjs --out <path> [--schema-only]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { DatabaseSync } = await import('node:sqlite')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'backend', 'data', 'app.db')

const argv = process.argv.slice(2)
const schemaOnly = argv.includes('--schema-only')
const outIdx = argv.indexOf('--out')
const OUT = outIdx >= 0 && argv[outIdx + 1]
  ? path.resolve(argv[outIdx + 1])
  : path.join(ROOT, 'docs', schemaOnly ? 'database-schema.md' : 'database-backup.md')

if (!fs.existsSync(DB_PATH)) {
  console.error(`找不到数据库: ${DB_PATH}`)
  process.exit(1)
}

const db = new DatabaseSync(DB_PATH)

// ── 转义 Markdown 表格单元格 ──
const cell = (v) => {
  if (v === null || v === undefined) return ''
  const s = String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}

function tableNames() {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)
}

function columns(t) {
  return db.prepare(`PRAGMA table_info(${t})`).all()
}

function indexes(t) {
  return db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`)
    .all(t)
}

function foreignKeys(t) {
  return db.prepare(`PRAGMA foreign_key_list(${t})`).all()
}

const lines = []
const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

lines.push(schemaOnly ? '# 数据库结构说明' : '# 数据库备份')
lines.push('')
lines.push(`> 由 \`backend/scripts/export-db-markdown.mjs\` 自动生成于 ${now}（Asia/Shanghai）`)
lines.push(`> 来源：\`${path.relative(ROOT, DB_PATH).replace(/\\/g, '/')}\``)
lines.push('')
if (!schemaOnly) {
  lines.push('> **本文件包含个人记账数据（持仓、交易金额与日期），请勿提交到公开仓库。**')
  lines.push('')
}

// ── 概览 ──
const tables = tableNames()
lines.push('## 概览')
lines.push('')
lines.push('| 表名 | 列数 | 行数 |')
lines.push('|---|---:|---:|')
for (const t of tables) {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
  lines.push(`| \`${t}\` | ${columns(t).length} | ${n} |`)
}
lines.push('')

// ── 迁移历史 ──
if (tables.includes('schema_migrations')) {
  const rows = db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all()
  if (rows.length) {
    lines.push('## 迁移历史')
    lines.push('')
    lines.push('| 版本 | 应用时间 |')
    lines.push('|---|---|')
    for (const r of rows) lines.push(`| ${cell(r.version)} | ${cell(r.applied_at)} |`)
    lines.push('')
  }
}

// ── 逐表：结构 ──
lines.push('## 表结构')
lines.push('')
for (const t of tables) {
  lines.push(`### \`${t}\``)
  lines.push('')
  lines.push('| 列名 | 类型 | 非空 | 默认值 | 主键 |')
  lines.push('|---|---|:--:|---|---|')
  for (const c of columns(t)) {
    lines.push(`| \`${c.name}\` | ${cell(c.type) || '—'} | ${c.notnull ? '✓' : ''} | ${cell(c.dflt_value) || '—'} | ${c.pk ? '✓' : ''} |`)
  }
  lines.push('')

  const idx = indexes(t)
  if (idx.length) {
    lines.push('索引：')
    lines.push('')
    for (const i of idx) lines.push(`- \`${i.name}\``)
    lines.push('')
  }

  const fks = foreignKeys(t)
  if (fks.length) {
    lines.push('外键：')
    lines.push('')
    for (const f of fks) lines.push(`- \`${f.from}\` → \`${f.table}.${f.to}\`（ON DELETE ${f.on_delete}）`)
    lines.push('')
  }
}

// ── 逐表：数据 ──
if (!schemaOnly) {
  lines.push('## 数据')
  lines.push('')
  for (const t of tables) {
    const cols = columns(t).map((c) => c.name)
    const rows = db.prepare(`SELECT * FROM ${t}`).all()
    lines.push(`### \`${t}\`（${rows.length} 行）`)
    lines.push('')
    if (!rows.length) {
      lines.push('_（无数据）_')
      lines.push('')
      continue
    }
    lines.push('| ' + cols.join(' | ') + ' |')
    lines.push('|' + cols.map(() => '---').join('|') + '|')
    for (const r of rows) lines.push('| ' + cols.map((c) => cell(r[c])).join(' | ') + ' |')
    lines.push('')
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(`${schemaOnly ? '结构' : '备份'}已导出: ${OUT} (${fs.statSync(OUT).size} 字节)`)
