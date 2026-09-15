// 复盘数据刷新服务：编排 skill 管线（优先） + 东方财富兜底
// 支持 CN（新浪行情）和 US（TradingView → 失败则东方财富日线）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { refreshUsReport as emFallback } from './usMarketFetcher.js'
import { attachNews } from './newsFetcher.js'
import { getCachedReport } from './reportCache.js'
import { saveReport } from './reportStore.js'
import { isChinaBusinessDay } from './chinaFixedIncome.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WS = process.env.WORKSPACE_ROOT || path.resolve(__dirname, '../../..')
const SKILL = path.join(WS, 'skills', 'generate-us-market-daily-review', 'scripts')
const REPORTS = path.join(WS, 'reports')

// ── 工具：调 WSL Python 跑脚本（CWD=工作区根，相对路径） ──
function runWSL(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'wsl.exe' : 'python3'
    const commandArgs = process.platform === 'win32' ? ['-d', 'Ubuntu', '--', 'python3', ...args] : args
    const p = spawn(command, commandArgs,
      { cwd: WS, stdio: 'ignore', timeout: timeoutMs })
    p.on('close', code => resolve(code === 0))
    p.on('error', () => resolve(false))
  })
}

function relPath(p) {
  return path.relative(WS, p).replace(/\\/g, '/')
}

// 百分数格式化（skill JSON 中 day_pct 已是百分比数值：1.23 = +1.23%）
const sp = v => v == null ? '—' : (Number(v) > 0 ? '+' : '') + Number(v).toFixed(2) + '%'

function indexMove(row) {
  if (row?.day_pct != null) return row.day_pct
  if (row?.session_pct != null) return row.session_pct
  return null
}

function indexOverview(rows) {
  return rows.map(row => `${row.name || row.ticker} ${sp(indexMove(row))}`).join('，')
}

function currentDate(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

// ── 填充 payload 中的 TODO 占位符（市场感知） ── 
function fillPayload(skeleton, market) {
  const d = JSON.parse(JSON.stringify(skeleton))

  // 指数 / 个股 comment
  for (const group of ['benchmark_kpis', 'key_stocks', 'sectors']) {
    for (const r of d[group] || []) {
      if (!r || typeof r !== 'object') continue
      const name = r.name || r.ticker || r.key || ''
      const close = r.close, dp = r.day_pct
      if (dp != null && close != null) {
        r.comment = `${name}收报${close}，当日${sp(dp)}。`
      } else if (r.comment && /TODO|待补充/.test(r.comment)) {
        r.comment = '价格数据缺失，走势待核验。'
      }
    }
  }

  // 异动股 category / driver
  for (const r of d.movers || []) {
    if (r.category && /TODO/.test(r.category)) r.category = '涨跌异动'
    if (r.driver && /TODO/.test(r.driver)) r.driver = '暂无可靠来源确认异动原因。'
  }

  // overview（如果是 TODO）
  if (/TODO/.test(d.overview_lead || '')) {
    if (market === 'cn') {
      d.overview_lead = '三大指数走势分化，板块轮动明显。'
      d.overview = '本报告由自动化管线生成，日线数据来自公开行情接口。叙事字段因未接入实时新闻源，以数据驱动概述替代。'
    } else {
      const spx = ((d.benchmark_kpis || []).find(r => r.ticker === 'SPX') || {})
      const ndx = ((d.benchmark_kpis || []).find(r => r.ticker === 'NDX') || {})
      d.overview_lead = `标普500${spx.day_pct != null ? sp(spx.day_pct) : '波动'}，纳斯达克100${ndx.day_pct != null ? sp(ndx.day_pct) : '波动'}；本报告由后台自动生成。`
      d.overview = d.overview_lead
    }
    d.benchmark_analysis = d.benchmark_analysis && /TODO/.test(d.benchmark_analysis) ? '三大指数日线走势总结。' : d.benchmark_analysis
    d.structure_analysis = d.structure_analysis && /TODO/.test(d.structure_analysis) ? '板块结构待完整数据管道填充。' : d.structure_analysis
  }

  // 数据缺口
  const gaps = d.data_gaps || []
  if (!d.market_news || !d.market_news.length) gaps.push('市场新闻：未取得足够可核验条目，本节为空。')
  if (!d.global_news || !d.global_news.length) gaps.push('国际新闻：未取得足够可核验条目，本节为空。')
  if (!d.voices || !d.voices.length) gaps.push('人物言论：后台未接入可核验原文抓取，本节为空。')
  d.data_gaps = gaps

  // 去所有占位符
  const raw = JSON.stringify(d)
  for (const bad of ['TODO', 'TBD', 'PLACEHOLDER', '待补充'])
    if (raw.includes(bad)) throw new Error(`残留占位符 ${bad} in payload`)

  return d
}

// ── 渲染（调 WSL Python render_market_review.py） ──
async function render(date, market) {
  const prefix = market === 'cn' ? 'cn_' : ''
  const payloadP = path.join(REPORTS, 'data', `${prefix}report_payload_${date}.json`)
  const htmlP = path.join(REPORTS, `${prefix}market_review_${date}.html`)
  const auditP = path.join(REPORTS, 'data', `${prefix}market_data_${date}.json`)
  fs.mkdirSync(path.dirname(payloadP), { recursive: true })
  
  const ok = await runWSL([
    relPath(path.join(SKILL, 'render_market_review.py')),
    '--input', relPath(payloadP), '--output', relPath(htmlP), '--audit-output', relPath(auditP), '--allow-draft'
  ])
  if (!ok || !fs.existsSync(auditP)) throw new Error('render failed')
  return { html: htmlP, audit: auditP }
}

// ── A股收盘闸门 ──
// 盘中抓取必然残缺：当日日K要收盘后才结算，缺它就算不出 day_pct（涨跌幅），
// 5 分K也只有开盘后的零头，涨跌排行与申万行业仍是前一交易日快照。
// 曾因此在 09:52 生成过一份涨跌幅全为 null 的报告，故在抓取前拦截。
const CN_CLOSE_TIME = '15:00'   // A股收盘
const CN_SETTLE_MINUTES = 35    // 留出日K结算与排行/行业快照刷新的时间

const cstParts = (d = new Date()) => {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d)
  const get = (t) => p.find((x) => x.type === t)?.value || ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: get('hour'), minute: get('minute') }
}

/**
 * 判断某日 A股报告是否已可安全生成（交易时段内不可）。
 * 非当前日期视为历史日期，一律放行（历史数据已结算）。
 * @returns {{allowed: boolean, reason?: string}}
 */
export function cnReportGate(date) {
  const now = cstParts()
  if (date !== now.date) return { allowed: true }

  const minutes = Number(now.hour) * 60 + Number(now.minute)
  const readyAt = 15 * 60 + CN_SETTLE_MINUTES
  // 周末/休市日：当天不会有新行情，但仍放行以便生成休市分支报告
  if (!isChinaBusinessDay(date)) return { allowed: true }
  if (minutes < readyAt) {
    const remain = readyAt - minutes
    return {
      allowed: false,
      reason: `A股尚未完成收盘结算（当前 ${now.hour}:${now.minute}，可用时间 ${CN_CLOSE_TIME} 后约 ${CN_SETTLE_MINUTES} 分钟）。`
        + `盘中抓取会因当日日K未生成而导致涨跌幅、异动股、板块快照全部缺失，`
        + `请约 ${Math.ceil(remain / 60)} 小时后再试，或传入历史日期。`
    }
  }
  return { allowed: true }
}

// ── CN 刷新（新浪行情，完全在沙箱内可达） ──
export async function refreshCN(date) {
  if (!date) {
    const cached = getCachedReport('cn')
    if (cached) return cached
  }
  // 未指定日期：在收盘闸门允许的前提下，向前探测最近可用交易日
  if (!date) {
    const now = new Date()
    for (const d of [0, 1, 2, 3, 4, 5, 6]) {
      const t = new Date(now)
      t.setDate(t.getDate() - d)
      const ds = t.toISOString().slice(0, 10)
      // 今天若还没收盘，直接跳过（否则会生成残缺报告并覆盖好的那份）
      if (!cnReportGate(ds).allowed) continue
      try {
        const test = await refreshCNDate(ds)
        if (test.ok) return test
      } catch {}
    }
    const gate = cnReportGate(cstParts().date)
    return { ok: false, error: gate.allowed ? '近7日均非交易日' : gate.reason }
  }
  // 显式指定日期时同样拦截（避免手动刷新写坏当日报告）
  const gate = cnReportGate(date)
  if (!gate.allowed) return { ok: false, error: gate.reason, blocked: true }
  return refreshCNDate(date)
}

async function refreshCNDate(date) {
  const sinaPath = path.join(REPORTS, 'data', `sina_cn_market_${date}.json`)
  const skeletonPath = path.join(REPORTS, 'data', `cn_report_payload_${date}.json`)
  const warnings = []

  // 1. 抓取新浪行情
  const fetchOk = await runWSL([
    relPath(path.join(SKILL, 'fetch_sina_cn_market.py')),
    '--date', date, '--output', relPath(sinaPath)
  ], 120000)
  if (!fetchOk || !fs.existsSync(sinaPath)) {
    return { ok: false, error: '新浪行情抓取失败', warnings }
  }

  // 2. 构建 payload 骨架
  const buildOk = await runWSL([
    relPath(path.join(SKILL, 'build_cn_payload_skeleton.py')),
    '--date', date, '--input', relPath(sinaPath), '--output', relPath(skeletonPath)
  ])
  if (!buildOk || !fs.existsSync(skeletonPath)) {
    return { ok: false, error: 'payload 骨架构建失败', warnings }
  }

  // 3. 填充叙事字段
  const skeleton = await attachNews(JSON.parse(fs.readFileSync(skeletonPath, 'utf8')), date, 'cn')
  const filled = fillPayload(skeleton, 'cn')
  
  // 补充 CN 特有：overview from sectors（若有）或从 benchmark 回退
  const cs = filled.cn_sectors || {}
  const top = (cs.top5 || []).slice(0, 2).map(r => `${r.name}(${sp(r.day_pct)})`).filter(s => !s.includes('null')).join('、')
  const bot = (cs.bottom5 || []).slice(0, 2).map(r => `${r.name}(${sp(r.day_pct)})`).filter(s => !s.includes('null')).join('、')
  const bps = indexOverview(filled.benchmark_kpis || [])
  if (top || bot) {
    filled.overview_lead = `${bps}。领涨：${top || '无'}；领跌：${bot || '无'}。`
    filled.structure_analysis = `涨幅前五：${(cs.top5||[]).slice(0,3).map(r=>r.name).join('、')||'暂无'}；跌幅前五：${(cs.bottom5||[]).slice(0,3).map(r=>r.name).join('、')||'暂无'}。`
  } else {
    filled.overview_lead = `${bps}。板块快照暂无可用数据，以上为指数实际涨跌。`
    filled.structure_analysis = '板块结构数据需最新交易日快照（新浪申万行业排名不含历史查询），本日仅含指数与个股日线。'
  }
  filled.overview = `${date} A股复盘。${filled.overview_lead} 数据源：新浪公开行情接口；新闻条目来自带日期约束的公开 RSS，人物言论暂未接入原文抓取。`
  filled.benchmark_analysis = `${bps}。`
  
  fs.writeFileSync(skeletonPath, JSON.stringify(filled, null, 2))

  // 4. 渲染
  const { audit } = await render(date, 'cn')
  saveReport('cn', date)
  return { ok: true, date, audit, warnings }
}

// ── US 刷新（优先 TradingView → 失败则东方财富） ──
export async function refreshUS(date) {
  if (!date) {
    const cached = getCachedReport('us')
    if (cached) return cached
    date = currentDate('America/New_York')
  }
  // 1. 尝试 TradingView 管线
  const tvCore = path.join(REPORTS, 'data', `tradingview_rth_${date}.json`)
  const tvSector = path.join(REPORTS, 'data', `tradingview_sector_${date}.json`)
  
  let tvOk = false
  try {
    // 尝试抓取 SPX, NDX, SPY, QQQ + stocks
    const [coreOk, secOk] = await Promise.all([
      runWSL([relPath(path.join(SKILL, 'fetch_tradingview_rth.py')), '--date', date, '--output', relPath(tvCore),
        '--symbols', 'SPX', 'NDX', 'SPY', 'QQQ', '--watchlist-part', 'stocks'], 30000),
      runWSL([relPath(path.join(SKILL, 'fetch_tradingview_rth.py')), '--date', date, '--output', relPath(tvSector),
        '--watchlist-part', 'sectors'], 30000)
    ])
    tvOk = coreOk && secOk && fs.existsSync(tvCore) && fs.statSync(tvCore).size > 500
  } catch { tvOk = false }

  if (tvOk) {
    // TradingView 成功 → 构建 payload
    const skeletonPath = path.join(REPORTS, 'data', `report_payload_${date}.json`)
    const buildOk = await runWSL([
      path.join(SKILL, 'build_payload_skeleton.py'),
      '--date', date,
      '--core', tvCore, '--benchmark', tvCore,
      '--sector', tvSector,
      '--output', skeletonPath
    ])
    if (buildOk && fs.existsSync(skeletonPath)) {
      const skeleton = await attachNews(JSON.parse(fs.readFileSync(skeletonPath, 'utf8')), date, 'us')
      const filled = fillPayload(skeleton, 'us')
      fs.writeFileSync(skeletonPath, JSON.stringify(filled, null, 2))
      const { audit } = await render(date, 'us')
      saveReport('us', date)
      return { ok: true, date, source: 'tradingview', audit }
    }
  }

  // 2. TradingView 失败 → 东方财富兜底
  console.log('[reviewRefresher] TradingView failed, falling back to East Money for', date)
  try {
    const result = await emFallback(date)
    saveReport('us', date)
    return { ok: true, date, source: 'eastmoney', ...result }
  } catch (e) {
    return { ok: false, date, source: 'eastmoney', error: e.message }
  }
}