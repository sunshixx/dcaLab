// 市场复盘汇总接口：读取 generate-us-market-daily-review 技能产出的审计 JSON / HTML
//
// 约定目录（可用环境变量 REPORTS_DIR 覆盖，默认为工作区根的 reports/）：
//   reports/data/cn_market_data_YYYY-MM-DD.json   A股审计 JSON（含全部摘要字段）
//   reports/data/market_data_YYYY-MM-DD.json      美股审计 JSON
//   reports/cn_market_review_YYYY-MM-DD.html      A股独立报告
//   reports/market_review_YYYY-MM-DD.html         美股独立报告
//
// 审计 JSON 由技能的 render_market_review.py 产出，本质是「payload 全字段 + 审计元数据」，
// 因此本接口无需再读 payload，直接以审计 JSON 作为摘要来源。
import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { refreshUsReport } from '../services/usMarketFetcher.js'
import { refreshCN, refreshUS } from '../services/reviewRefresher.js'
import { importLegacyReports, listReports, readHtml, readReport } from '../services/reportStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPORTS_DIR = process.env.REPORTS_DIR || path.resolve(__dirname, '../../../reports')
const HTML_RE = {
  cn: /^cn_market_review_(\d{4}-\d{2}-\d{2})\.html$/,
  us: /^market_review_(\d{4}-\d{2}-\d{2})\.html$/
}
const MARKETS = ['cn', 'us']

function safeMarket(m) {
  return MARKETS.includes(m) ? m : null
}

function htmlName(market, date) {
  return `${market === 'cn' ? 'cn_' : ''}market_review_${date}.html`
}

importLegacyReports()

const r = Router()

// 列出可用的复盘报告（仅元数据，不载入完整 payload）
r.get('/list', (_req, res) => {
  res.json({ cn: listReports('cn'), us: listReports('us') })
})

// 获取某日期的复盘摘要（默认最新一天）
r.get('/summary', (req, res) => {
  const market = safeMarket(req.query.market) || 'cn'
  const files = listReports(market)
  if (!files.length) return res.status(404).json({ error: '暂无复盘数据' })
  let date = req.query.date
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    date = files[0].date
  }
  const audit = readReport(market, date)
  if (!audit) return res.status(404).json({ error: `未找到 ${date} 的复盘数据` })
  audit.html = htmlName(market, date)
  res.json(audit)
})

// 提供独立 HTML 报告（新窗口查看完整报告）
r.get('/html/:name', (req, res) => {
  const name = req.params.name
  let market = null
  for (const m of MARKETS) {
    if (HTML_RE[m].test(name)) {
      market = m
      break
    }
  }
  if (!market) return res.status(400).json({ error: '非法文件名' })
  const date = name.match(/(\d{4}-\d{2}-\d{2})/)?.[1]
  const html = date ? readHtml(market, date) : null
  if (html) return res.type('html').send(html)
  const p = path.join(REPORTS_DIR, name)
  if (!fs.existsSync(p)) return res.status(404).json({ error: '报告文件不存在' })
  // 用 root + 文件名形式交给 send，避免 send 以 cwd 为 root 解析绝对路径导致 NotFound
  res.type('html').sendFile(name, { root: REPORTS_DIR })
})

// 触发 A股数据刷新（新浪行情 → build payload → fill → render）
r.post('/refresh/cn', async (req, res) => {
  const date = req.body && req.body.date
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: '需要有效日期 date=YYYY-MM-DD' })
  }
  try {
    const result = await refreshCN(date)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 触发美股数据刷新（优先 TradingView → 失败则东方财富日线兜底）
r.post('/refresh/us', async (req, res) => {
  const date = req.body && req.body.date
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: '需要有效日期 date=YYYY-MM-DD' })
  }
  try {
    const result = await refreshUS(date)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default r
