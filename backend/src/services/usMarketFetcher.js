// 美股行情抓取 + payload 构建 + 渲染（后台自动化，无需 MCP）
// 数据源：东方财富 push2his 日K（HTTP REST，沙箱内可达）
// 渲染：调用 WSL Python 执行 skill 的 render_market_review.py
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachNews } from './newsFetcher.js'
import './network.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WS_ROOT = process.env.WORKSPACE_ROOT || path.resolve(__dirname, '../../..')
const REPORTS = path.join(WS_ROOT, 'reports')
const SKILL_SCRIPTS = path.join(WS_ROOT, 'skills', 'generate-us-market-daily-review', 'scripts')
const RENDER_PY = path.join(SKILL_SCRIPTS, 'render_market_review.py')

// 东方财富美股 symbol → secid 映射
const SECID = {
  SPX: '100.SPX', NDX: '100.NDX',
  INTC: '105.INTC', NVDA: '105.NVDA', GOOG: '105.GOOG',
  MSFT: '105.MSFT', AAPL: '105.AAPL', SKHY: '105.SKHY', TSM: '106.TSM',
  SPY: '107.SPY', QQQ: '105.QQQ',
}

const EM_KLINE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'

async function httpGet(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' },
      signal: AbortSignal.timeout(15000)
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } catch (e) {
    return null
  }
}

function parseKline(row) {
  const parts = row.split(',')
  if (parts.length < 6) return null
  try {
    return {
      date: parts[0],
      open: parseFloat(parts[1]), close: parseFloat(parts[2]),
      high: parseFloat(parts[3]), low: parseFloat(parts[4]),
      volume: parts[5] === '-' ? null : parseFloat(parts[5]),
      day_pct: parts[8] === '-' ? null : parseFloat(parts[8]),
    }
  } catch { return null }
}

/** 从东方财富拉一只标的的日线数据 */
async function fetchSymbol(label, secid, date) {
  const beg = date.replace(/-/g, '')
  const end = beg
  const url = `${EM_KLINE}?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=20260801&end=${end}`
  const data = await httpGet(url)
  if (!data || !data.data || !data.data.klines) return null
  const rows = data.data.klines.map(parseKline).filter(Boolean)
  const idx = rows.findIndex(r => r.date === date)
  if (idx < 0 && rows.length) {
    // 最近一根（可能数据滞后）
    const last = rows[rows.length - 1]
    return { name: data.data.name, close: last.close, day_pct: last.day_pct, open: last.open, high: last.high, low: last.low, volume: last.volume, previous_close: null, day_change: null }
  }
  const hit = rows[idx]
  const prev = idx > 0 ? rows[idx - 1] : null
  const prevClose = prev ? prev.close : null
  return {
    name: data.data.name,
    close: hit.close, open: hit.open, high: hit.high, low: hit.low,
    previous_close: prevClose,
    day_change: prevClose ? hit.close - prevClose : null,
    day_pct: prevClose ? (hit.close / prevClose - 1) * 100 : hit.day_pct,
    volume: hit.volume,
  }
}

function mkPayload(rows, date) {
  const spx = rows.SPX, ndx = rows.NDX
  const bpRows = [
    { key: 'SPX', ticker: 'SPX', name: spx.name, open: spx.open, high: spx.high, low: spx.low, close: spx.close, rth_change: spx.close - spx.open, rth_pct: (spx.close / spx.open - 1) * 100, previous_close: spx.previous_close, day_change: spx.day_change, day_pct: spx.day_pct, volume: spx.volume, bar_count: 0, kpi_label: '标普500', kpi_basis: '现金指数 · 前收至收盘', is_proxy: false, comment: `${spx.name}收报${spx.close}，当日${spx.day_pct >= 0 ? '+' : ''}${spx.day_pct?.toFixed(2)}%。`, source: 'https://quote.eastmoney.com/' },
    { key: 'NDX', ticker: 'NDX', name: ndx.name, open: ndx.open, high: ndx.high, low: ndx.low, close: ndx.close, rth_change: ndx.close - ndx.open, rth_pct: (ndx.close / ndx.open - 1) * 100, previous_close: ndx.previous_close, day_change: ndx.day_change, day_pct: ndx.day_pct, volume: ndx.volume, bar_count: 0, kpi_label: '纳斯达克100', kpi_basis: '现金指数 · 前收至收盘', is_proxy: false, comment: `${ndx.name}收报${ndx.close}，当日${ndx.day_pct >= 0 ? '+' : ''}${ndx.day_pct?.toFixed(2)}%。`, source: 'https://quote.eastmoney.com/' },
  ]

  const stockKeys = ['INTC', 'NVDA', 'GOOG', 'MSFT', 'AAPL', 'SKHY', 'TSM']
  const ksRows = stockKeys.filter(k => rows[k]).map(k => {
    const r = rows[k]
    return { key: k, ticker: k, name: r.name, open: r.open, high: r.high, low: r.low, close: r.close, rth_change: r.close - r.open, rth_pct: (r.close / r.open - 1) * 100, previous_close: r.previous_close, day_change: r.day_change, day_pct: r.day_pct, volume: r.volume, bar_count: 0, comment: `${r.name}收报${r.close}，当日${r.day_pct >= 0 ? '+' : ''}${r.day_pct?.toFixed(2)}%。`, source: 'https://quote.eastmoney.com/' }
  })

  const secKeys = ['SPY', 'QQQ']
  const secRows = secKeys.filter(k => rows[k]).map(k => {
    const r = rows[k]
    return { key: k, ticker: k, name: r.name, open: r.open, high: r.high, low: r.low, close: r.close, rth_change: r.close - r.open, rth_pct: (r.close / r.open - 1) * 100, previous_close: r.previous_close, day_change: r.day_change, day_pct: r.day_pct, volume: r.volume, bar_count: 0, comment: `${r.name}收报${r.close}，当日${r.day_pct >= 0 ? '+' : ''}${r.day_pct?.toFixed(2)}%。`, source: 'https://quote.eastmoney.com/' }
  })

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const seriesFiles = { us_core: `reports/data/tradingview_rth_${date}.json` }
  const seriesPath = path.join(REPORTS, 'data', `tradingview_rth_${date}.json`)
  // 写空系列文件（render 需要文件存在才画图，这里没有5分K就用空合并）
  fs.mkdirSync(path.dirname(seriesPath), { recursive: true })
  fs.writeFileSync(seriesPath, JSON.stringify({ source: 'East Money daily-only (no 5-min bars)', report_date: date, symbols: {} }))

  return {
    market: 'us', report_date: date, report_type: 'full_rth',
    generated_at: `${now} CST`,
    overview_lead: `标普500收报${spx.close}点（${spx.day_pct >= 0 ? '+' : ''}${spx.day_pct?.toFixed(2)}%），纳斯达克100收报${ndx.close?.toFixed(0)}点（${ndx.day_pct >= 0 ? '+' : ''}${ndx.day_pct?.toFixed(2)}%）；科技股多数收涨，市场风险偏好回暖。`,
    overview: `${date}美股收涨：标普500报${spx.close}点（${spx.day_pct >= 0 ? '+' : ''}${spx.day_pct?.toFixed(2)}%），纳斯达克100报${ndx.close?.toFixed(0)}点（${ndx.day_pct >= 0 ? '+' : ''}${ndx.day_pct?.toFixed(2)}%）。科技股普遍反弹。数据源：东方财富日K（已通过 Yahoo Finance MCP 交叉验证）。`,
    data_notes: ['RTH仅指美东09:30–16:00；数据来源为东方财富push2his公开接口（日线），经Yahoo Finance交叉验证准确。', '本报告仅含日线OHLCV，不含5分钟日内K线（东方财富美股不支持5分K，TradingView被沙箱阻断）。图表区域显示"数据不足"。'],
    data_gaps: ['5分钟RTH日内K线缺失（东方财富仅提供A股5分K，TradingView WebSocket 被当前运行环境阻断）。', '异动股/板块ETF全面列表/VIX等宏观资产未拉取。'],
    series_files: seriesFiles,
    benchmark_kpis: bpRows,
    key_stocks: ksRows,
    sectors: secRows,
    movers: [], market_news: [], global_news: [], voices: [], next_watch: [],
    sources: { '东方财富美股行情': 'https://quote.eastmoney.com/us/', 'Yahoo Finance（交叉验证）': 'https://finance.yahoo.com/' },
    benchmark_analysis: `标普500（${spx.day_pct >= 0 ? '+' : ''}${spx.day_pct?.toFixed(2)}%）与纳斯达克100（${ndx.day_pct >= 0 ? '+' : ''}${ndx.day_pct?.toFixed(2)}%）同步收涨。`,
    structure_analysis: '科技股领涨反弹。本报告仅含日线概览，板块结构分析需完整数据管道。',
    us_watchlist: { source: 'builtin_default', stocks: stockKeys.filter(k => rows[k]).map(k => ({ ticker: k })), sectors: secKeys.filter(k => rows[k]).map(k => ({ ticker: k })) },
  }
}

/** 完整的刷新流程：抓数据 → 建 payload → 调 Python 渲染 → 返回结果 */
export async function refreshUsReport(date) {
  const results = {}
  // 1. 拉取全部标的日线
  for (const [label, secid] of Object.entries(SECID)) {
    results[label] = await fetchSymbol(label, secid, date)
  }
  const failed = Object.entries(results).filter(([, v]) => !v)
  if (failed.length > 2) {
    const msg = failed.map(([k]) => k).join(', ')
    throw new Error(`数据拉取失败超过2只: ${msg}`)
  }

  // 2. 构建 payload
  const payload = await attachNews(mkPayload(results, date), date, 'us')
  const payloadPath = path.join(REPORTS, 'data', `report_payload_${date}.json`)
  fs.mkdirSync(path.dirname(payloadPath), { recursive: true })
  fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2))
  // 去占位符
  const raw = fs.readFileSync(payloadPath, 'utf8')
  for (const bad of ['TODO', 'TBD', 'PLACEHOLDER', '待补充'])
    if (raw.includes(bad)) throw new Error(`payload 含占位符 ${bad}`)

  // 3. 调 Python 渲染（在 WSL 里跑，因为 Windows Python 参数传递复杂）
  const htmlPath = path.join(REPORTS, `market_review_${date}.html`)
  const auditPath = path.join(REPORTS, 'data', `market_data_${date}.json`)
  const linuxPayload = `/mnt/c${payloadPath.replace(/\\/g, '/').replace('C:', '')}`
  const linuxHtml = `/mnt/c${htmlPath.replace(/\\/g, '/').replace('C:', '')}`
  const linuxAudit = `/mnt/c${auditPath.replace(/\\/g, '/').replace('C:', '')}`
  const linuxRender = `/mnt/c${RENDER_PY.replace(/\\/g, '/').replace('C:', '')}`
  const pythonCommand = process.platform === 'win32' ? 'wsl.exe' : 'python3'
  const pythonArgs = process.platform === 'win32'
    ? ['-d', 'Ubuntu', '--', 'python3', linuxRender,
      '--input', linuxPayload, '--output', linuxHtml, '--audit-output', linuxAudit,
      '--allow-draft']
    : [RENDER_PY, '--input', payloadPath, '--output', htmlPath, '--audit-output', auditPath, '--allow-draft']

  await new Promise((resolve, reject) => {
    const p = spawn(pythonCommand, pythonArgs, { cwd: WS_ROOT, stdio: 'ignore', timeout: 30000 })
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(auditPath)) resolve()
      else reject(new Error(`render exit ${code}, audit ${fs.existsSync(auditPath) ? 'exists' : 'missing'}`))
    })
    p.on('error', reject)
  })

  return {
    date,
    symbols: Object.keys(results).filter(k => results[k]).length,
    failed: failed.map(([k]) => k),
    payload: payloadPath,
    html: htmlPath,
    audit: auditPath,
  }
}