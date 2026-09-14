// 定投模拟引擎 —— 按月迭代（现金流精确模拟），不做闭式公式近似。
//
// ── 财务口径与公式出处 ──────────────────────────────────────────────
// 1. 期末年金终值（仅用于单元测试的闭式校验）：
//    FV = C × [((1+i)^n − 1) / i]   （Bodie/Kane/Marcus《投资学》年金公式）
// 2. 买入溢价损失（几何口径，非算术 p）：
//    以溢价 p 成交时，单位资金换得的“公平市值”为 1/(1+p)，
//    故损失率 = p/(1+p)。例：8% 溢价 → 实损 8/108 ≈ 7.41%。
// 3. 卖出溢价效应：卖出款 = 期末公平市值 × (1 + sell_premium)。
//    买入溢价已在买入端按 1/(1+p) 几何扣减份额（见 2），故卖出端不再除以
//    (1+avg_buy_premium)——那样会重复计提买入溢价；avg_buy_premium 仅作信息输出。
// 4. 股息税拖累：每期股息 = 当期持仓市值 × dividend_yield/12，
//    预扣 dividend_tax_rate，税后净额按当期净值再投资（基金分红除权处理）。
// 5. 现金拖累：场外联接基金留有现金头寸，等价于年化 cash_drag 的
//    增长率损耗（从月增长中直接扣减，与净额法一致）。
// 6. 管理费/托管费：按月初资产市值的 fee/12 逐月计提（基金按日计提的
//    月度近似，行业通行简化）。
// 7. 费用的复利机会成本（“真实成本”终值口径）：
//    第 t 月被扣的费用 cost，到期末损失的不只是自身，还包括其本可在
//    组合内按净收益率复利的增值：
//    terminal_cost = cost × (1 + r_net_m)^(N − t)
//    其中 r_net_m = (1 + expected_return − management_fee − cash_drag)^(1/12) − 1
// 8. 赎回费/资本利得税：按逐月批次（lot）精确计算。每批持有天数 =
//    持有月数 × 30.4375（年均天数/12），赎回费率按阶梯表取档；
//    应税收益 = 净卖出款 − 批次成本（买入摊薄成本与分红再投资成本均入批次）。
// 9. 汇率：USD 标的的投入按当月汇率折算，期末市值按期末汇率折回 CNY：
//    fx(m) = fx0 × (1 + fx_drift)^(m/12)。fx_drift = 0 即静态汇率。
// 10. 实际购买力：real = final / (1 + inflation)^years。
// ────────────────────────────────────────────────────────────────────

const COST_KEYS = [
  'subscription_fees',
  'management_fees',
  'dividend_taxes',
  'premium_loss',
  'cash_drag_loss',
  'redemption_fees',
  'capital_gains_tax'
]

const DEFAULT_OVERFLOW = {
  name: '溢出桶（A股）',
  currency: 'CNY',
  expected_return: 0.07,
  management_fee: 0.002,
  cash_drag: 0,
  dividend_yield: 0.025,
  dividend_tax_rate: 0,
  capital_gains_tax_rate: 0,
  buy_premium: 0,
  premium_months: 0,
  sell_premium: 0,
  subscription_fee: 0.0001,
  redemption_fee_tiers: [],
  weight: 1
}

function emptyAssetState(params) {
  const cost = {}
  const costT = {}
  for (const k of COST_KEYS) {
    cost[k] = 0
    costT[k] = 0
  }
  return {
    params,
    V: params.initial_value || 0, // 持仓公平市值（本币计价；份额×公平净值=1）
    lots: params.initial_value > 0 ? [{
      basis: params.initial_cost > 0 ? params.initial_cost : params.initial_value,
      value: params.initial_value,
      month: 0
    }] : [], // 逐月批次 {basis, value, month}
    invested: params.initial_investment ?? params.initial_cost ?? 0, // 当前持仓成本 + 模拟期间新增投入（CNY）
    cost,
    costT,
    premInvest: 0, // 发生溢价的买入金额累计（本币）
    premWeighted: 0, // Σ premium × 金额
    switchedMonths: 0 // 因动态切换被分流的月数
  }
}

// 溢价窗口：premium_months = 0 且 buy_premium > 0 时视同“仅首月有溢价”
function effectivePremiumMonths(p) {
  if (p.buy_premium > 0 && p.premium_months === 0) return 1
  return p.premium_months
}

function redemptionRateFor(tiers, days) {
  if (!tiers || tiers.length === 0) return 0
  for (const t of tiers) {
    if (t.max_days == null || days < t.max_days) return t.rate
  }
  return 0
}

/**
 * 核心模拟：单次确定性推演（不含三情景，三情景由 simulateWithScenarios 复用本函数）
 */
export function simulate({ monthly_amount, daily_amount, contribution_frequency = 'monthly', years, assets, global }) {
  const g = {
    exchange_rate: 7.0,
    fx_drift: 0,
    inflation: 0,
    enable_dynamic_switch: false,
    premium_threshold: 0.06,
    overflow_asset: null,
    ...global
  }
  const frequency = contribution_frequency
  const dailyAmount = daily_amount || monthly_amount
  const periodsPerYear = frequency === 'trading_day' ? 252 : 12
  const periods = years * periodsPerYear

  // 汇率：m = 已过月数；第 t 月的买入发生在已过 (t-1) 个月时点
  const fx = (period) => g.exchange_rate * Math.pow(1 + g.fx_drift, period / periodsPerYear)

  const wSum = assets.reduce((s, a) => s + a.weight, 0)
  const states = assets.map((a) => emptyAssetState(a))
  let overflow = null

  // 费用记账：同时记名义值（CNY）与终值口径（含复利机会成本）
  function addCost(st, bucket, amountNat, month, fxRate) {
    const cny = amountNat * fxRate
    st.cost[bucket] += cny
    const rNet = st.params.expected_return - st.params.management_fee - st.params.cash_drag
    const rm = rNet > -1 ? Math.pow(1 + rNet, 1 / 12) - 1 : -1
    const remaining = Math.max(0, periods - month)
    st.costT[bucket] += cny * Math.pow(1 + rm, remaining)
  }

  function buyInto(st, cCNY, premActive, month) {
    const p = st.params
    const rate = p.currency === 'USD' ? fx(month - 1) : 1
    const cNat = p.currency === 'USD' ? cCNY / rate : cCNY
    const subFee = cNat * p.subscription_fee
    const invest = cNat - subFee
    const prem = premActive ? p.buy_premium : 0
    const fair = invest / (1 + prem)
    const premiumLoss = invest - fair // = invest × p/(1+p)，几何口径
    st.V += fair
    st.invested += cCNY
    // 批次成本基差 = 实付现金（含申购费与溢价，税务口径）；value = 份额公平市值
    st.lots.push({ basis: invest, value: fair, month })
    if (prem > 0) {
      st.premInvest += invest
      st.premWeighted += prem * invest
    }
    addCost(st, 'subscription_fees', subFee, month, rate)
    addCost(st, 'premium_loss', premiumLoss, month, rate)
  }

  function growOneMonth(st, month) {
    const p = st.params
    if (st.V <= 0) return
    const V0 = st.V
    const gm = Math.pow(1 + p.expected_return, 1 / periodsPerYear) - 1
    const mgmt = (V0 * p.management_fee) / periodsPerYear
    const drag = (V0 * p.cash_drag) / periodsPerYear
    const grown = V0 * (1 + gm)
    // 有机增长净费用（用于批次等比缩放）
    const organic = grown - mgmt - drag
    const f = organic / V0
    for (const lot of st.lots) lot.value *= f
    st.V = organic

    // 股息：按增长后的市值计提，税后净额再投资并形成新批次
    const divGross = (st.V * p.dividend_yield) / periodsPerYear
    const divTax = divGross * p.dividend_tax_rate
    const divNet = divGross - divTax
    st.V += divNet
    if (divNet > 0) st.lots.push({ basis: divNet, value: divNet, month })

    const rate = p.currency === 'USD' ? fx(month) : 1
    addCost(st, 'management_fees', mgmt, month, rate)
    addCost(st, 'cash_drag_loss', drag, month, rate)
    addCost(st, 'dividend_taxes', divTax, month, rate)
  }

  const yearly = []

  for (let t = 1; t <= periods; t++) {
    for (let i = 0; i < states.length; i++) {
      const st = states[i]
      const contribution = frequency === 'trading_day' ? dailyAmount : monthly_amount
      const c = (contribution * st.params.weight) / wSum
      const p = st.params
      const effPM = effectivePremiumMonths(p)
      const premActive = t <= effPM
      const divert =
        g.enable_dynamic_switch && premActive && p.buy_premium > g.premium_threshold
      if (divert) {
        // 动态切换：当月资金全部转入 A 股溢出桶
        if (!overflow) overflow = emptyAssetState(g.overflow_asset || DEFAULT_OVERFLOW)
        buyInto(overflow, c, false, t)
        st.switchedMonths += 1
      } else if (c > 0) {
        buyInto(st, c, premActive, t)
      }
      growOneMonth(st, t)
    }
    if (overflow) growOneMonth(overflow, t)

    if (t % periodsPerYear === 0) {
      let value = 0
      let costNom = 0
      let costTerm = 0
      const bucket = overflow ? [...states, overflow] : states
      for (const st of bucket) {
        value += st.V * (st.params.currency === 'USD' ? fx(t) : 1)
        for (const k of COST_KEYS) {
          costNom += st.cost[k]
          costTerm += st.costT[k]
        }
      }
      yearly.push({
        year: t / periodsPerYear,
        cumulative_investment: round2(bucket.reduce((s, st) => s + st.invested, 0)),
        portfolio_value: round2(value),
        cost_lost: round2(costNom),
        cost_lost_terminal: round2(costTerm)
      })
    }
  }

  // ── 期末卖出：卖出溢价、逐批赎回费与资本利得税 ──
  // 说明：买入溢价已在买入端按 1/(1+p) 几何扣减份额（见 buyInto），因此卖出端
  // 只需按卖出价溢价放大：(1 + sell_premium)。原需求文档中
  // (1+sell)/(1+avg_buy_premium) 的分母会重复计提买入溢价，本引擎不采用；
  // avg_buy_premium 仍作为信息项输出。资本利得按批次“实付现金”基差计算，
  // 溢价买入的批次天然表现为亏损、不产生应税所得。
  function settle(st) {
    const p = st.params
    const avgPrem = st.premInvest > 0 ? st.premWeighted / st.premInvest : 0
    const sellFactor = 1 + p.sell_premium
    let redemptionFee = 0
    let taxableGain = 0
    for (const lot of st.lots) {
        const periodsHeld = periods - lot.month + 1
        const days = frequency === 'trading_day' ? periodsHeld * 365 / 252 : periodsHeld * 30.4375
      const rate = redemptionRateFor(p.redemption_fee_tiers, days)
      const lotGross = lot.value * sellFactor
      redemptionFee += lotGross * rate
      const netProceed = lotGross * (1 - rate)
      taxableGain += Math.max(0, netProceed - lot.basis)
    }
    const capTax = taxableGain * p.capital_gains_tax_rate
    const grossNat = st.V * sellFactor
    const netNat = grossNat - redemptionFee - capTax
    const finalRate = p.currency === 'USD' ? fx(periods) : 1
    addCost(st, 'redemption_fees', redemptionFee, periods, finalRate)
    addCost(st, 'capital_gains_tax', capTax, periods, finalRate)
    return {
      name: p.name,
      currency: p.currency,
      invested: round2(st.invested),
      final_value: round2(netNat * finalRate),
      gross_value: round2(grossNat * finalRate),
      total_cost: round2(sumCost(st.cost)),
      total_cost_terminal: round2(sumCost(st.costT)),
      cost: roundCost(st.cost),
      cost_terminal: roundCost(st.costT),
      switched_months: st.switchedMonths,
      avg_buy_premium: Math.round(avgPrem * 1e6) / 1e6
    }
  }

  const sumCost = (c) => COST_KEYS.reduce((s, k) => s + c[k], 0)
  const roundCost = (c) => {
    const o = {}
    for (const k of COST_KEYS) o[k] = round2(c[k])
    return o
  }

  const allStates = [...states, ...(overflow ? [overflow] : [])]
  const assetDetails = allStates.map(settle)

  const agg = { cost: {}, costT: {} }
  for (const k of COST_KEYS) {
    agg.cost[k] = 0
    agg.costT[k] = 0
  }
  for (const st of allStates) {
    for (const k of COST_KEYS) {
      agg.cost[k] += st.cost[k]
      agg.costT[k] += st.costT[k]
    }
  }

  const totalInvestment = allStates.reduce((s, st) => s + st.invested, 0)
  const finalValue = assetDetails.reduce((s, a) => s + a.final_value, 0)
  const totalCost = COST_KEYS.reduce((s, k) => s + agg.cost[k], 0)
  const totalCostTerminal = COST_KEYS.reduce((s, k) => s + agg.costT[k], 0)

  return {
    total_investment: round2(totalInvestment),
    final_value: round2(finalValue),
    final_value_real: round2(finalValue / Math.pow(1 + g.inflation, years)),
    total_cost: round2(totalCost),
    total_cost_terminal: round2(totalCostTerminal),
    cost_breakdown: roundCost(agg.cost),
    cost_breakdown_terminal: roundCost(agg.costT),
    yearly_data: yearly,
    asset_details: assetDetails,
    fx_final: round4(fx(periods)),
    years
  }
}

/**
 * 三情景 + 敏感性：收益率整体平移 −2pp / 0 / +2pp 各跑一遍
 */
export function simulateWithScenarios(payload) {
  const base = simulate(payload)
  const scenarios = []
  for (const shift of [-0.02, 0, 0.02]) {
    const p = structuredClone(payload)
    for (const a of p.assets) a.expected_return = a.expected_return + shift
    if (p.global && p.global.overflow_asset)
      p.global.overflow_asset.expected_return += shift
    const r = simulate(p)
    scenarios.push({
      label: shift < 0 ? '悲观 (−2pp)' : shift > 0 ? '乐观 (+2pp)' : '中性',
      shift,
      final_value: r.final_value,
      final_value_real: r.final_value_real,
      total_cost: r.total_cost,
      total_cost_terminal: r.total_cost_terminal
    })
  }
  base.scenarios = scenarios
  return base
}

function round2(x) {
  return Math.round(x * 100) / 100
}
function round4(x) {
  return Math.round(x * 10000) / 10000
}
