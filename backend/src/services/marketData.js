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

// SSRF 加固：所有外部传入的基金代码必须恰为 6 位数字，
// URL 仅由校验后的字面量构造，杜绝代码注入任意 URL/路径。
const CODE_RE = /^\d{6}$/
function safeCode(code) {
  const c = String(code || '')
  if (!CODE_RE.test(c)) throw new Error('非法基金代码')
  return c
}

function cached(key, ttl, fn) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value)
  return fn().then(
    (v) => {
      cache.set(key, { at: Date.now(), value: v })
      return v
    },
    (err) => {
      // 失败缓存 30s，避免连环超时
      cache.set(key, { at: Date.now() - ttl + 30_000, value: null })
      return null
    }
  )
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
export async function fundInfo(rawCode) {
  const code = safeCode(rawCode)
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
  })
}

/** Provider B：历史净值（升序返回 {date, nav, acc}） */
export async function navHistory(rawCode, { pageSize = 30, pageIndex = 1 } = {}) {
  const code = safeCode(rawCode)
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
  })
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
export async function fundEstimate(rawCode) {
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
  })
}

/** Provider D：场内 ETF/LOF 现价（尽力而为，失败返回 null） */
export async function etfQuote(rawCode) {
  const code = safeCode(rawCode)
  return cached(`etf:${code}`, TTL.estimate, async () => {
    for (const prefix of ['1', '0']) {
      try {
        const url =
          `https://push2.eastmoney.com/api/qt/stock/get?secid=${prefix}.${encodeURIComponent(code)}` +
          `&fields=f43,f57,f58,f60,f86,f169,f170`
        const res = await fetchWithTimeout(url)
        if (!res.ok) continue
        const j = await res.json()
        const d = j && j.data
        if (!d || d.f43 === undefined || d.f43 === '-') continue
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
  })
}

function formatUnixSec(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function selectValuation(info, estimate) {
  if (estimate && Number.isFinite(estimate.estimated_nav) && estimate.estimated_nav > 0) {
    return { nav: estimate.estimated_nav, date: estimate.as_of || '', source: '盘中估算' }
  }
  if (info && Number.isFinite(info.nav) && info.nav > 0) {
    return { nav: info.nav, date: info.nav_date || '', source: '最近净值' }
  }
  return null
}

/** 组合查询：信息 + 最新单位净值估算（用于持仓估值）
 *  入口即归一化：parseInt 丢弃一切非数字内容，锚定正则确保恰为 6 位，
 *  后续所有 URL 仅由该字面量构造（防 SSRF：代码不可能携带路径/查询/协议成分）。 */
export async function fundSnapshot(rawCode) {
  const code = safeCode(rawCode)
  const [info, est] = await Promise.all([
    fundInfo(code).catch(() => null),
    fundEstimate(code)
  ])
  const valuation = selectValuation(info, est)
  return {
    code,
    found: !!info,
    info,
    // 持仓按基金单位净值估值；场内成交价不能替代单位净值，尤其不能用于场外/QDII。
    valuation_nav: valuation ? valuation.nav : null,
    valuation_date: valuation ? valuation.date : '',
    valuation_source: valuation ? valuation.source : null
  }
}
