// 记账：基金、交易流水、持仓、统计（XIRR/走势）、CSV 导入导出
import { Router } from 'express'
import { sql } from '../models/db.js'
import { fundSchema, transactionSchema, importCsvSchema } from '../models/schemas.js'
import { computeHoldings, portfolioXirr, exportCsv, parseImportCsv, sharesForBuy } from '../services/bookkeeping.js'
import { fundSnapshot, navHistorySince, usdcnyRate } from '../services/marketData.js'

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
  res.json(sql.all('SELECT code, name, type, note, market, currency, management_fee, custody_fee, subscription_fee, redemption_fee_tiers, created_at FROM funds ORDER BY code').map(parseFundProfile))
})

r.post('/funds', async (req, res) => {
  const parsed = fundSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: '参数校验失败', issues: parsed.error.issues })
  const parsedCode = parsed.data.code
  const code = /^\d{6}$/.test(parsedCode) ? parsedCode : parsedCode.toUpperCase()
  const { name, type, note, management_fee, custody_fee, subscription_fee, redemption_fee_tiers } = parsed.data
  const existed = sql.get('SELECT code FROM funds WHERE code = ?', code)
  let finalName = name
  let finalType = type || ''
  let market = /^\d{6}$/.test(code) ? 'CN_FUND' : 'US_ETF'
  let currency = market === 'US_ETF' ? 'USD' : 'CNY'
  const snap = await fundSnapshot(code).catch(() => null)
  if (snap) {
    market = snap.market || market
    currency = snap.currency || currency
  }
  if (!finalName) {
    // 未提供名称时自动查询
    if (!snap.found) return res.status(404).json({ error: '未查询到该基金代码，请确认后重试，或手动输入名称' })
    finalName = snap.info.name
    finalType = finalType || snap.info.type
    market = snap.market || market
    currency = snap.currency || currency
  }
  sql.run(
    'INSERT INTO funds (code, name, type, note, market, currency, management_fee, custody_fee, subscription_fee, redemption_fee_tiers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(code) DO UPDATE SET name = excluded.name, type = excluded.type, note = COALESCE(NULLIF(excluded.note, \'\'), funds.note), market = excluded.market, currency = excluded.currency, management_fee = excluded.management_fee, custody_fee = excluded.custody_fee, subscription_fee = excluded.subscription_fee, redemption_fee_tiers = excluded.redemption_fee_tiers',
    code,
    finalName,
    finalType,
    note || '',
    market,
    currency,
    management_fee,
    custody_fee,
    subscription_fee,
    JSON.stringify(redemption_fee_tiers)
  )
  res.status(existed ? 200 : 201).json({ code, name: finalName, updated: !!existed })
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

r.post('/transactions', async (req, res) => {
  const parsed = transactionSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: '参数校验失败', issues: parsed.error.issues })
  }
  const t = parsed.data
  const fund = sql.get('SELECT code, currency, redemption_fee_tiers FROM funds WHERE code = ?', t.fund_code)
  if (!fund) return res.status(400).json({ error: '请先添加该基金到记账本' })
  t.currency = fund.currency || t.currency
  if (t.currency === 'USD' && t.fx_rate <= 1) {
    t.fx_rate = await usdcnyRate({ fresh: true }).catch(() => null)
    if (!t.fx_rate) return res.status(503).json({ error: '实时美元汇率暂不可用，请稍后重试' })
  }
  if (t.price <= 0) t.price = t.nav
  if ((t.type === 'buy' || t.type === 'dividend_reinvest') && t.fee <= 0) {
    const profile = sql.get('SELECT subscription_fee FROM funds WHERE code = ?', t.fund_code)
    t.fee = Math.round(t.amount * (profile?.subscription_fee || 0) * 100) / 100
  }
  if (t.type === 'sell' && t.fee <= 0) {
    t.fee = calculateRedemptionFee(t.fund_code, t, parseTiers(fund.redemption_fee_tiers))
  }
  // 买入金额是实际扣款，手续费已包含在内，份额按扣除手续费后的金额推算
  if ((t.type === 'buy' || t.type === 'dividend_reinvest') && t.shares <= 0 && t.price > 0) {
    if (t.amount < t.fee) return res.status(400).json({ error: '手续费不能高于实际扣款金额' })
    t.shares = (t.amount - t.fee) / t.price
  }
  if (t.type === 'sell') {
    // 超卖校验：按交易日期重演，支持补录早于现有交易的历史卖出。
    if (!hasEnoughShares(t.fund_code, { ...t, id: Number.MAX_SAFE_INTEGER })) {
      return res.status(400).json({ error: `卖出份额超出当前持仓（可卖出份额不足）` })
    }
  }
  const ret = sql.run(
    'INSERT INTO transactions (fund_code, date, type, amount, nav, price, shares, fee, currency, fx_rate, premium_rate, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    t.fund_code, t.date, t.type, t.amount, t.nav, t.price, t.shares, t.fee, t.currency, t.fx_rate, t.premium_rate, t.note
  )
  res.status(201).json({ id: Number(ret.lastInsertRowid), ...t })
})

r.delete('/transactions/:id', (req, res) => {
  const ret = sql.run('DELETE FROM transactions WHERE id = ?', Number(req.params.id))
  if (ret.changes === 0) return res.status(404).json({ error: '记录不存在' })
  res.json({ ok: true })
})

// ── 模拟器上下文：当前持仓 + 最新估值 + 历史年化收益估计 ──
r.get('/simulation-context', async (_req, res) => {
  const txs = await addAutomaticReinvestments(loadTxs(null))
  const holdings = computeHoldings(txs).filter((h) => h.shares > 0)
  const funds = new Map(sql.all('SELECT code, name, management_fee, custody_fee, subscription_fee, redemption_fee_tiers FROM funds').map((f) => [f.code, f]))
  const since = new Date()
  since.setFullYear(since.getFullYear() - 3)
  const sinceDate = since.toISOString().slice(0, 10)
  const assets = await Promise.all(holdings.map(async (h) => {
    const [snapshot, history] = await Promise.all([
      fundSnapshot(h.fund_code, { fresh: true }),
      navHistorySince(h.fund_code, sinceDate).catch(() => [])
    ])
    const first = history.find((row) => row.nav > 0)
    const last = [...history].reverse().find((row) => row.nav > 0)
    const days = first && last ? Math.max(1, (new Date(last.date) - new Date(first.date)) / 86400000) : 0
    const annualReturn = first && last && days >= 180 ? Math.pow(last.nav / first.nav, 365 / days) - 1 : 0.07
    const fxRate = snapshot.currency === 'USD' ? await usdcnyRate({ fresh: true }).catch(() => null) : 1
    const nav = snapshot.valuation_nav > 0 ? snapshot.valuation_nav : h.avg_cost
    return {
      code: h.fund_code,
      name: snapshot.info?.name || funds.get(h.fund_code)?.name || h.fund_code,
      shares: h.shares,
      latest_nav: nav,
      nav_date: snapshot.valuation_date || '',
      valuation_source: snapshot.valuation_source || '',
      initial_value: Math.max(0, h.shares * nav),
      initial_cost: Math.max(0, h.total_cost / (fxRate || 1)),
      initial_investment: Math.max(0, h.total_cost),
      expected_return: Math.max(-0.5, Math.min(0.5, annualReturn)),
      management_fee: (funds.get(h.fund_code)?.management_fee || 0) + (funds.get(h.fund_code)?.custody_fee || 0),
      subscription_fee: funds.get(h.fund_code)?.subscription_fee || 0,
      redemption_fee_tiers: parseTiers(funds.get(h.fund_code)?.redemption_fee_tiers),
      buy_premium_rate: h.buy_premium_rate ?? 0,
      currency: snapshot.currency || 'CNY',
      fx_rate: fxRate,
      history_start: first?.date || '',
      history_end: last?.date || ''
    }
  }))
  res.json({ assets })
})

// ── 持仓（附加最新估值）──
r.get('/holdings', async (req, res) => {
  const fresh = req.query.refresh === '1'
  const txs = await addAutomaticReinvestments(loadTxs(null))
  const holdings = computeHoldings(txs)
  const enriched = await Promise.all(
    holdings.map(async (h) => {
      const snap = await fundSnapshot(h.fund_code, { fresh })
      const nav = snap.valuation_nav ?? 0
      const marketPrice = snap.quote_price ?? nav
      const fxRate = snap.currency === 'USD' ? (await usdcnyRate({ fresh }).catch(() => null)) || 7.1 : 1
      const value = marketPrice > 0 ? h.shares * marketPrice * fxRate : 0
      return {
        ...h,
        fund_name: snap.info ? snap.info.name : '(未知基金)',
        latest_nav: nav,
        market_price: snap.quote_price,
        nav_date: snap.valuation_date,
        valuation_source: snap.valuation_source,
        nav_premium_rate: h.buy_premium_rate,
        currency: snap.currency || 'CNY',
        fx_rate: fxRate,
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
r.get('/stats', async (req, res) => {
  const fresh = req.query.refresh === '1'
  const txs = await addAutomaticReinvestments(loadTxs(null))
  const computed = computeHoldings(txs)
  const snapShots = await Promise.all(computed.map((h) => fundSnapshot(h.fund_code, { fresh })))
  const currentValues = await Promise.all(computed.map(async (h, i) => {
    const snap = snapShots[i]
    const nav = snap.quote_price ?? snap.valuation_nav ?? 0
    const fxRate = snap.currency === 'USD' ? await usdcnyRate({ fresh }).catch(() => null) : 1
    return { code: h.fund_code, value: nav > 0 && fxRate ? h.shares * nav * fxRate : 0 }
  }))
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
        const amountCny = (amount) => amount * (t.currency === 'USD' ? t.fx_rate : 1)
        if (t.type === 'buy') invested += amountCny(t.amount)
        else if (t.type === 'dividend_reinvest') invested += amountCny(t.amount)
        else if (t.type === 'sell') invested -= amountCny(t.amount - t.fee)
        else if (t.type === 'dividend_cash') invested -= amountCny(t.amount)
        else if (t.type === 'fee') invested += amountCny(t.fee > 0 ? t.fee : t.amount)
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
      rowTx.shares = (rowTx.amount - rowTx.fee) / (rowTx.price || rowTx.nav)
    }
    if (rowTx.type === 'sell' && !hasEnoughShares(rowTx.fund_code, { ...rowTx, id: Number.MAX_SAFE_INTEGER })) {
      errors.push(`基金 ${rowTx.fund_code} ${rowTx.date}：卖出份额超出当前持仓`)
      continue
    }
    const fund = sql.get('SELECT code FROM funds WHERE code = ?', rowTx.fund_code)
    if (!fund) {
      const snap = await fundSnapshot(rowTx.fund_code).catch(() => null)
      const name = snap && snap.info ? snap.info.name : rowTx.fund_code
      sql.run(
        'INSERT OR IGNORE INTO funds (code, name, market, currency) VALUES (?, ?, ?, ?)',
        rowTx.fund_code,
        name,
        snap?.market || (/^\d{6}$/.test(rowTx.fund_code) ? 'CN_FUND' : 'US_ETF'),
        rowTx.currency
      )
    }
    const ret = sql.run(
      'INSERT INTO transactions (fund_code, date, type, amount, nav, price, shares, fee, currency, fx_rate, premium_rate, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      rowTx.fund_code, rowTx.date, rowTx.type, rowTx.amount, rowTx.nav, rowTx.price, rowTx.shares, rowTx.fee, rowTx.currency, rowTx.fx_rate, rowTx.premium_rate, rowTx.note
    )
    inserted.push(Number(ret.lastInsertRowid))
  }
  res.json({ inserted: inserted.length, skipped: errors })
})

function round2(x) {
  return Math.round(x * 100) / 100
}

function parseTiers(raw) {
  try {
    const tiers = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw
    return Array.isArray(tiers) ? tiers : []
  } catch {
    return []
  }
}

function parseFundProfile(row) {
  return { ...row, redemption_fee_tiers: parseTiers(row.redemption_fee_tiers) }
}

function calculateRedemptionFee(fundCode, sell, tiers) {
  if (!tiers.length || sell.shares <= 0 || sell.amount <= 0) return 0
  const lots = []
  for (const tx of loadTxs(fundCode)) {
    if (tx.type === 'buy' || tx.type === 'dividend_reinvest') lots.push({ date: tx.date, shares: sharesForBuy(tx) })
    if (tx.type === 'sell') {
      let remaining = tx.shares
      for (const lot of lots) {
        const used = Math.min(remaining, lot.shares)
        lot.shares -= used
        remaining -= used
        if (remaining <= 0) break
      }
    }
  }
  let remaining = sell.shares
  const price = sell.amount / sell.shares
  let fee = 0
  for (const lot of lots.filter((item) => item.shares > 0)) {
    if (remaining <= 0) break
    const used = Math.min(remaining, lot.shares)
    const days = Math.max(0, (new Date(`${sell.date}T00:00:00Z`) - new Date(`${lot.date}T00:00:00Z`)) / 86400000)
    const tier = tiers.find((item) => item.max_days == null || days < item.max_days)
    fee += used * price * (tier?.rate || 0)
    remaining -= used
  }
  return Math.round(fee * 100) / 100
}

export default r
