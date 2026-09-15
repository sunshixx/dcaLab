// 记账引擎单元测试：移动加权成本 / XIRR / CSV
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeHoldings, xirr, parseImportCsv, exportCsv, nearbyDividendExists, sharesStillValidAfterRemoval } from '../src/services/bookkeeping.js'

// ── XIRR 已知解 ──
test('XIRR：单笔一年期投入 10% 收益 → 10%', () => {
  const r = xirr([
    { date: '2021-01-01', amount: -100 },
    { date: '2022-01-01', amount: 110 } // 恰 365 天
  ])
  assert.ok(Math.abs(r - 0.1) < 1e-6, `xirr=${r}`)
})

test('XIRR：不规则现金流满足 NPV=0 定义', () => {
  const flows = [
    { date: '2020-01-01', amount: -1000 },
    { date: '2020-07-01', amount: -2000 },
    { date: '2020-10-15', amount: 500 },
    { date: '2021-01-01', amount: 3000 }
  ]
  const r = xirr(flows)
  assert.ok(r !== null && r > -0.9999)
  const t0 = new Date('2020-01-01T00:00:00').getTime()
  const DAY = 86400000
  const npv = flows.reduce(
    (s, f) => s + f.amount / Math.pow(1 + r, (new Date(f.date + 'T00:00:00').getTime() - t0) / (365 * DAY)),
    0
  )
  assert.ok(Math.abs(npv) < 1e-6, `npv=${npv}`)
})

test('XIRR：全流出无解 → null', () => {
  assert.equal(xirr([{ date: '2021-01-01', amount: -100 }]), null)
})

// ── 移动加权平均成本（手算对照）──
test('持仓：买入/卖出/分红再投的移动加权成本', () => {
  const txs = [
    { fund_code: '050025', date: '2024-01-05', type: 'buy', amount: 10000, nav: 2, shares: 4994, fee: 12 },
    { fund_code: '050025', date: '2024-06-03', type: 'sell', amount: 4300, nav: 2.15, shares: 2000, fee: 8 },
    { fund_code: '050025', date: '2024-07-08', type: 'dividend_reinvest', amount: 100, nav: 2.2, shares: 100 / 2.2, fee: 0 }
  ]
  const [h] = computeHoldings(txs)
  // 买入后：实际扣款 10000，手续费 12，份额 4994，净值成本 9988，含费现金成本 10000
  // 卖出 2000 份：已实现按含费现金成本均价计算，净值成本单独按净值均价扣除
  const expectedRealized = 4292 - 2000 * (10000 / 4994)
  const expectedRemainingNavCost = 9988 - 2000 * 2 + 100
  const expectedRemainingCost = 10000 - 2000 * (10000 / 4994) + 100
  assert.ok(Math.abs(h.realized_pl - expectedRealized) < 1e-6)
  assert.ok(Math.abs(h.shares - (4994 - 2000 + 100 / 2.2)) < 1e-6)
  assert.ok(Math.abs(h.nav_cost - expectedRemainingNavCost) < 1e-6)
  assert.ok(Math.abs(h.total_cost - expectedRemainingCost) < 1e-6)
  assert.ok(Math.abs(h.avg_cost - expectedRemainingNavCost / (4994 - 2000 + 100 / 2.2)) < 1e-9)
  assert.ok(Math.abs(h.avg_cost_with_fee - expectedRemainingCost / (4994 - 2000 + 100 / 2.2)) < 1e-9)
  // 净投入 = 实际扣款 10000 − 卖出到手 4292 = 5708；分红再投不是外部投入
  assert.ok(Math.abs(h.invested - 5708) < 1e-6)
})

test('买入手续费内扣：自动份额和持仓成本不重复计算手续费', () => {
  const [h] = computeHoldings([
    { fund_code: '000001', date: '2024-01-05', type: 'buy', amount: 10000, nav: 2, shares: 0, fee: 12 }
  ])
  assert.equal(h.shares, 4994)
  assert.equal(h.nav_cost, 9988)
  assert.equal(h.total_cost, 10000)
  assert.equal(h.avg_cost, 2)
  assert.equal(h.avg_cost_with_fee, 10000 / 4994)
  assert.equal(h.invested, 10000)
})

test('兼容旧记录：份额按金额除以净值时，重新扣除买入手续费', () => {
  const [h] = computeHoldings([
    { fund_code: '000001', date: '2024-01-05', type: 'buy', amount: 10000, nav: 2, shares: 5000, fee: 12 }
  ])
  assert.equal(h.shares, 4994)
  assert.equal(h.avg_cost, 2)
  assert.equal(h.total_cost, 10000)
})

test('定投累计：当前净值不变时，浮动亏损等于全部买入手续费', () => {
  const [h] = computeHoldings([
    { fund_code: '000001', date: '2024-01-01', type: 'buy', amount: 1000, nav: 2, shares: 0, fee: 1 },
    { fund_code: '000001', date: '2024-02-01', type: 'buy', amount: 2000, nav: 2, shares: 0, fee: 2 }
  ])
  const currentValue = h.shares * 2
  assert.equal(h.shares, 1498.5)
  assert.equal(h.total_cost, 3000)
  assert.equal(Math.round((currentValue - h.total_cost) * 100) / 100, -3)
  assert.equal(h.avg_cost, 2)
})

test('现金分红计入总收益，但不减少剩余持仓成本', () => {
  const [h] = computeHoldings([
    { fund_code: '000001', date: '2024-01-01', type: 'buy', amount: 1000, nav: 2, shares: 0, fee: 0 },
    { fund_code: '000001', date: '2024-06-01', type: 'dividend_cash', amount: 20, nav: 0, shares: 0, fee: 0 }
  ])
  assert.equal(h.shares, 500)
  assert.equal(h.total_cost, 1000)
  assert.equal(h.dividend_cash_total, 20)
  assert.equal(h.invested, 980)
})

// ── CSV 往返 ──
test('CSV：导入解析（含 BOM/引号/中文表头）与导出对齐', () => {
  const csv =
    '\uFEFF基金代码,基金名称,日期,类型,金额,净值,份额,手续费,备注\r\n' +
    '050025,博时标普500ETF联接A,2024-01-05,买入,10000,2,5000,12,"含,逗号"\r\n' +
    '510300,沪深300ETF,2024-02-01,卖出,500,3.9,128.2051,0.5,正常'
  const { rows, errors } = parseImportCsv(csv)
  assert.deepEqual(errors, [])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].fund_code, '050025')
  assert.equal(rows[0].type, 'buy')
  assert.equal(rows[0].note, '含,逗号')
  assert.equal(rows[1].type, 'sell')

  const out = exportCsv(
    [
      { code: '050025', name: '博时标普500ETF联接A' },
      { code: '510300', name: '沪深300ETF' }
    ],
    [
      { fund_code: '050025', date: '2024-01-05', type: 'buy', amount: 10000, nav: 2, shares: 5000, fee: 12, note: '' }
    ]
  )
  assert.ok(out.startsWith('\uFEFF'))
  const back = parseImportCsv(out)
  assert.equal(back.rows.length, 1)
  assert.equal(back.rows[0].shares, 5000)
})

test('CSV：错误行被跳过并报告', () => {
  const csv = '基金代码,基金名称,日期,类型,金额,净值,份额,手续费,备注\nABC123,x,2024-01-01,买入,100,1,100,0,\n050025,x,2024-01-02,未知类型,100,1,100,0,'
  const { rows, errors } = parseImportCsv(csv)
  assert.equal(rows.length, 0)
  assert.equal(errors.length, 2)
})

// ── 回归：USD 分红再投必须按汇率折算 ──
test('USD 分红再投按汇率折算计入分红累计与成本', () => {
  const [h] = computeHoldings([
    { fund_code: 'QQQ', type: 'buy', date: '2024-01-05', amount: 1000, fee: 1, nav: 2, shares: 499.5, currency: 'USD', fx_rate: 7 },
    { fund_code: 'QQQ', type: 'dividend_reinvest', date: '2024-06-01', amount: 10, fee: 0, nav: 2, shares: 5, currency: 'USD', fx_rate: 7 }
  ])
  assert.equal(h.dividend_reinvest_total, 70) // 10 USD × 7，不能按 10 计
  assert.equal(h.nav_cost, 999 * 7 + 70)
  assert.equal(h.total_cost, 1000 * 7 + 70)
})

// ── 回归：分红去重窗口 ±7 天 ──
test('±7 天内存在同基金分红记录即视为重复', () => {
  const txs = [{ id: 1, fund_code: '000001', type: 'dividend_cash', date: '2024-06-03', amount: 20 }]
  assert.equal(nearbyDividendExists(txs, '000001', '2024-06-08', 7), true) // 差 5 天
  assert.equal(nearbyDividendExists(txs, '000001', '2024-06-11', 7), false) // 差 8 天
  assert.equal(nearbyDividendExists(txs, '000001', '2024-06-03', 0), true)
  assert.equal(nearbyDividendExists(txs, '000002', '2024-06-03', 7), false) // 不同基金
  assert.equal(
    nearbyDividendExists([{ id: 1, fund_code: '000001', type: 'buy', date: '2024-06-03', amount: 20 }], '000001', '2024-06-03', 7),
    false
  ) // 买入不算分红记录
})

// ── 回归：删除交易前重演份额 ──
test('删除买入导致后续卖出份额为负时应拦截', () => {
  const txs = [
    { id: 1, fund_code: '000001', type: 'buy', date: '2024-01-01', amount: 1000, nav: 1, shares: 1000, fee: 0 },
    { id: 2, fund_code: '000001', type: 'sell', date: '2024-02-01', amount: 500, nav: 1, shares: 500, fee: 0 }
  ]
  assert.equal(sharesStillValidAfterRemoval(txs, 2), true) // 删卖出没问题
  assert.equal(sharesStillValidAfterRemoval(txs, 1), false) // 删买入 → 份额 -500
  assert.equal(sharesStillValidAfterRemoval(txs, 99), true) // id 不存在等于无变化
})
