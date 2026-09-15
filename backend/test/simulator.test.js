// 模拟引擎单元测试：全部用可手工推导的闭式/已知结果校验
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { simulate, simulateWithScenarios, grossUpNetReturn } from '../src/services/simulator.js'

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

// ── 回归：trading_day 缺 daily_amount 必须报错，而不是把月金额当每日金额放大 252 倍 ──
test('按交易日定投缺 daily_amount 时抛错', () => {
  assert.throws(
    () =>
      simulate({
        monthly_amount: 100,
        contribution_frequency: 'trading_day',
        years: 1,
        assets: [baseAsset()],
        global: baseGlobal
      }),
    /daily_amount/
  )
})

// ── 回归：trading_day 频率下溢价窗口按月粒度（premium_months=1 覆盖约 21 个交易日）──
test('按交易日定投：溢价窗口按月粒度生效', () => {
  const res = simulate({
    monthly_amount: 1,
    daily_amount: 100,
    contribution_frequency: 'trading_day',
    years: 1,
    assets: [baseAsset({ buy_premium: 0.08, premium_months: 1 })],
    global: baseGlobal
  })
  // 252/12 = 21 交易日/月；首月 21 笔 × 100 × 0.08/1.08（输出经 round2 保留两位）
  const expected = 21 * 100 * (0.08 / 1.08)
  assert.ok(
    Math.abs(res.cost_breakdown.premium_loss - expected) < 0.01,
    `premium=${res.cost_breakdown.premium_loss} expected=${expected}`
  )
})

// ── 回归：费用终值口径的折现期数必须与时间单位一致 ──
// 第 t 期费用 cost 的终值 = cost × (1+净收益率)^((N−t)/ppy)，
// ppy = 12（按月）或 252（按交易日）。独立重算，不复制引擎代码路径。
test('按月定投：申购费终值口径 = 名义 × (1+净收益率)^剩余月数/12', () => {
  const C = 100, r = 0.12, N = 12, feeRate = 0.01
  let nominal = 0, terminal = 0
  for (let t = 1; t <= N; t++) {
    const fee = C * feeRate
    nominal += fee
    terminal += fee * Math.pow(1 + r, (N - t) / 12)
  }
  const res = simulate({
    monthly_amount: C, years: 1, contribution_frequency: 'monthly',
    assets: [baseAsset({ expected_return: r, subscription_fee: feeRate })],
    global: baseGlobal
  })
  assert.ok(Math.abs(res.cost_breakdown.subscription_fees - nominal) < 0.01)
  assert.ok(
    Math.abs(res.cost_breakdown_terminal.subscription_fees - terminal) < 0.01,
    `terminal=${res.cost_breakdown_terminal.subscription_fees} expected=${terminal}`
  )
})

test('按交易日定投：费用终值口径按交易日折现（期数单位一致性回归）', () => {
  const C = 100, r = 0.12, ppy = 252, N = ppy, feeRate = 0.01
  let nominal = 0, terminal = 0
  for (let t = 1; t <= N; t++) {
    const fee = C * feeRate
    nominal += fee
    terminal += fee * Math.pow(1 + r, (N - t) / ppy)
  }
  const res = simulate({
    monthly_amount: 1, daily_amount: C, contribution_frequency: 'trading_day',
    years: 1,
    assets: [baseAsset({ expected_return: r, subscription_fee: feeRate })],
    global: baseGlobal
  })
  assert.ok(Math.abs(res.cost_breakdown.subscription_fees - nominal) < 0.01)
  // 修复前：折现率硬编码月利率，此处会放大到 1e11 量级
  assert.ok(
    Math.abs(res.cost_breakdown_terminal.subscription_fees - terminal) < 0.01,
    `terminal=${res.cost_breakdown_terminal.subscription_fees} expected=${terminal}`
  )
})

test('按交易日与按月同规模定投：终值口径费用应在同一量级', () => {
  const monthly = simulate({
    monthly_amount: 3000, years: 10, contribution_frequency: 'monthly',
    assets: [baseAsset({ expected_return: 0.07, management_fee: 0.005 })],
    global: baseGlobal
  })
  const daily = simulate({
    monthly_amount: 3000, daily_amount: 3000 / 21, years: 10,
    contribution_frequency: 'trading_day',
    assets: [baseAsset({ expected_return: 0.07, management_fee: 0.005 })],
    global: baseGlobal
  })
  const nominalRatio = daily.total_cost / monthly.total_cost
  const terminalRatio = daily.total_cost_terminal / monthly.total_cost_terminal
  assert.ok(nominalRatio > 0.9 && nominalRatio < 1.1, `名义口径比=${nominalRatio}`)
  assert.ok(terminalRatio > 0.9 && terminalRatio < 1.1, `终值口径比=${terminalRatio}`)
})

// ── 回归：各标的按自己的定投金额分配，而不是均分 ──
// 前端把「每期定投金额」归一化成占比作为 weight，合计 = Σ金额，
// 因此 weight 相同的标的才会均分，金额不同的必须各得自己的一份。
test('金额不同的标的各得自己的定投额（不再均分）', () => {
  const res = simulate({
    monthly_amount: 110,
    years: 1,
    assets: [
      baseAsset({ name: '标普A', weight: 100 / 110 }),
      baseAsset({ name: '标普B', weight: 10 / 110 })
    ],
    global: baseGlobal
  })
  const a = res.asset_details.find((x) => x.name === '标普A')
  const b = res.asset_details.find((x) => x.name === '标普B')
  assert.ok(Math.abs(a.invested - 1200) < 1, `A 投入=${a.invested} 期望 1200`)
  assert.ok(Math.abs(b.invested - 120) < 1, `B 投入=${b.invested} 期望 120`)
  assert.equal(res.total_investment, 1320)
  // 关键：两者金额不同，不能相等
  assert.ok(Math.abs(a.invested - b.invested) > 1000)
})

// ── 回归：权重 0 = 只持有存量、不参与定投分配 ──
test('权重为 0 的标的只持有不定投', () => {
  const res = simulate({
    monthly_amount: 100,
    years: 1,
    assets: [
      baseAsset({ name: '定投标的', weight: 1 }),
      baseAsset({ name: '存量持仓', weight: 0, initial_value: 5000, initial_cost: 4000 })
    ],
    global: baseGlobal
  })
  const hold = res.asset_details.find((x) => x.name === '存量持仓')
  const dca = res.asset_details.find((x) => x.name === '定投标的')
  assert.equal(hold.invested, 4000, '存量标的只应记初始成本')
  assert.equal(hold.final_value, 5000, 'r=0 时存量市值不变')
  assert.equal(dca.invested, 1200, '定投标的应拿满全部月投')
  assert.equal(res.total_investment, 5200)
})

// ── 回归：全部权重为 0 时不得除零（wSum = 0）──
test('全部权重为 0 时不产生新增投入', () => {
  const res = simulate({
    monthly_amount: 100,
    years: 1,
    assets: [baseAsset({ name: '存量', weight: 0, initial_value: 1000, initial_cost: 1000 })],
    global: baseGlobal
  })
  assert.equal(res.total_investment, 1000)
  assert.equal(res.final_value, 1000)
  assert.ok(Number.isFinite(res.final_value))
})
// 赎回费/资本利得税在循环结束后的 settle() 才计入，逐年快照必须回填最后一年，
// 否则「逐年数据」表格最后一行与「费用分解/期末终值」互相矛盾。
test('逐年数据最后一年与汇总口径一致（含期末赎回费与资本利得税）', () => {
  const res = simulate({
    monthly_amount: 1000,
    years: 3,
    assets: [
      baseAsset({
        expected_return: 0.08,
        sell_premium: 0.05,
        capital_gains_tax_rate: 0.2,
        redemption_fee_tiers: [{ max_days: null, rate: 0.01 }]
      })
    ],
    global: baseGlobal
  })
  assert.ok(res.cost_breakdown.redemption_fees > 0, '用例应产生赎回费')
  assert.ok(res.cost_breakdown.capital_gains_tax > 0, '用例应产生资本利得税')
  const last = res.yearly_data[res.yearly_data.length - 1]
  assert.ok(Math.abs(last.cost_lost - res.total_cost) < 0.01, `逐年=${last.cost_lost} 汇总=${res.total_cost}`)
  assert.ok(
    Math.abs(last.cost_lost_terminal - res.total_cost_terminal) < 0.01,
    `逐年终值=${last.cost_lost_terminal} 汇总=${res.total_cost_terminal}`
  )
  assert.ok(Math.abs(last.portfolio_value - res.final_value) < 0.01, `逐年市值=${last.portfolio_value} 汇总终值=${res.final_value}`)
})

// ── 回归：终值口径的折现率必须包含税后股息再投资 ──
// 组合实际年化净增长 = (1+价格收益)(1+税后股息率) − 管理费 − 现金拖累。
// 此前只用「价格收益 − 管理费 − 现金拖累」，高股息标的的终值口径被系统性低估。
test('终值口径折现率包含税后股息再投资', () => {
  const r = 0.06, fee = 0.004, dy = 0.03, tax = 0.2, N = 12, sub = 0.001
  const dyNet = dy * (1 - tax)
  const rNet = (1 + r) * (1 + dyNet) - 1 - fee
  // 申购费每月恒定，故终值/名义之比 = 平均折现因子，可独立精确推导
  let nominal = 0, terminal = 0
  for (let t = 1; t <= N; t++) {
    nominal += 1
    terminal += Math.pow(1 + rNet, (N - t) / 12)
  }
  const res = simulate({
    monthly_amount: 1000,
    years: 1,
    assets: [baseAsset({ expected_return: r, management_fee: fee, dividend_yield: dy, dividend_tax_rate: tax, subscription_fee: sub })],
    global: baseGlobal
  })
  const ratio = res.cost_breakdown_terminal.subscription_fees / res.cost_breakdown.subscription_fees
  const expected = terminal / nominal
  // 输出经 round2 取整，容差取 2e-3（漏算股息时偏差约 1.2e-2，仍可检出）
  assert.ok(Math.abs(ratio - expected) < 2e-3, `实际折现比=${ratio} 期望=${expected}`)
  // 反向确认：若漏掉股息，折现比会明显偏小
  const rNetNoDiv = r - fee
  let t2 = 0
  for (let t = 1; t <= N; t++) t2 += Math.pow(1 + rNetNoDiv, (N - t) / 12)
  assert.ok(expected > t2 / nominal * 1.005, '含股息的终值口径必须显著大于漏算股息的版本')
})

// ── 按年定投 ──
test('按年定投：每年投入一次，总投入 = 年金额 × 年数', () => {
  const res = simulate({
    monthly_amount: 1,
    yearly_amount: 36000,
    contribution_frequency: 'yearly',
    years: 20,
    assets: [baseAsset({ expected_return: 0 })],
    global: baseGlobal
  })
  assert.equal(res.total_investment, 720000, '36000 × 20 = 720000')
  assert.equal(res.final_value, 720000, 'r=0 时终值等于投入')
  assert.equal(res.yearly_data.length, 20)
  assert.equal(res.yearly_data[0].year, 1)
})

test('按年定投缺 yearly_amount 时抛错', () => {
  assert.throws(
    () => simulate({ monthly_amount: 3000, contribution_frequency: 'yearly', years: 10, assets: [baseAsset()], global: baseGlobal }),
    /yearly_amount/
  )
})

// 每年初一次性投入 vs 每月初分批投入：同样年投入下，年投资金平均早约 5.5 个月入场，
// 故终值应略高于月投，但幅度有限（约半年复利）。
test('按年定投终值略高于同额按月定投（资金入场更早）', () => {
  const yearly = simulate({
    monthly_amount: 1, yearly_amount: 36000, contribution_frequency: 'yearly',
    years: 20, assets: [baseAsset({ expected_return: 0.07 })], global: baseGlobal
  })
  const monthly = simulate({
    monthly_amount: 3000, contribution_frequency: 'monthly',
    years: 20, assets: [baseAsset({ expected_return: 0.07 })], global: baseGlobal
  })
  assert.equal(yearly.total_investment, monthly.total_investment)
  const ratio = yearly.final_value / monthly.final_value
  assert.ok(ratio > 1 && ratio < 1.1, `年/月终值比=${ratio} 应在 1~1.1 之间`)
})

test('按年定投的赎回费持有天数按年换算（不误用月换算）', () => {
  // 3 年、每年 10000，r=0；赎回费仅对「持有 <1 年」的批次生效。
  // 期末卖出时最早批次持有 3 年、最晚批次持有 1 年，均不 <1 年，故赎回费应为 0。
  // 若误用「×30.4375 天/月」换算，年投批次会被算成只有 30 天，从而错误计费。
  const res = simulate({
    monthly_amount: 1, yearly_amount: 10000, contribution_frequency: 'yearly', years: 3,
    assets: [baseAsset({ redemption_fee_tiers: [{ max_days: 365, rate: 0.01 }, { max_days: null, rate: 0 }] })],
    global: baseGlobal
  })
  assert.equal(res.cost_breakdown.redemption_fees, 0, '所有批次持有均 ≥1 年，不应产生赎回费')
  assert.equal(res.final_value, 30000)
})

// ── 真实现金拖累：cash_ratio × 预期收益率 ──
test('现金占净比按 占比×收益率 计入现金拖累', () => {
  const r = 0.08
  const ratio = 0.0405 // 沪深300ETF 2026-06-30 披露的现金占净比
  const res = simulate({
    monthly_amount: 1000, years: 5,
    assets: [baseAsset({ expected_return: r, cash_ratio: ratio })],
    global: baseGlobal
  })
  const drag = res.cost_breakdown.cash_drag_loss
  assert.ok(drag > 0, `应有现金拖累，实际 ${drag}`)
  assert.ok(drag < 3000, `拖累不应过大，实际 ${drag}`)
  // 与手填 cash_drag 叠加生效
  const both = simulate({
    monthly_amount: 1000, years: 5,
    assets: [baseAsset({ expected_return: r, cash_drag: 0.005, cash_ratio: ratio })],
    global: baseGlobal
  })
  assert.ok(both.cost_breakdown.cash_drag_loss > drag, '手填与真实拖累应叠加')
})

test('现金占净比为 0 时不产生现金拖累', () => {
  const res = simulate({
    monthly_amount: 1000, years: 5,
    assets: [baseAsset({ expected_return: 0.08, cash_ratio: 0 })],
    global: baseGlobal
  })
  assert.equal(res.cost_breakdown.cash_drag_loss, 0)
})

test('终值口径折现率包含现金拖累（拖累越大倍数越小）', () => {
  const noDrag = simulate({
    monthly_amount: 1000, years: 10,
    assets: [baseAsset({ expected_return: 0.08, management_fee: 0.005, cash_ratio: 0 })],
    global: baseGlobal
  })
  const withDrag = simulate({
    monthly_amount: 1000, years: 10,
    assets: [baseAsset({ expected_return: 0.08, management_fee: 0.005, cash_ratio: 0.18 })],
    global: baseGlobal
  })
  const m0 = noDrag.total_cost_terminal / noDrag.total_cost
  const m1 = withDrag.total_cost_terminal / withDrag.total_cost
  assert.ok(m1 < m0, `含现金拖累的终值倍数 ${m1} 应小于无拖累的 ${m0}`)
})

// ── 回归：历史净值净收益 → 毛收益 的反解，避免费用重复计提 ──
// 基金公布净值已是「扣过管理费、且已 embed 现金拖累」的净收益；
// 模拟器把 expected_return 当毛收益再扣一次，故必须先反解成毛收益。
test('毛收益反解：扣回费率与现金拖累后恰好还原历史净收益', () => {
  const cases = [
    { net: 0.09, fee: 0.008, cash: 0.0382 },  // 天弘标普500 实际参数
    { net: 0.09, fee: 0.01, cash: 0.181 },    // 国泰纳指100 实际参数（现金占比很高）
    { net: 0.06, fee: 0.002, cash: 0 },       // 无现金拖累
    { net: -0.1, fee: 0.005, cash: 0.05 }     // 负收益
  ]
  for (const c of cases) {
    const gross = grossUpNetReturn(c.net, c.fee, c.cash)
    // 模拟器的还原路径：净 = 毛×(1−现金占比) − 费率
    const back = gross * (1 - c.cash) - c.fee
    assert.ok(Math.abs(back - c.net) < 1e-9,
      `net=${c.net} fee=${c.fee} cash=${c.cash} → gross=${gross} 还原=${back}`)
  }
})

test('毛收益反解：现金占比 0 时仅加回费率', () => {
  assert.ok(Math.abs(grossUpNetReturn(0.07, 0.008, 0) - 0.078) < 1e-12)
  // 现金占比越大，需要的毛收益越高（因为要从毛收益里扣掉现金部分的拖累）
  const low = grossUpNetReturn(0.09, 0.008, 0.02)
  const high = grossUpNetReturn(0.09, 0.008, 0.18)
  assert.ok(high > low, `现金占比高时毛收益应更高：${high} > ${low}`)
})

test('毛收益反解：异常现金占比被钳制，不产生除零或负分母', () => {
  assert.ok(Number.isFinite(grossUpNetReturn(0.09, 0.008, 1)))   // 100% 现金
  assert.ok(Number.isFinite(grossUpNetReturn(0.09, 0.008, -0.5))) // 负值
  assert.ok(Number.isFinite(grossUpNetReturn(0.09, 0.008, NaN)))
  assert.ok(grossUpNetReturn(0.09, 0.008, 1) < 108) // 不会爆炸
})

// 端到端：用反解出的毛收益跑一遍，净增长应约等于历史净收益
test('端到端：反解毛收益 + 模拟器扣费 = 历史净收益', () => {
  const net = 0.09, fee = 0.008, cash = 0.0382
  const gross = grossUpNetReturn(net, fee, cash)
  const withFees = simulate({
    monthly_amount: 0, years: 5,
    assets: [baseAsset({ expected_return: gross, management_fee: fee, cash_ratio: cash, initial_value: 10000, initial_cost: 10000 })],
    global: baseGlobal
  })
  const noFees = simulate({
    monthly_amount: 0, years: 5,
    assets: [baseAsset({ expected_return: net, initial_value: 10000, initial_cost: 10000 })],
    global: baseGlobal
  })
  // 两者终值应接近（差异只来自逐月复利与算术/几何口径的微小不同）
  const diff = Math.abs(withFees.final_value - noFees.final_value) / noFees.final_value
  assert.ok(diff < 0.01, `反解后终值应接近历史净收益结果：含费=${withFees.final_value} 无费=${noFees.final_value} 偏差=${(diff * 100).toFixed(3)}%`)
})
