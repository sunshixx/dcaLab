// 记账引擎：移动加权平均成本、已实现/未实现盈亏、XIRR、CSV 导入导出
//
// ── 口径说明 ──────────────────────────────────────────────
// 1. 移动加权平均成本（国内基金行业通行口径）：
//    买入：金额为实际扣款，手续费包含在金额内；
//      净值成本 += 金额 − 费用；含费现金成本 += 金额；
//      份额 += 份额或（金额 − 费用）/净值；净值均价 = 净值成本/份额
//    分红再投资：增加份额和成本，但不是外部投入，不计入 XIRR 外部现金流；
//    卖出：已实现盈亏 = （卖出金额 − 赎回费） − 卖出份额 × 卖出前均价；
//          总成本 -= 卖出份额 × 卖出前均价；份额 -= 卖出份额
// 2. XIRR（金额加权收益率，Excel XIRR 同一定义）：
//    求解 Σ CF_i / (1 + x)^(d_i/365) = 0，d_i 为第 i 笔现金流距首笔的天数。
//    牛顿迭代起步 0.1，失败则退化为 [−0.9999, 10] 区间二分。
//    组合视角现金流：买入为流出、卖出/现金分红为流入、期末市值计为当日流入。
// ──────────────────────────────────────────────────────────

const TX_TYPES = ['buy', 'sell', 'dividend_cash', 'dividend_reinvest', 'fee']

function sharesForBuy(tx) {
  if (tx.nav <= 0) return tx.shares > 0 ? tx.shares : 0
  const netShares = Math.max(0, tx.amount - tx.fee) / tx.nav
  const legacyGrossShares = tx.amount / tx.nav
  // 兼容旧记录：旧版本把实际扣款直接除以净值，手续费没有从份额中扣除。
  if (tx.shares <= 0 || (tx.fee > 0 && Math.abs(tx.shares - legacyGrossShares) < 1e-8)) return netShares
  return tx.shares
}

/**
 * 计算各基金持仓与收益（txs 需按 fund_code, date, id 升序传入）
 */
export function computeHoldings(txs) {
  const funds = new Map()
  const get = (code) => {
    if (!funds.has(code))
      funds.set(code, {
        fund_code: code,
        shares: 0,
        nav_cost: 0,
        total_cost: 0,
        realized_pl: 0,
        dividend_cash_total: 0,
        dividend_reinvest_total: 0,
        invested: 0, // 累计净投入（买入含费 − 卖出到手）
        contributed: 0, // 累计实际投入（买入/费用调整，不扣除卖出和分红）
        buy_count: 0,
        sell_count: 0
      })
    return funds.get(code)
  }
  for (const tx of txs) {
    const h = get(tx.fund_code)
    switch (tx.type) {
      case 'buy':
        h.nav_cost += tx.amount - tx.fee
        h.total_cost += tx.amount
        h.shares += sharesForBuy(tx)
        h.invested += tx.amount
        h.contributed += tx.amount
        h.buy_count++
        break
      case 'dividend_reinvest':
        h.nav_cost += tx.amount - tx.fee
        h.total_cost += tx.amount
        h.shares += sharesForBuy(tx)
        h.dividend_reinvest_total += tx.amount
        break
      case 'sell': {
        const avg = h.shares > 0 ? h.total_cost / h.shares : 0
        const navAvg = h.shares > 0 ? h.nav_cost / h.shares : 0
        const sellShares = tx.shares
        const proceeds = tx.amount - tx.fee
        h.realized_pl += proceeds - sellShares * avg
        h.nav_cost -= sellShares * navAvg
        h.total_cost -= sellShares * avg
        h.shares -= sellShares
        h.invested -= proceeds
        h.sell_count++
        break
      }
      case 'dividend_cash':
        h.dividend_cash_total += tx.amount
        h.invested -= tx.amount
        break
      case 'fee':
        h.total_cost += tx.fee > 0 ? tx.fee : tx.amount
        h.invested += tx.fee > 0 ? tx.fee : tx.amount
        h.contributed += tx.fee > 0 ? tx.fee : tx.amount
        break
    }
  }
  const rows = [...funds.values()].map((h) => ({
    ...h,
    // avg_cost 是不含手续费的基金单位成本；total_cost 保留含费现金成本用于收益计算。
    avg_cost: h.shares > 0 ? h.nav_cost / h.shares : 0,
    avg_cost_with_fee: h.shares > 0 ? h.total_cost / h.shares : 0
  }))
  return rows
}

export { sharesForBuy }

const DAY_MS = 86400000
const parseDate = (s) => new Date(s + 'T00:00:00')

/**
 * XIRR：flows = [{date:'YYYY-MM-DD', amount}]（投入为负、取回为正）
 * 无法求解（全同号等）返回 null
 */
export function xirr(flows) {
  const valid = flows.filter((f) => Number.isFinite(f.amount) && f.date)
  if (valid.length < 2) return null
  const t0 = parseDate(valid[0].date).getTime()
  const cf = valid.map((f) => ({
    t: (parseDate(f.date).getTime() - t0) / (365 * DAY_MS), // 年化时间（act/365）
    amount: f.amount
  }))
  const hasPos = cf.some((f) => f.amount > 0)
  const hasNeg = cf.some((f) => f.amount < 0)
  if (!hasPos || !hasNeg) return null

  const npv = (rate) => cf.reduce((s, f) => s + f.amount / Math.pow(1 + rate, f.t), 0)
  const dnpv = (rate) =>
    cf.reduce((s, f) => s - (f.t * f.amount) / Math.pow(1 + rate, f.t + 1), 0)

  // 牛顿迭代
  let r = 0.1
  for (let i = 0; i < 100; i++) {
    const v = npv(r)
    const d = dnpv(r)
    if (Math.abs(d) < 1e-12) break
    const next = r - v / d
    if (next <= -0.9999) {
      r = (r - 0.9999) / 2
      continue
    }
    if (Math.abs(next - r) < 1e-10) return next
    r = next
  }
  if (Number.isFinite(r) && r > -0.9999 && Math.abs(npv(r)) < 0.01) return r

  // 二分兜底
  let lo = -0.9999
  let hi = 10
  let flo = npv(lo)
  let fhi = npv(hi)
  if (flo * fhi > 0) return null
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    const fm = npv(mid)
    if (Math.abs(fm) < 1e-8) return mid
    if (flo * fm < 0) {
      hi = mid
      fhi = fm
    } else {
      lo = mid
      flo = fm
    }
  }
  return (lo + hi) / 2
}

/**
 * 组合 XIRR：期末市值作为当日流入追加
 */
export function portfolioXirr(txs, currentValues) {
  const flows = []
  for (const tx of txs) {
    if (tx.type === 'buy') flows.push({ date: tx.date, amount: -tx.amount })
    else if (tx.type === 'sell') flows.push({ date: tx.date, amount: tx.amount - tx.fee })
    else if (tx.type === 'dividend_cash') flows.push({ date: tx.date, amount: tx.amount })
    else if (tx.type === 'fee')
      flows.push({ date: tx.date, amount: -(tx.fee > 0 ? tx.fee : tx.amount) })
  }
  const totalNow = currentValues.reduce((s, c) => s + c.value, 0)
  if (totalNow > 0) {
    const today = new Date()
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate()
    ).padStart(2, '0')}`
    flows.push({ date: iso, amount: totalNow })
  }
  flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return xirr(flows)
}

// ── CSV ──────────────────────────────────────────────
const CSV_HEADERS = ['基金代码', '基金名称', '日期', '类型', '金额', '净值', '份额', '手续费', '备注']
const TYPE_CN = {
  buy: '买入',
  sell: '卖出',
  dividend_cash: '现金分红',
  dividend_reinvest: '分红再投',
  fee: '费用调整'
}
const CN_TYPE = Object.fromEntries(Object.entries(TYPE_CN).map(([k, v]) => [v, k]))

function csvEscape(v) {
  const s = String(v ?? '')
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export function exportCsv(funds, txs) {
  const nameOf = new Map(funds.map((f) => [f.code, f.name]))
  const lines = [CSV_HEADERS.join(',')]
  for (const tx of txs) {
    lines.push(
      [
        tx.fund_code,
        nameOf.get(tx.fund_code) || '',
        tx.date,
        TYPE_CN[tx.type] || tx.type,
        tx.amount,
        tx.nav,
        tx.shares,
        tx.fee,
        tx.note || ''
      ]
        .map(csvEscape)
        .join(',')
    )
  }
  // UTF-8 BOM，保证 Excel 正确识别中文
  return '\uFEFF' + lines.join('\r\n')
}

/** 极简 CSV 解析：支持引号包裹与转义 */
function parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQ = false
      } else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * 导入 CSV → 交易数组（未落库，供路由校验后批量插入）
 * 返回 { rows, errors }
 */
export function parseImportCsv(text) {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
  if (!clean) return { rows: [], errors: ['空文件'] }
  const lines = clean.split('\n').filter((l) => l.trim().length > 0)
  const rows = []
  const errors = []
  lines.forEach((line, idx) => {
    const cells = parseCsvLine(line)
    // 跳过表头（首行或任何以“基金代码”开头的行）
    if (idx === 0 && cells[0] === '基金代码') return
    if (!/^\d{6}$/.test(cells[0] || '')) {
      errors.push(`第 ${idx + 1} 行：基金代码须为 6 位数字`)
      return
    }
    const type = CN_TYPE[cells[3]] || cells[3]
    if (!TX_TYPES.includes(type)) {
      errors.push(`第 ${idx + 1} 行：未知交易类型 "${cells[3]}"`)
      return
    }
    const num = (v) => {
      const n = parseFloat(v)
      return Number.isFinite(n) ? n : 0
    }
    const date = (cells[2] || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push(`第 ${idx + 1} 行：日期格式应为 YYYY-MM-DD`)
      return
    }
    rows.push({
      fund_code: cells[0],
      date,
      type,
      amount: num(cells[4]),
      nav: num(cells[5]),
      shares: num(cells[6]),
      fee: num(cells[7]),
      note: (cells[8] || '').trim()
    })
  })
  return { rows, errors }
}

export { TX_TYPES }
