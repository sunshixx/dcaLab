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
// 5. 现金拖累：由两部分组成（见 effectiveDrag）
//    a) cash_drag：场外联接基金的固定年化损耗（手填）
//    b) cash_ratio × expected_return：场内 ETF 真实现金占净比的机会成本，
//       cash_ratio 可由东财「基金资产配置」接口取得的 HB（现金占净比）填入
// 5b. 定投频率：monthly（12 期/年）、trading_day（252 期/年）、yearly（1 期/年）。
//     三种频率的金额字段相互独立（monthly_amount / daily_amount / yearly_amount），
//     缺失即报错，避免把别的频率的金额误用成本频率金额。
// 6. 管理费/托管费：按月初资产市值的 fee/12 逐月计提（基金按日计提的
//    月度近似，行业通行简化）。
// 7. 费用的复利机会成本（“真实成本”终值口径）：
//    第 t 期被扣的费用 cost，到期末损失的不只是自身，还包括其本可在
//    组合内按净收益率复利的增值：
//    terminal_cost = cost × (1 + r_net_period)^(N − t)
//    其中 r_net_period = (1 + expected_return − management_fee − cash_drag)^(1/periodsPerYear) − 1
//    periodsPerYear = 12（按月）或 252（按交易日），与 (N − t) 的期数单位保持一致。
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

// 有效现金拖累（年化）：
//   手填部分  cash_drag        —— 场外联接保留现金头寸的固定损耗
//   真实部分  cash_ratio × 收益率 —— 场内 ETF 的真实现金占净比不参与市场增值
//                                 （现金报酬按 0 计，偏保守）
function effectiveDrag(p) {
  return p.cash_drag + p.expected_return * (p.cash_ratio || 0)
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
export function simulate({ monthly_amount, daily_amount, yearly_amount, contribution_frequency = 'monthly', years, assets, global }) {
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
  // 每种频率都必须显式提供自己的金额，否则会把别的频率的金额当成本频率金额
  // （按交易日误用月金额 → 放大 252 倍；按年误用月金额 → 缩水 12 倍）
  if (frequency === 'trading_day' && !(daily_amount > 0)) {
    throw new Error('按交易日定投必须提供 daily_amount（每个交易日的定投金额）')
  }
  if (frequency === 'yearly' && !(yearly_amount > 0)) {
    throw new Error('按年定投必须提供 yearly_amount（每年的定投金额）')
  }
  const periodsPerYear = frequency === 'trading_day' ? 252 : frequency === 'yearly' ? 1 : 12
  const periodsPerMonth = periodsPerYear / 12
  const periods = years * periodsPerYear
  // 每期投入金额
  const perPeriodAmount =
    frequency === 'trading_day' ? daily_amount : frequency === 'yearly' ? yearly_amount : monthly_amount

  // 汇率：m = 已过月数；第 t 月的买入发生在已过 (t-1) 个月时点
  const fx = (period) => g.exchange_rate * Math.pow(1 + g.fx_drift, period / periodsPerYear)

  const wSum = assets.reduce((s, a) => s + a.weight, 0)
  const states = assets.map((a) => emptyAssetState(a))
  let overflow = null

  // 费用记账：同时记名义值（CNY）与终值口径（含复利机会成本）
  function addCost(st, bucket, amountNat, month, fxRate) {
    const cny = amountNat * fxRate
    st.cost[bucket] += cny
    // 机会成本折现率必须与组合“实际”净增长率一致：
    //   年化净增长 = (1 + 价格收益) × (1 + 税后股息率) − 管理费 − 现金拖累
    // 此前漏掉了税后股息再投资，高股息标的的终值口径会被系统性低估。
    const dyNet = st.params.dividend_yield * (1 - st.params.dividend_tax_rate)
    const rNet =
      (1 + st.params.expected_return) * (1 + dyNet) - 1 -
      st.params.management_fee - effectiveDrag(st.params)
    // 复利期数必须与 remaining 的时间单位一致：
    //   monthly      → periodsPerYear=12  → 月利率，remaining 为月数
    //   trading_day  → periodsPerYear=252 → 日利率，remaining 为交易日数
    // （此前硬编码 1/12，按交易日时会用月利率复利几千次，导致终值口径爆炸）
    const rm = rNet > -1 ? Math.pow(1 + rNet, 1 / periodsPerYear) - 1 : -1
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
    // 现金拖累 = 手填年化损耗 + 真实现金头寸的机会成本
    const drag = (V0 * effectiveDrag(p)) / periodsPerYear
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
      // 权重即“每个标的自己的每期金额”时，wSum 是各标金额之和；全部为 0 时不投任何标的
      const c = wSum > 0 ? (perPeriodAmount * st.params.weight) / wSum : 0
      const p = st.params
      const effPM = effectivePremiumMonths(p)
      // 溢价窗口按“月”计，需把期序号折算成「已过月数」：
      //   按月   t 即月序号            → ceil(t / 1) = t
      //   按日   21 个交易日为一个月   → ceil(t / 21)
      //   按年   第 t 年的投入发生在第 (t-1)*12+1 个月
      // 此前统一用 ceil(t / periodsPerMonth)，按年时会算成 ceil(t×12)，
      // 使第一笔年投被判为“第 12 个月”，首月溢价窗口永远失效。
      const monthIndex =
        frequency === 'yearly' ? (t - 1) * 12 + 1 : Math.ceil(t / periodsPerMonth)
      const premActive = monthIndex <= effPM
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
        // 持有天数按频率换算：trading_day 期=交易日、yearly 期=年、monthly 期=月
        const days =
          frequency === 'trading_day' ? periodsHeld * 365 / 252
          : frequency === 'yearly' ? periodsHeld * 365.25
          : periodsHeld * 30.4375
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

  // 逐年快照在循环内生成，而赎回费/资本利得税是循环结束后 settle() 才计入的，
  // 因此最后一年必须回填，否则「逐年数据」与「费用分解/期末终值」会互相矛盾。
  if (yearly.length) {
    const last = yearly[yearly.length - 1]
    last.portfolio_value = round2(finalValue)
    last.cost_lost = round2(totalCost)
    last.cost_lost_terminal = round2(totalCostTerminal)
  }

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
    if (shift === 0) {
      // shift = 0 与基础运行完全等价，直接复用结果，不重复模拟
      scenarios.push({
        label: '中性',
        shift: 0,
        final_value: base.final_value,
        final_value_real: base.final_value_real,
        total_cost: base.total_cost,
        total_cost_terminal: base.total_cost_terminal
      })
      continue
    }
    const p = structuredClone(payload)
    for (const a of p.assets) a.expected_return = a.expected_return + shift
    if (p.global && p.global.overflow_asset)
      p.global.overflow_asset.expected_return += shift
    const r = simulate(p)
    scenarios.push({
      label: shift < 0 ? '悲观 (−2pp)' : '乐观 (+2pp)',
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
