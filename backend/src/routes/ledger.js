// 记账：基金、交易流水、持仓、统计（XIRR/走势）、CSV 导入导出
import { Router } from 'express'
import { sql } from '../models/db.js'
import { fundSchema, transactionSchema, importCsvSchema } from '../models/schemas.js'
import { computeHoldings, portfolioXirr, exportCsv, parseImportCsv, sharesForBuy } from '../services/bookkeeping.js'
import { fundSnapshot, navHistorySince } from '../services/marketData.js'

const r = Router()

const loadTxs = (fundCode) =>
  (fundCode
    ? sql.all('SELECT * FROM transactions WHERE fund_code = ? ORDER BY date ASC, id ASC', fundCode)
    : sql.all('SELECT * FROM transactions ORDER BY date ASC, id ASC')
  ).map((tx) =>
    tx.type === 'buy' || tx.type === 'dividend_reinvest' ? { ...tx, shares: sharesForBuy(tx) } : tx
  )

async function addAutomaticReinvestments(txs) {
  const codes = [...new Set(txs.filter((tx) => tx.type === 'buy').map((tx) => tx.fund_code))]
  const histories = await Promise.all(
    codes.map(async (code) => ({ code, rows: await navHistorySince(code, txs.filter((tx) => tx.fund_code === code)[0].date).catch(() => []) }))
  )
  const result = chronological(txs)
  let syntheticId = -1
  const events = histories
    .flatMap(({ code, rows }) => rows.filter((row) => row.dividend_per_share > 0).map((row) => ({ ...row, fund_code: code })))
    .sort((a, b) => a.date.localeCompare(b.date) || a.fund_code.localeCompare(b.fund_code))
  for (const event of events) {
    const hasExplicitDividend = result.some(
      (tx) => tx.fund_code === event.fund_code && tx.date === event.date && (tx.type === 'dividend_cash' || tx.type === 'dividend_reinvest')
    )
    if (hasExplicitDividend || event.nav <= 0) continue
    const before = result.filter((tx) => tx.fund_code === event.fund_code && tx.date < event.date)
    const holding = computeHoldings(before).find((row) => row.fund_code === event.fund_code)
    if (!holding || holding.shares <= 0) continue
    const amount = holding.shares * event.dividend_per_share
    result.push({
      id: syntheticId--,
      fund_code: event.fund_code,
      date: event.date,
      type: 'dividend_reinvest',
      amount,
      nav: event.nav,
      shares: amount / event.nav,
      fee: 0,
      note: '自动分红再投资',
      auto_reinvest: true
    })
    result.sort((a, b) => a.date.localeCompare(b.date) || (a.id || 0) - (b.id || 0))
  }
  return result
}

function chronological(txs) {
  return [...txs].sort((a, b) => a.date.localeCompare(b.date) || (a.id || 0) - (b.id || 0))
}

function hasEnoughShares(fundCode, candidate) {
  const txs = chronological([...loadTxs(fundCode), candidate])
  const holding = computeHoldings(txs).find((row) => row.fund_code === fundCode)
  return !!holding && holding.shares >= -1e-6
}

// ── 基金 ──
r.get('/funds', (_req, res) => {
  res.json(sql.all('SELECT code, name, type, note, created_at FROM funds ORDER BY code'))
})

r.post('/funds', async (req, res) => {
  const parsed = fundSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: '参数校验失败', issues: parsed.error.issues })
  const { code, name, type, note } = parsed.data
  let finalName = name
  let finalType = type || ''
  if (!finalName) {
    // 未提供名称时自动查询
    const snap = await fundSnapshot(code)
    if (!snap.found) return res.status(404).json({ error: '未查询到该基金代码，请确认后重试，或手动输入名称' })
    finalName = snap.info.name
    finalType = finalType || snap.info.type
  }
  sql.run(
    'INSERT INTO funds (code, name, type, note) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(code) DO UPDATE SET name = excluded.name, type = excluded.type, note = COALESCE(NULLIF(excluded.note, \'\'), funds.note)',
    code,
    finalName,
    finalType,
    note || ''
  )
  res.status(201).json({ code, name: finalName })
})

r.delete('/funds/:code', async (req, res) => {
  const code = req.params.code
  const has = sql.get('SELECT COUNT(*) AS n FROM transactions WHERE fund_code = ?', code)
  if (has.n > 0) return res.status(400).json({ error: '该基金仍有交易记录，请先清空记录' })
  const ret = sql.run('DELETE FROM funds WHERE code = ?', code)
  if (ret.changes === 0) return res.status(404).json({ error: '基金不存在' })
  res.json({ ok: true })
})

// ── 交易流水 ──
r.get('/transactions', async (req, res) => {
  res.json(await addAutomaticReinvestments(loadTxs(req.query.fund_code || null)))
})

r.post('/transactions', (req, res) => {
  const parsed = transactionSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: '参数校验失败', issues: parsed.error.issues })
  }
  const t = parsed.data
  const fund = sql.get('SELECT code FROM funds WHERE code = ?', t.fund_code)
  if (!fund) return res.status(400).json({ error: '请先添加该基金到记账本' })
  // 买入金额是实际扣款，手续费已包含在内，份额按扣除手续费后的金额推算
  if ((t.type === 'buy' || t.type === 'dividend_reinvest') && t.shares <= 0 && t.nav > 0) {
    if (t.amount < t.fee) return res.status(400).json({ error: '手续费不能高于实际扣款金额' })
    t.shares = (t.amount - t.fee) / t.nav
  }
  if (t.type === 'sell') {
    // 超卖校验：按交易日期重演，支持补录早于现有交易的历史卖出。
    if (!hasEnoughShares(t.fund_code, { ...t, id: Number.MAX_SAFE_INTEGER })) {
      return res.status(400).json({ error: `卖出份额超出当前持仓（可卖出份额不足）` })
    }
  }
  const ret = sql.run(
    'INSERT INTO transactions (fund_code, date, type, amount, nav, shares, fee, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    t.fund_code, t.date, t.type, t.amount, t.nav, t.shares, t.fee, t.note
  )
  res.status(201).json({ id: Number(ret.lastInsertRowid), ...t })
})

r.delete('/transactions/:id', (req, res) => {
  const ret = sql.run('DELETE FROM transactions WHERE id = ?', Number(req.params.id))
  if (ret.changes === 0) return res.status(404).json({ error: '记录不存在' })
  res.json({ ok: true })
})

// ── 持仓（附加最新估值）──
r.get('/holdings', async (_req, res) => {
  const txs = await addAutomaticReinvestments(loadTxs(null))
  const holdings = computeHoldings(txs)
  const enriched = await Promise.all(
    holdings.map(async (h) => {
      const snap = await fundSnapshot(h.fund_code)
      const nav = snap.valuation_nav ?? 0
      const value = nav > 0 ? h.shares * nav : 0
      return {
        ...h,
        fund_name: snap.info ? snap.info.name : '(未知基金)',
        latest_nav: nav,
        nav_date: snap.valuation_date,
        valuation_source: snap.valuation_source,
        nav_cost: round2(h.nav_cost),
        cash_cost: round2(h.total_cost),
        market_value: Math.round(value * 100) / 100,
        unrealized_pl: Math.round((value - h.total_cost) * 100) / 100,
        unrealized_pl_pct: h.total_cost > 0 ? (value - h.total_cost) / h.total_cost : 0
      }
    })
  )
  res.json(enriched)
})

// ── 组合统计：投入/市值/XIRR/各基金小计 ──
r.get('/stats', async (_req, res) => {
  const txs = await addAutomaticReinvestments(loadTxs(null))
  const computed = computeHoldings(txs)
  const snapShots = await Promise.all(computed.map((h) => fundSnapshot(h.fund_code)))
  const currentValues = computed.map((h, i) => {
    const nav = snapShots[i].valuation_nav ?? 0
    return { code: h.fund_code, value: nav > 0 ? h.shares * nav : 0 }
  })
  const totalInvested = computed.reduce((s, h) => s + h.invested, 0)
  const totalContributed = computed.reduce((s, h) => s + h.contributed, 0)
  const totalValue = currentValues.reduce((s, c) => s + c.value, 0)
  const totalCost = computed.reduce((s, h) => s + h.total_cost, 0)
  const realized = computed.reduce((s, h) => s + h.realized_pl, 0)
  const divCash = computed.reduce((s, h) => s + h.dividend_cash_total, 0)
  const divReinvest = computed.reduce((s, h) => s + h.dividend_reinvest_total, 0)
  const totalPl = totalValue - totalCost + realized + divCash + divReinvest
  res.json({
    total_invested: round2(totalInvested),
    total_contributed: round2(totalContributed),
    total_market_value: round2(totalValue),
    remaining_cost: round2(totalCost),
    remaining_nav_cost: round2(computed.reduce((s, h) => s + h.nav_cost, 0)),
    remaining_cash_cost: round2(totalCost),
    unrealized_pl: round2(totalValue - totalCost),
    realized_pl: round2(realized),
    dividend_cash_total: round2(divCash),
    dividend_reinvest_total: round2(divReinvest),
    total_pl: round2(totalPl),
    // 净投入已扣除卖出回款和现金分红；总盈亏中已包含全部手续费。
    simple_return: totalContributed > 0 ? totalPl / totalContributed : null,
    xirr: portfolioXirr(txs, currentValues),
    per_fund: computed.map((h, i) => ({
      fund_code: h.fund_code,
      fund_name: snapShots[i].info ? snapShots[i].info.name : '(未知基金)',
      invested: round2(h.invested),
      market_value: round2(currentValues[i].value),
      realized_pl: round2(h.realized_pl),
      unrealized_pl: round2(currentValues[i].value - h.total_cost)
    }))
  })
})

// ── 投入 vs 市值月度走势（历史净值回溯，尽力而为）──
r.get('/series', async (_req, res) => {
  const txs = await addAutomaticReinvestments(loadTxs(null))
  if (txs.length === 0) return res.json({ dates: [], invested: [], value: [] })
  const holdings = computeHoldings(txs)
  const firstDate = txs[0].date
  // 每只基金拉自首笔交易以来的净值序列（失败降级为仅交易日点位）
  const navSeries = await Promise.all(
    holdings.map(async (h) => {
      const rows = await navHistorySince(h.fund_code, firstDate).catch(() => [])
      return { code: h.fund_code, navs: rows }
    })
  )
  // 月度网格：首月至今每月 1 号
  const dates = []
  const start = new Date(firstDate + 'T00:00:00')
  start.setDate(1)
  const now = new Date()
  for (let d = new Date(start); d <= now; d.setMonth(d.getMonth() + 1)) {
    dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`)
  }
  const txSorted = [...txs].sort((a, b) => (a.date < b.date ? -1 : 1))
  const investedSeries = []
  const valueSeries = []
  for (const ds of dates) {
    let invested = 0
    let value = 0
    for (const h of holdings) {
      const hTxs = txSorted.filter((t) => t.fund_code === h.fund_code && t.date <= ds)
      for (const t of hTxs) {
        if (t.type === 'buy') invested += t.amount
        else if (t.type === 'dividend_reinvest') invested += t.amount
        else if (t.type === 'sell') invested -= t.amount - t.fee
        else if (t.type === 'dividend_cash') invested -= t.amount
        else if (t.type === 'fee') invested += t.fee > 0 ? t.fee : t.amount
      }
      // 份额推演
      let shares = 0
      for (const t of hTxs) {
        if (t.type === 'buy' || t.type === 'dividend_reinvest') shares += sharesForBuy(t)
        else if (t.type === 'sell') shares -= t.shares
      }
      const nav = nearestNav(navSeries, h.fund_code, ds)
      if (nav > 0) value += shares * nav
    }
    investedSeries.push(round2(invested))
    valueSeries.push(round2(value))
  }
  res.json({ dates, invested: investedSeries, value: valueSeries })
})

function nearestNav(navSeries, code, dateStr) {
  const entry = navSeries.find((n) => n.code === code)
  if (!entry || entry.navs.length === 0) return 0
  // 净值升序，取 <= dateStr 的最近一条
  let lo = 0
  let hi = entry.navs.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (entry.navs[mid].date <= dateStr) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans >= 0 ? entry.navs[ans].nav : 0
}

// ── CSV ──
r.get('/export.csv', async (_req, res) => {
  const funds = sql.all('SELECT code, name FROM funds')
  const txs = await addAutomaticReinvestments(loadTxs(null))
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="dca-ledger.csv"')
  res.send(exportCsv(funds, txs))
})

r.post('/import.csv', async (req, res) => {
  const parsed = importCsvSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: '参数校验失败' })
  const { rows, errors: parseErrors } = parseImportCsv(parsed.data.csv)
  const errors = [...parseErrors]
  const inserted = []
  const rowsToInsert = [...rows].sort((a, b) => a.date.localeCompare(b.date))
  for (const row of rowsToInsert) {
    const checked = transactionSchema.safeParse(row)
    if (!checked.success) {
      errors.push(`基金 ${row.fund_code} ${row.date}：${checked.error.issues[0].message}`)
      continue
    }
    const rowTx = checked.data
    if ((rowTx.type === 'buy' || rowTx.type === 'dividend_reinvest') && rowTx.shares <= 0) {
      rowTx.shares = (rowTx.amount - rowTx.fee) / rowTx.nav
    }
    if (rowTx.type === 'sell' && !hasEnoughShares(rowTx.fund_code, { ...rowTx, id: Number.MAX_SAFE_INTEGER })) {
      errors.push(`基金 ${rowTx.fund_code} ${rowTx.date}：卖出份额超出当前持仓`)
      continue
    }
    const fund = sql.get('SELECT code FROM funds WHERE code = ?', rowTx.fund_code)
    if (!fund) {
      const snap = await fundSnapshot(rowTx.fund_code).catch(() => null)
      const name = snap && snap.info ? snap.info.name : rowTx.fund_code
      sql.run('INSERT OR IGNORE INTO funds (code, name) VALUES (?, ?)', rowTx.fund_code, name)
    }
    const ret = sql.run(
      'INSERT INTO transactions (fund_code, date, type, amount, nav, shares, fee, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      rowTx.fund_code, rowTx.date, rowTx.type, rowTx.amount, rowTx.nav, rowTx.shares, rowTx.fee, rowTx.note
    )
    inserted.push(Number(ret.lastInsertRowid))
  }
  res.json({ inserted: inserted.length, skipped: errors })
})

function round2(x) {
  return Math.round(x * 100) / 100
}

export default r
