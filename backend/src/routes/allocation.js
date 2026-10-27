// 目标配置：计划比例维护 + 按记账本真实数据计算投入进度
//
// 读接口：
//   GET /api/allocation/plan                 当前计划（类别、比例、手工标的、自动类型）
//   GET /api/allocation/overview[?refresh=1] 计划 vs 实际（实时估值，用于再平衡）
// 写接口：
//   PUT /api/allocation/plan                 整体覆盖保存（事务内重建类别与映射）
import { Router } from 'express'
import { db, sql } from '../models/db.js'
import { allocationPlanSchema } from '../models/schemas.js'
import { computeHoldings } from '../services/bookkeeping.js'
import { addAutomaticReinvestments, loadTxs, MANUAL_ASSET_TYPES, latestManualPrice } from '../services/ledgerData.js'
import { fundSnapshot, usdcnyRate } from '../services/marketData.js'
import { computeAllocation } from '../services/allocation.js'

const r = Router()
const PLAN_ID = 1
const round2 = (value) => {
  const number = Number(value) || 0
  return (number < 0 ? -1 : 1) * (Math.round(Math.abs(number) * 100) / 100)
}

function nowText() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function ensurePlan() {
  let plan = sql.get('SELECT * FROM allocation_plans WHERE id = ?', PLAN_ID)
  if (!plan) {
    sql.run("INSERT INTO allocation_plans (id, name, total_amount) VALUES (?, '目标配置', 0)", PLAN_ID)
    plan = sql.get('SELECT * FROM allocation_plans WHERE id = ?', PLAN_ID)
  }
  return plan
}

function loadPlanItems(planId) {
  const rows = sql.all('SELECT * FROM allocation_items WHERE plan_id = ? ORDER BY sort_order, id', planId)
  const fundRows = sql.all(
    'SELECT m.item_id, m.fund_code FROM allocation_item_funds m JOIN allocation_items i ON i.id = m.item_id WHERE i.plan_id = ?',
    planId
  )
  const typeRows = sql.all(
    'SELECT t.item_id, t.asset_type FROM allocation_item_types t JOIN allocation_items i ON i.id = t.item_id WHERE i.plan_id = ?',
    planId
  )
  const fundsByItem = new Map()
  for (const row of fundRows) {
    if (!fundsByItem.has(row.item_id)) fundsByItem.set(row.item_id, [])
    fundsByItem.get(row.item_id).push(row.fund_code)
  }
  const typesByItem = new Map()
  for (const row of typeRows) {
    if (!typesByItem.has(row.item_id)) typesByItem.set(row.item_id, [])
    typesByItem.get(row.item_id).push(row.asset_type)
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    ratio: row.ratio,
    group_name: row.group_name || '',
    sort_order: row.sort_order,
    fund_codes: fundsByItem.get(row.id) || [],
    asset_types: typesByItem.get(row.id) || []
  }))
}

function loadPlan() {
  const plan = ensurePlan()
  return {
    id: plan.id,
    name: plan.name,
    total_amount: plan.total_amount,
    updated_at: plan.updated_at,
    items: loadPlanItems(plan.id)
  }
}

r.get('/plan', (_req, res) => {
  res.json(loadPlan())
})

r.put('/plan', (req, res) => {
  const parsed = allocationPlanSchema.safeParse(req.body)
  if (!parsed.success) {
    // 把 zod 的具体原因带回前端：比例不足 100%、类别重名、标的重复归入等
    const detail = parsed.error.issues.map((issue) => issue.message).filter(Boolean).join('；')
    return res.status(400).json({ error: detail || '参数校验失败', issues: parsed.error.issues })
  }
  const { name, total_amount, items } = parsed.data

  // 手工指定的基金必须真实存在，否则保存后归类会静默丢失
  const known = new Set(sql.all('SELECT code FROM funds').map((row) => row.code))
  const unknown = [...new Set(items.flatMap((item) => item.fund_codes))].filter((code) => !known.has(code))
  if (unknown.length) {
    return res.status(400).json({ error: `记账本中不存在这些标的：${unknown.join('、')}` })
  }

  ensurePlan()
  db.exec('BEGIN')
  try {
    sql.run(
      "UPDATE allocation_plans SET name = ?, total_amount = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
      name,
      total_amount,
      PLAN_ID
    )
    // 整体覆盖：删除旧类别（级联清掉标的/类型映射）后按前端顺序重建
    sql.run('DELETE FROM allocation_items WHERE plan_id = ?', PLAN_ID)
    items.forEach((item, index) => {
      const inserted = sql.run(
        'INSERT INTO allocation_items (plan_id, name, ratio, group_name, sort_order) VALUES (?, ?, ?, ?, ?)',
        PLAN_ID,
        item.name,
        item.ratio,
        item.group_name,
        (index + 1) * 10
      )
      const itemId = Number(inserted.lastInsertRowid)
      for (const code of item.fund_codes) {
        sql.run('INSERT INTO allocation_item_funds (item_id, fund_code) VALUES (?, ?)', itemId, code)
      }
      for (const type of item.asset_types) {
        sql.run('INSERT INTO allocation_item_types (item_id, asset_type) VALUES (?, ?)', itemId, type)
      }
    })
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  res.json(loadPlan())
})

// 实时把每只持仓估成当前市值；行情失败时退回成本价，避免整页资金占比被一只基金拖成 0
async function buildValuations(holdings, funds, txs, fresh) {
  const valuations = new Map()
  await Promise.all(
    holdings.map(async (holding) => {
      const fund = funds.get(holding.fund_code)
      if (MANUAL_ASSET_TYPES.has(fund?.asset_type)) {
        const nav = latestManualPrice(txs, holding.fund_code) || 1
        valuations.set(holding.fund_code, {
          market_value: round2(holding.shares * nav),
          nav,
          market_price: nav,
          valuation_source: '手工录入',
          valuation_date: '',
          estimate_time: '',
          currency: 'CNY'
        })
        return
      }
      const snapshot = await fundSnapshot(holding.fund_code, { fresh }).catch(() => null)
      const isUsd = snapshot?.currency === 'USD'
      const fxRate = isUsd ? (await usdcnyRate({ fresh }).catch(() => null)) || 7.1 : 1
      const nav = Number(snapshot?.valuation_nav) > 0 ? Number(snapshot.valuation_nav) : 0
      let marketPrice = Number(snapshot?.quote_price) > 0 ? Number(snapshot.quote_price) : nav
      let source = snapshot?.valuation_source || ''
      if (!(marketPrice > 0) && Number(holding.avg_cost) > 0) {
        // 行情不可用时用成本价兜底，并在页面标注。
        // avg_cost 是 CNY/份；USD 标的要折回美元量纲，避免后面再乘一次汇率。
        marketPrice = isUsd ? Number(holding.avg_cost) / fxRate : Number(holding.avg_cost)
        source = '成本价兜底（行情不可用）'
      }
      valuations.set(holding.fund_code, {
        market_value: round2(holding.shares * marketPrice * fxRate),
        nav: nav || null,
        market_price: marketPrice || null,
        valuation_source: source,
        valuation_date: snapshot?.valuation_date || '',
        estimate_time: snapshot?.estimate_time || '',
        currency: snapshot?.currency || fund?.currency || 'CNY'
      })
    })
  )
  return valuations
}

r.get('/overview', async (req, res, next) => {
  try {
    const fresh = req.query.refresh === '1'
    const plan = loadPlan()
    const txs = await addAutomaticReinvestments(loadTxs(null))
    // 只统计仍有份额的持仓：清仓后的基金不再占用目标额度
    const holdings = computeHoldings(txs).filter((holding) => holding.shares > 1e-9)
    const fundRows = sql.all('SELECT code, name, type, asset_type, market, currency FROM funds')
    const funds = new Map(fundRows.map((fund) => [fund.code, fund]))
    const valuations = await buildValuations(holdings, funds, txs, fresh)
    const overview = computeAllocation({ plan, items: plan.items, holdings, funds, valuations })
    res.json({ ...overview, updated_at: nowText(), fresh })
  } catch (error) {
    next(error)
  }
})

export default r
