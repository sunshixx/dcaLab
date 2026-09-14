import fs from 'node:fs'
import path from 'node:path'
import { sql } from '../models/db.js'

const ROOT = process.env.WORKSPACE_ROOT || path.resolve(import.meta.dirname, '../../..')
const REPORTS = process.env.REPORTS_DIR || path.join(ROOT, 'reports')
const DATA = path.join(REPORTS, 'data')

function htmlName(market, date) {
  return `${market === 'cn' ? 'cn_' : ''}market_review_${date}.html`
}

function auditName(market, date) {
  return `${market === 'cn' ? 'cn_' : ''}market_data_${date}.json`
}

function payloadName(market, date) {
  return `${market === 'cn' ? 'cn_' : ''}report_payload_${date}.json`
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function expiryFor(reportDate, market) {
  const next = addDays(reportDate, 1)
  const timeZone = market === 'cn' ? 'Asia/Shanghai' : 'America/New_York'
  const [year, month, day] = next.split('-').map(Number)
  const hour = 9
  const minute = market === 'cn' ? 0 : 30
  const target = Date.UTC(year, month - 1, day, hour, minute)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date(`${next}T12:00:00Z`))
  const offset = parts.find(part => part.type === 'timeZoneName')?.value?.match(/GMT([+-])(\d+)(?::(\d+))?$/)
  const offsetMinutes = offset ? (Number(offset[2]) * 60 + Number(offset[3] || 0)) * (offset[1] === '+' ? 1 : -1) : 0
  return new Date(target - offsetMinutes * 60 * 1000)
}

function auditFromFile(market, date) {
  const file = path.join(DATA, auditName(market, date))
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function saveReport(market, date) {
  const audit = auditFromFile(market, date)
  if (!audit) return false
  const payloadFile = path.join(DATA, payloadName(market, date))
  const payload = fs.existsSync(payloadFile) ? fs.readFileSync(payloadFile, 'utf8') : null
  const htmlPath = path.join(REPORTS, htmlName(market, date))
  const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : null
  sql.run(
    `INSERT INTO reports (market, report_date, generated_at, expires_at, audit_json, payload_json, html_path, html_content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(market, report_date) DO UPDATE SET
       generated_at = excluded.generated_at, expires_at = excluded.expires_at,
       audit_json = excluded.audit_json, payload_json = excluded.payload_json,
       html_path = excluded.html_path, html_content = excluded.html_content,
       updated_at = datetime('now', 'localtime')`,
    market, date, audit.generated_at || null, expiryFor(date, market).toISOString(), JSON.stringify(audit), payload, htmlPath, html,
  )
  return true
}

export function importLegacyReports() {
  for (const market of ['cn', 'us']) {
    let names = []
    try { names = fs.readdirSync(DATA) } catch { continue }
    const prefix = market === 'cn' ? 'cn_market_data_' : 'market_data_'
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue
      const date = name.slice(prefix.length, -'.json'.length)
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) saveReport(market, date)
    }
  }
}

export function listReports(market) {
  return sql.all(
    `SELECT report_date AS date, market, generated_at, audit_json
     FROM reports WHERE market = ? ORDER BY report_date DESC`, market,
  ).map(row => {
    const audit = JSON.parse(row.audit_json)
    return {
      date: row.date, market: row.market, report_type: audit.report_type || null,
      generated_at: row.generated_at, title: audit.title || null, html: htmlName(row.market, row.date),
    }
  })
}

export function readReport(market, date) {
  const row = sql.get('SELECT audit_json FROM reports WHERE market = ? AND report_date = ?', market, date)
  if (!row) return null
  return JSON.parse(row.audit_json)
}

export function readHtml(market, date) {
  const row = sql.get('SELECT html_content FROM reports WHERE market = ? AND report_date = ?', market, date)
  return row?.html_content || null
}

export function latestReport(market) {
  return sql.get(
    'SELECT market, report_date AS date, expires_at, audit_json, html_path FROM reports WHERE market = ? ORDER BY report_date DESC LIMIT 1',
    market,
  )
}
