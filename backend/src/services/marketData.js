// 行情服务：东方财富/天天基金公开接口的服务端代理（规避浏览器 CORS 与反爬 Referer 校验）
//
// 数据源分级（全部尽力而为，失败降级，绝不阻塞记账）：
//  A. 基金搜索（已验证可用）：名称/类型/最新净值
//     https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key={code}
//  B. 历史净值（记账按日期回查成交净值；需 Referer 头）
//     https://api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex=1&pageSize=N
// C. 盘中单位净值估算（JSONP；QDII 通常无估值）→ 失败返回 null
//     https://fundgz.1234567.com.cn/js/{code}.js
// D. 场内 ETF 现价（push2，尽力而为）→ 仅供独立行情展示，不作为基金持仓估值
//
// 缓存：基金信息/最新净值 5min，估值 60s，历史净值 1h。

const TTL = { info: 5 * 60_000, estimate: 60_000, navs: 3600_000 }
const cache = new Map() // key -> {at, value}
const pending = new Map() // key -> in-flight request

// 只允许六位中国基金代码或短美股 ticker，URL 仅由校验后的字面量构造。
const CODE_RE = /^(?:\d{6}|[A-Za-z]{1,8})$/
const CN_CODE_RE = /^\d{6}$/
function safeCode(code) {
  const c = String(code || '')
  if (!CODE_RE.test(c)) throw new Error('非法基金代码或 ticker')
  return CN_CODE_RE.test(c) ? c : c.toUpperCase()
}

function cached(key, ttl, fn, fresh = false) {
  const hit = cache.get(key)
  if (!fresh && hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value)
  if (pending.has(key)) return pending.get(key)
  const request = fn()
    .then((value) => {
      if (value != null) cache.set(key, { at: Date.now(), value })
      return value != null ? value : hit?.value ?? null
    })
    .catch(() => {
      // 刷新失败时保留上次成功值，避免页面在不同估值源之间跳变。
      return hit ? hit.value : null
    })
    .finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}

async function fetchWithTimeout(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...(opts.headers || {})
    } })
  } finally {
    clearTimeout(timer)
  }
}

/** Provider A：基金信息 + 最新净值 */
export async function fundInfo(rawCode, { fresh = false } = {}) {
  const code = safeCode(rawCode)
  if (!CN_CODE_RE.test(code)) return null
  return cached(`info:${code}`, TTL.info, async () => {
    const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(code)}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) throw new Error(`搜索接口 HTTP ${res.status}`)
    const data = await res.json()
    const hit = (data.Datas || []).find((d) => d.CODE === code && d.FundBaseInfo)
    if (!hit) throw new Error('未找到该基金代码')
    const b = hit.FundBaseInfo
    return {
      code,
      name: b.SHORTNAME || hit.NAME,
      type: b.FTYPE || '',
      nav: Number(b.DWJZ) || null,
      nav_date: b.FSRQ || '',
      company: b.JJGS || ''
    }
  }, fresh)
}

/** Provider B：历史净值（按日期降序返回 {date, nav, acc}） */
export async function navHistory(rawCode, { pageSize = 30, pageIndex = 1, fresh = false } = {}) {
  const code = safeCode(rawCode)
  if (!CN_CODE_RE.test(code)) return null
  return cached(`navs:${code}:${pageIndex}:${pageSize}`, TTL.navs, async () => {
    const url =
      `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${encodeURIComponent(code)}` +
      `&pageIndex=${pageIndex}&pageSize=${pageSize}`
    const res = await fetchWithTimeout(url, {
      headers: { Referer: `https://fundf10.eastmoney.com/jjjz_${code}.html` }
    })
    if (!res.ok) throw new Error(`历史净值接口 HTTP ${res.status}`)
    const data = await res.json()
    const list = (data.Data && data.Data.LSJZList) || []
    return list.map((r) => ({
      date: r.FSRQ,
      nav: Number(r.DWJZ),
      acc: Number(r.LJJZ),
      dividend_per_share: parseDividendPerShare(r.FHSP)
    }))
  }, fresh)
}

/** 只接受明确的“每 N 份派 X 元”格式，无法确认时返回 0，不从净值变化猜分红。 */
export function parseDividendPerShare(raw) {
  const text = String(raw || '').replace(/\s/g, '')
  const match = text.match(/每(\d+(?:\.\d+)?)份(?:基金份额)?派(?:发)?([0-9]+(?:\.[0-9]+)?)元/)
  if (!match) return 0
  const units = Number(match[1])
  const amount = Number(match[2])
  return units > 0 && amount > 0 ? amount / units : 0
}

/** 拉取自某日期以来的全部净值（自动翻页，最多 100 页 ≈ 3000 条） */
export async function navHistorySince(code, sinceDate) {
  const all = []
  for (let page = 1; page <= 100; page++) {
    const rows = await navHistory(code, { pageSize: 30, pageIndex: page })
    if (!rows || rows.length === 0) break
    all.push(...rows)
    const oldest = rows[rows.length - 1].date
    if (rows.length < 30 || oldest <= sinceDate) break
  }
  // 接口按日期降序返回，翻转为升序
  return all.reverse()
}

/** Provider C：场外基金盘中估值（尽力而为，失败返回 null） */
export async function fundEstimate(rawCode, { fresh = false } = {}) {
  const code = safeCode(rawCode)
  return cached(`est:${code}`, TTL.estimate, async () => {
    const url = `https://fundgz.1234567.com.cn/js/${encodeURIComponent(code)}.js`
    const res = await fetchWithTimeout(url, { headers: { Referer: 'https://fund.eastmoney.com/' } })
    if (!res.ok) return null
    const text = await res.text()
    const m = text.match(/jsonpgz\((\{.*\})\)/)
    if (!m) return null
    const j = JSON.parse(m[1])
    return {
      code,
      estimated_nav: Number(j.gsz),
      estimated_change_pct: Number(j.gszzl),
      as_of: j.gztime || '',
      yesterday_nav: Number(j.dwjz)
    }
  }, fresh)
}

/** Provider D：场内 ETF/LOF 现价（尽力而为，失败返回 null） */
export async function etfQuote(rawCode, { fresh = false } = {}) {
  const code = safeCode(rawCode)
  if (!CN_CODE_RE.test(code)) return null
  return cached(`etf:${code}`, TTL.estimate, async () => {
    const prefixes = code.startsWith('6') ? ['1'] : ['0', '1']
    for (const prefix of prefixes) {
      try {
        const url =
          `https://push2.eastmoney.com/api/qt/stock/get?secid=${prefix}.${encodeURIComponent(code)}` +
          `&fields=f43,f57,f58,f60,f86,f169,f170`
        const res = await fetchWithTimeout(url)
        if (!res.ok) continue
        const j = await res.json()
        const d = j && j.data
        if (!d || d.f43 === undefined || d.f43 === '-') continue
        if (String(d.f57 || '').padStart(6, '0') !== code) continue
        return {
          code,
          name: d.f58,
          price: d.f43 / 1000, // push2 价格字段为千分之一元
          prev_close: d.f60 / 1000,
          change_pct: d.f170 / 100,
          as_of: formatUnixSec(d.f86)
        }
      } catch {
        // 尝试下一个市场前缀
      }
    }
    return null
  }, fresh)
}

export async function etfHistoricalQuote(rawCode, date, { fresh = false } = {}) {
  const code = safeCode(rawCode)
  if (!CN_CODE_RE.test(code) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const market = code.startsWith('6') ? '1' : '0'
  const begin = date.replaceAll('-', '')
  return cached(`etf:${code}:${date}`, TTL.estimate, async () => {
    const url =
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${market}.${encodeURIComponent(code)}` +
      `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60` +
      `&klt=101&fqt=1&beg=${begin}&end=${begin}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) throw new Error(`历史行情接口 HTTP ${res.status}`)
    const data = await res.json()
    const row = data.data?.klines?.find((line) => String(line).startsWith(date))
    if (!row) return null
    const fields = row.split(',')
    const price = Number(fields[2])
    if (!Number.isFinite(price) || price <= 0) return null
    return { code, name: data.data.name || '', price, as_of: date }
  }, fresh)
}

/** Provider E：美股 ETF 价格（Yahoo chart；NAV 由供应商返回时才使用） */
export async function usQuote(rawTicker, { fresh = false, date = '' } = {}) {
  const ticker = safeCode(rawTicker)
  if (CN_CODE_RE.test(ticker)) return null
  const today = new Date().toISOString().slice(0, 10)
  const requestedDate = date && date !== today && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ''
  return cached(`us:${ticker}:${requestedDate || 'live'}`, TTL.estimate, async () => {
    const start = requestedDate ? Math.floor(Date.parse(`${requestedDate}T00:00:00Z`) / 1000) : 0
    const end = requestedDate ? start + 86400 : 0
    const query = requestedDate ? `period1=${start}&period2=${end}&interval=1d` : 'range=1d&interval=1m'
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${query}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) throw new Error(`美股行情接口 HTTP ${res.status}`)
    const result = (await res.json()).chart?.result?.[0]
    const meta = result?.meta
    const closes = result?.indicators?.quote?.[0]?.close || []
    const historicalClose = [...closes].reverse().find((value) => Number.isFinite(Number(value)))
    const price = Number(requestedDate ? historicalClose : meta?.regularMarketPrice || meta?.previousClose)
    if (!Number.isFinite(price) || price <= 0) return null
    return {
      code: ticker,
      name: meta.longName || meta.shortName || ticker,
      price,
      nav: Number(meta.navPrice) > 0 ? Number(meta.navPrice) : null,
      currency: meta.currency || 'USD',
      change_pct: Number(meta.previousClose) > 0 ? price / Number(meta.previousClose) - 1 : null,
      as_of: requestedDate || (meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : '')
    }
  }, fresh)
}

export async function usdcnyRate({ fresh = false, date = '' } = {}) {
  const today = new Date().toISOString().slice(0, 10)
  const requestedDate = date && date !== today && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ''
  return cached(`fx:USDCNY:${requestedDate || 'live'}`, TTL.estimate, async () => {
    const start = requestedDate ? Math.floor(Date.parse(`${requestedDate}T00:00:00Z`) / 1000) : 0
    const end = requestedDate ? start + 86400 : 0
    const query = requestedDate ? `period1=${start}&period2=${end}&interval=1d` : 'range=1d&interval=1m'
    const res = await fetchWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/CNY=X?${query}`)
    if (!res.ok) throw new Error(`汇率接口 HTTP ${res.status}`)
    const result = (await res.json()).chart?.result?.[0]
    const meta = result?.meta
    const closes = result?.indicators?.quote?.[0]?.close || []
    const historicalClose = [...closes].reverse().find((value) => Number.isFinite(Number(value)))
    const rate = Number(requestedDate ? historicalClose : meta?.regularMarketPrice || meta?.previousClose)
    if (!Number.isFinite(rate) || rate <= 0) return null
    return rate
  }, fresh)
}

function formatUnixSec(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 选择持仓估值口径。
 *
 * 返回的 `date` 恒为「已公布净值日期」，作为估值的基准日——它不会因为盘中估算
 * 是否可用而改变。盘中估算的时点单独放在 `estimateTime`。
 *
 * 此前把估算时点（"2026-09-15 15:00"）直接写进 date，导致同一个基金在
 * 「估算时点」与「最近净值日期」两个日期之间来回跳动。
 */
export function selectValuation(latest, estimate) {
  const hasNav = latest && Number.isFinite(latest.nav) && latest.nav > 0
  const navDate = hasNav ? latest.nav_date || '' : ''
  if (estimate && Number.isFinite(estimate.estimated_nav) && estimate.estimated_nav > 0) {
    return { nav: estimate.estimated_nav, date: navDate, estimateTime: estimate.as_of || '', source: '盘中估算' }
  }
  if (hasNav) {
    return { nav: latest.nav, date: navDate, estimateTime: '', source: '最近净值' }
  }
  return null
}

/** 组合查询：信息 + 最新单位净值估算（用于持仓估值）
 *  入口即归一化：parseInt 丢弃一切非数字内容，锚定正则确保恰为 6 位，
 *  后续所有 URL 仅由该字面量构造（防 SSRF：代码不可能携带路径/查询/协议成分）。 */
export async function fundSnapshot(rawCode, { fresh = false, date = '' } = {}) {
  const code = safeCode(rawCode)
  if (!CN_CODE_RE.test(code)) {
    const quote = await usQuote(code, { fresh, date }).catch(() => null)
    const fxRate = quote ? await usdcnyRate({ fresh, date }).catch(() => null) : null
    return {
      code,
      found: !!quote,
      info: quote ? { code, name: quote.name, type: 'US ETF', nav: quote.nav, nav_date: quote.as_of } : null,
      market: 'US_ETF',
      currency: 'USD',
      fx_rate: fxRate,
      quote_price: quote?.price ?? null,
      nav: quote?.nav ?? null,
      premium_rate: quote?.nav > 0 ? quote.price / quote.nav - 1 : null,
      valuation_nav: quote?.price ?? null,
      valuation_date: quote?.as_of || '',
      valuation_source: quote ? '美股实时价格' : null
    }
  }
  const today = new Date().toISOString().slice(0, 10)
  if (date && date !== today && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [info, navs, historicalQuote] = await Promise.all([
      fundInfo(code, { fresh }).catch(() => null),
      navHistory(code, { pageSize: 30, pageIndex: 1 }).catch(() => []),
      etfHistoricalQuote(code, date, { fresh }).catch(() => null)
    ])
    const navRow = (navs || []).find((row) => row.date <= date && row.nav > 0)
    const validQuote = historicalQuote && info && sameInstrumentName(info.name, historicalQuote.name) ? historicalQuote : null
    return {
      code,
      found: !!info,
      info,
      market: validQuote ? 'CN_ETF' : 'CN_FUND',
      currency: 'CNY',
      quote_price: validQuote?.price ?? null,
      premium_rate: validQuote && navRow ? validQuote.price / navRow.nav - 1 : null,
      valuation_nav: navRow?.nav ?? null,
      valuation_date: navRow?.date || '',
      valuation_source: navRow ? '历史净值' : null
    }
  }
  const [info, est, quote, navs] = await Promise.all([
    fundInfo(code, { fresh }).catch(() => null),
    fundEstimate(code, { fresh }),
    etfQuote(code, { fresh }),
    // 最新净值一律以「历史净值」接口为准（F10 专用接口，实测多轮返回一致）。
    // 搜索联想接口 fundsuggest 是多节点缓存的低优先级服务，同一代码会在相邻
    // 两个净值日之间回吐不同快照，这正是持仓日期跳动的根因。
    // 传 fresh 让「刷新」能立刻拿到刚公布的净值（该接口已实测稳定）。
    navHistory(code, { pageSize: 5, pageIndex: 1, fresh }).catch(() => null)
  ])
  const navRow = (navs || []).find((row) => row.nav > 0) || null
  // 历史净值接口不可用时才退回搜索接口的净值
  const latest = navRow ? { nav: navRow.nav, nav_date: navRow.date } : info
  const validQuote = quote && info && sameInstrumentName(info.name, quote.name) ? quote : null
  const valuation = selectValuation(latest, est)
  return {
    code,
    found: !!info,
    info: info && latest !== info ? { ...info, nav: latest?.nav ?? info.nav, nav_date: latest?.nav_date ?? info.nav_date } : info,
    market: validQuote ? 'CN_ETF' : 'CN_FUND',
    currency: 'CNY',
    quote_price: validQuote?.price ?? null,
    premium_rate: validQuote?.price > 0 && valuation?.nav > 0 ? validQuote.price / valuation.nav - 1 : null,
    // 持仓按基金单位净值估值；场内成交价不能替代场外基金单位净值。
    valuation_nav: valuation ? valuation.nav : null,
    valuation_date: valuation ? valuation.date : '',
    estimate_time: valuation ? valuation.estimateTime || '' : '',
    valuation_source: valuation ? valuation.source : null
  }
}

function sameInstrumentName(fundName, quoteName) {
  const normalize = (value) => String(value || '').replace(/[\s()（）-]/g, '').toLowerCase()
  const fund = normalize(fundName)
  const quote = normalize(quoteName)
  return !!fund && !!quote && (fund.includes(quote) || quote.includes(fund))
}
