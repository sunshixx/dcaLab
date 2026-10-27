// 目标配置计算（纯函数，便于单测）
//
// 口径：
// - 目标金额 = 计划总金额 × 目标比例
// - 实际投入 = 记账本「累计投入本金」（买入含费 + 费用调整 − 卖出到手，不扣现金分红）
// - 完成度   = 实际投入 / 目标金额（> 100% 即超配）
// - 资金占比 = 当前市值 / 已归类持仓市值（未归类资金单列，不参与占比和再平衡）
// - 配置偏离 = 资金占比 − 目标比例
// - 再平衡差额 = 当前市值 − 目标比例 × 已归类持仓市值（正数=超配可减，负数=低配待补）
//
// 分红再投资属于基金内部再投入，不重复计入本金；现金分红也不从本金里扣减。
// 标的归类优先级：手工指定（allocation_item_funds） > 按资产类型自动归入
// （allocation_item_types，仅公积金/国债/逆回购/现金流）。

const round2 = (value) => {
  const number = Number(value) || 0
  return (number < 0 ? -1 : 1) * (Math.round(Math.abs(number) * 100) / 100)
}

/** 建立 fund_code -> 类别下标 的唯一归类表 */
export function classifyFunds(items, funds) {
  const explicit = new Map()
  const byType = new Map()
  items.forEach((item, index) => {
    for (const code of item.fund_codes || []) {
      if (!explicit.has(code)) explicit.set(code, index)
    }
  })
  items.forEach((item, index) => {
    for (const type of item.asset_types || []) {
      if (!byType.has(type)) byType.set(type, index)
    }
  })
  const result = new Map()
  for (const [code, fund] of funds) {
    if (explicit.has(code)) result.set(code, explicit.get(code))
    else if (byType.has(fund.asset_type)) result.set(code, byType.get(fund.asset_type))
  }
  return result
}

function memberRow(holding, fund, valuation) {
  return {
    code: holding.fund_code,
    name: fund?.name || holding.fund_code,
    fund_type: fund?.type || '',
    asset_type: fund?.asset_type || 'fund',
    shares: holding.shares,
    // deployed = 累计投入本金（不扣现金分红）；兼容旧调用方没有该字段时退回 invested
    invested: round2(holding.deployed ?? holding.invested),
    market_value: round2(valuation?.market_value),
    nav: valuation?.nav ?? null,
    market_price: valuation?.market_price ?? null,
    valuation_source: valuation?.valuation_source || '',
    valuation_date: valuation?.valuation_date || '',
    estimate_time: valuation?.estimate_time || '',
    currency: valuation?.currency || fund?.currency || 'CNY',
    held: true
  }
}

// 已关联但还没买入的标的：页面仍显示「N 只」，再平衡时也能作为买入候选
function pendingMember(fund) {
  return {
    code: fund.code,
    name: fund.name || fund.code,
    fund_type: fund.type || '',
    asset_type: fund.asset_type || 'fund',
    shares: 0,
    invested: 0,
    market_value: 0,
    nav: null,
    market_price: null,
    valuation_source: '尚未持仓',
    valuation_date: '',
    estimate_time: '',
    currency: fund.currency || 'CNY',
    held: false
  }
}

/**
 * @param {object} input
 * @param {{name: string, total_amount: number}} input.plan
 * @param {Array} input.items
 * @param {Array} input.holdings  computeHoldings 结果（只含当前仍有份额的标的）
 * @param {Map<string, object>} input.funds    code -> funds 行
 * @param {Map<string, object>} input.valuations code -> {market_value, nav, ...}
 */
export function computeAllocation({ plan, items, holdings, funds, valuations }) {
  const totalAmount = Number(plan?.total_amount) || 0
  const classification = classifyFunds(items, funds)
  const stats = items.map((item) => ({
    name: item.name,
    ratio: item.ratio,
    group_name: item.group_name || '',
    sort_order: item.sort_order ?? 0,
    fund_codes: item.fund_codes || [],
    asset_types: item.asset_types || [],
    target_amount: round2(totalAmount * item.ratio),
    actual_invested: 0,
    market_value: 0,
    members: []
  }))

  let totalInvested = 0
  let totalMarketValue = 0
  let unassignedInvested = 0
  let unassignedMarketValue = 0
  const unassigned = []

  for (const holding of holdings) {
    const fund = funds.get(holding.fund_code)
    const valuation = valuations.get(holding.fund_code)
    const member = memberRow(holding, fund, valuation)
    totalInvested += member.invested
    totalMarketValue += member.market_value
    const index = classification.get(holding.fund_code)
    if (index == null) {
      unassigned.push(member)
      unassignedInvested += member.invested
      unassignedMarketValue += member.market_value
      continue
    }
    stats[index].actual_invested += member.invested
    stats[index].market_value += member.market_value
    stats[index].members.push(member)
  }

  // 再平衡只针对已归类持仓：未归类资金不参与，否则所有类别会凭空出现一笔缺口
  const categorizedInvested = totalInvested - unassignedInvested
  const categorizedMarketValue = totalMarketValue - unassignedMarketValue

  // 已关联但尚未买入的标的补进成员列表（不计投入、不计市值），供页面展示和再平衡拆分
  const heldCodes = stats.map((row) => new Set(row.members.map((member) => member.code)))
  stats.forEach((row, index) => {
    for (const code of row.fund_codes) {
      if (heldCodes[index].has(code)) continue
      if (classification.get(code) !== index) continue
      const fund = funds.get(code)
      if (fund) row.members.push(pendingMember(fund))
    }
  })

  for (const row of stats) {
    row.actual_invested = round2(row.actual_invested)
    row.market_value = round2(row.market_value)
    row.completion = row.target_amount > 0 ? row.actual_invested / row.target_amount : null
    row.gap = round2(row.target_amount - row.actual_invested)
    row.market_share = categorizedMarketValue > 0 ? row.market_value / categorizedMarketValue : null
    row.deviation = row.market_share == null ? null : row.market_share - row.ratio
    row.rebalance_delta =
      categorizedMarketValue > 0 ? round2(row.market_value - row.ratio * categorizedMarketValue) : null
  }

  // 分组小计（如「商品/另类」），按首次出现顺序输出，供页面插在子项前面
  const groups = []
  const groupIndex = new Map()
  for (const row of stats) {
    if (!row.group_name) continue
    if (!groupIndex.has(row.group_name)) {
      groupIndex.set(row.group_name, groups.length)
      groups.push({
        name: row.group_name,
        ratio: 0,
        target_amount: 0,
        actual_invested: 0,
        market_value: 0,
        items: []
      })
    }
    const group = groups[groupIndex.get(row.group_name)]
    group.ratio += row.ratio
    group.target_amount += row.target_amount
    group.actual_invested += row.actual_invested
    group.market_value += row.market_value
    group.items.push(row.name)
  }
  for (const group of groups) {
    group.ratio = Math.round(group.ratio * 1e6) / 1e6
    group.target_amount = round2(group.target_amount)
    group.actual_invested = round2(group.actual_invested)
    group.market_value = round2(group.market_value)
    group.completion = group.target_amount > 0 ? group.actual_invested / group.target_amount : null
    group.gap = round2(group.target_amount - group.actual_invested)
    group.market_share = categorizedMarketValue > 0 ? group.market_value / categorizedMarketValue : null
    group.deviation = group.market_share == null ? null : group.market_share - group.ratio
    group.rebalance_delta =
      categorizedMarketValue > 0 ? round2(group.market_value - group.ratio * categorizedMarketValue) : null
  }

  const ratioSum = Math.round(stats.reduce((sum, row) => sum + row.ratio, 0) * 1e6) / 1e6

  return {
    plan: {
      id: plan?.id ?? null,
      name: plan?.name || '',
      total_amount: round2(totalAmount),
      updated_at: plan?.updated_at || ''
    },
    items: stats,
    groups,
    unassigned,
    totals: {
      planned_total: round2(totalAmount),
      actual_invested: round2(totalInvested),
      categorized_invested: round2(categorizedInvested),
      unassigned_invested: round2(unassignedInvested),
      market_value: round2(totalMarketValue),
      categorized_market_value: round2(categorizedMarketValue),
      unassigned_market_value: round2(unassignedMarketValue),
      // 再平衡基准：只算已归类持仓的当前市值
      rebalance_base: round2(categorizedMarketValue),
      completion: totalAmount > 0 ? totalInvested / totalAmount : null,
      categorized_completion: totalAmount > 0 ? categorizedInvested / totalAmount : null,
      remaining: round2(totalAmount - totalInvested),
      categorized_remaining: round2(totalAmount - categorizedInvested),
      ratio_sum: ratioSum
    }
  }
}
