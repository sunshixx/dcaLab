// 模拟引擎单元测试：全部用可手工推导的闭式/已知结果校验
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simulate, simulateWithScenarios } from '../src/services/simulator.js'

const baseAsset = (over = {}) => ({
  name: '测试标的',
  currency: 'CNY',
  expected_return: 0,
  management_fee: 0,
  cash_drag: 0,
  dividend_yield: 0,
  dividend_tax_rate: 0,
  capital_gains_tax_rate: 0,
  buy_premium: 0,
  premium_months: 0,
  sell_premium: 0,
  subscription_fee: 0,
  redemption_fee_tiers: [],
  weight: 1,
  ...over
})

const baseGlobal = {
  exchange_rate: 7.0,
  fx_drift: 0,
  inflation: 0,
  enable_dynamic_switch: false,
  premium_threshold: 0.06,
  overflow_asset: undefined
}

// ── 用例 1：零费零溢价 ↔ 期末年金终值闭式解 ──
// 引擎顺序：第 t 月月初买入、当月即计息，故第 t 月投入复利 (N−t+1) 个月：
// FV = C × Σ_{k=1}^{N} (1+g)^k = C × (1+g) × ((1+g)^N − 1) / g
test('用例1：零费用时与年金终值闭式解一致', () => {
  const C = 1000
  const r = 0.12
  const N = 12
  const g = Math.pow(1 + r, 1 / 12) - 1
  const expected = C * (1 + g) * (Math.pow(1 + g, N) - 1) / g
  const res = simulate({
    monthly_amount: C,
    years: 1,
    assets: [baseAsset({ expected_return: r })],
    global: baseGlobal
  })
  assert.ok(Math.abs(res.final_value - expected) < 0.01, `final=${res.final_value} expected=${expected}`)
  assert.equal(res.total_cost, 0)
  assert.equal(res.total_cost_terminal, 0)
})

// ── 用例 2：8% 买入溢价仅首月 —— 几何损失口径 8/108 ──
test('用例2：买入溢价损失 = 金额 × p/(1+p)', () => {
  const res = simulate({
    monthly_amount: 108,
    years: 1,
    assets: [baseAsset({ buy_premium: 0.08, premium_months: 1 })],
    global: baseGlobal
  })
  // 首月投入 108，溢价 8% → 公平市值 100，损失恰为 8（= 108×8/108）
  assert.ok(Math.abs(res.cost_breakdown.premium_loss - 8) < 1e-6)
  // 期末价值：100 + 11×108（其余月份无溢价）
  assert.ok(Math.abs(res.final_value - 1288) < 1e-6)
  assert.equal(res.total_investment, 1296)
})

// ── 用例 3：股息税（税后自动再投资）──
// r=0 时递推 V_m = (V_{m−1} + C) × (1 + y_net/12)，闭式解可独立推出
test('用例3：股息计提、预扣税并再投资', () => {
  const C = 100
  const dNet = 0.005 // 股息率 1.2%/12 × (1−50% 税) —— 这里直接给参数：yield 0.12, tax 0.5
  // 独立重算（按定义，不复制引擎代码路径）：
  let V = 0
  let taxes = 0
  for (let m = 1; m <= 12; m++) {
    V += C
    const divGross = V * 0.01
    taxes += divGross * 0.5
    V += divGross * 0.5
  }
  const res = simulate({
    monthly_amount: C,
    years: 1,
    assets: [baseAsset({ dividend_yield: 0.12, dividend_tax_rate: 0.5 })],
    global: baseGlobal
  })
  assert.ok(Math.abs(res.final_value - V) < 0.01, `final=${res.final_value} expected=${V}`)
  assert.ok(Math.abs(res.cost_breakdown.dividend_taxes - taxes) < 0.01)
})

// ── 用例 4：卖出溢价 + 逐批赎回费 + 资本利得税 ──
test('用例4：期末卖出的三重扣费按批次精确计算', () => {
  // 12 个月每月 100，r=0 → 持仓 1200；卖出溢价 10% → 毛卖出 1320
  // 赎回费统一 1% → 13.2；应税收益 = 1320×0.99 − 1200 = 106.8；税 20% → 21.36
  // 净到手 = 1320 − 13.2 − 21.36 = 1285.44
  const res = simulate({
    monthly_amount: 100,
    years: 1,
    assets: [
      baseAsset({
        sell_premium: 0.1,
        capital_gains_tax_rate: 0.2,
        redemption_fee_tiers: [{ max_days: null, rate: 0.01 }]
      })
    ],
    global: baseGlobal
  })
  assert.ok(Math.abs(res.final_value - 1285.44) < 1e-6, `final=${res.final_value}`)
  assert.ok(Math.abs(res.cost_breakdown.redemption_fees - 13.2) < 1e-6)
  assert.ok(Math.abs(res.cost_breakdown.capital_gains_tax - 21.36) < 1e-6)
})

// ── 用例 5：费用的复利机会成本（终值口径 > 名义口径）──
test('用例5：费用终值口径显著大于名义口径', () => {
  const res = simulate({
    monthly_amount: 1000,
    years: 10,
    assets: [baseAsset({ expected_return: 0.1, management_fee: 0.01 })],
    global: baseGlobal
  })
  assert.ok(res.total_cost_terminal > res.total_cost * 1.2, `terminal=${res.total_cost_terminal} nominal=${res.total_cost}`)
  assert.equal(res.yearly_data.length, 10)
  const last = res.yearly_data[9]
  assert.ok(last.portfolio_value > last.cumulative_investment, '10% 收益下期末市值应高于投入')
})

// ── 用例 6：USD 标的静态汇率下回到 CNY 金额不变 ──
test('用例6：汇率漂移为 0 时 USD 标的终值即 CNY 投入（r=0）', () => {
  const res = simulate({
    monthly_amount: 100,
    years: 1,
    assets: [baseAsset({ currency: 'USD' })],
    global: baseGlobal
  })
  assert.ok(Math.abs(res.final_value - 1200) < 1e-6)
  assert.equal(res.fx_final, 7)
})

// ── 用例 7：动态切换 —— 溢价超阈值时资金分流到溢出桶 ──
test('用例7：动态切换开启时高溢价月份资金进入溢出桶', () => {
  const overflow = baseAsset({ name: '溢出桶', expected_return: 0 })
  const res = simulate({
    monthly_amount: 100,
    years: 1,
    assets: [baseAsset({ buy_premium: 0.08, premium_months: 3 })],
    global: { ...baseGlobal, enable_dynamic_switch: true, premium_threshold: 0.06, overflow_asset: overflow }
  })
  // 前 3 个月被分流（阈值 6% < 溢价 8%），后 9 个月正常买入主标的
  const main = res.asset_details.find((a) => a.name === '测试标的')
  const ovf = res.asset_details.find((a) => a.name === '溢出桶')
  assert.equal(main.switched_months, 3)
  assert.ok(ovf, '溢出桶应出现在结果中')
  // 主标的只收到 9 个月 × 100；溢出桶 3 个月 × 100；总投入仍为 1200
  assert.equal(res.total_investment, 1200)
  assert.ok(Math.abs(main.final_value - 900) < 1e-6)
  assert.ok(Math.abs(ovf.final_value - 300) < 1e-6)
  // 资金进溢出桶不付溢价，溢价损失应为 0
  assert.equal(res.cost_breakdown.premium_loss, 0)
})

// ── 用例 8：三情景输出 ──
test('用例8：三情景与敏感性', () => {
  const res = simulateWithScenarios({
    monthly_amount: 3000,
    years: 20,
    assets: [baseAsset({ expected_return: 0.08 })],
    global: baseGlobal
  })
  assert.equal(res.scenarios.length, 3)
  const [pess, neu, opt] = res.scenarios
  assert.ok(pess.final_value < neu.final_value && neu.final_value < opt.final_value)
  assert.equal(neu.label, '中性')
  assert.ok(Math.abs(neu.final_value - res.final_value) < 0.01, '中性与基础结果一致')
})

test('现有持仓作为模拟起点：初始市值继续增长且成本计入总投入', () => {
  const res = simulate({
    monthly_amount: 100,
    years: 1,
    assets: [baseAsset({ initial_value: 1000, initial_cost: 800 })],
    global: baseGlobal
  })
  assert.equal(res.total_investment, 2000)
  assert.equal(res.final_value, 2200)
})

test('按交易日定投：一年投入 252 次且年化收益按日频率计算', () => {
  const res = simulate({
    monthly_amount: 1,
    daily_amount: 100,
    contribution_frequency: 'trading_day',
    years: 1,
    assets: [baseAsset({ expected_return: 0 })],
    global: baseGlobal
  })
  assert.equal(res.total_investment, 25200)
  assert.equal(res.final_value, 25200)
  assert.equal(res.yearly_data.length, 1)
})
