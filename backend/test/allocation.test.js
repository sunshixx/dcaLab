import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyFunds, computeAllocation } from '../src/services/allocation.js'
import { allocationPlanSchema } from '../src/models/schemas.js'

const fund = (code, name, asset_type = 'fund') => ({ code, name, type: '', asset_type })
const holding = (code, invested, marketValue, shares = 1) => ({
  fund_code: code,
  shares,
  invested,
  avg_cost: shares > 0 ? invested / shares : 0,
  _marketValue: marketValue
})

function run({ plan, items, holdingRows, fundRows, valuations }) {
  const fundMap = new Map(fundRows.map((row) => [row.code, row]))
  const valuationMap = new Map(
    valuations.map((row) => [
      row.code,
      { market_value: row.market_value, nav: row.nav ?? 1, valuation_source: '测试' }
    ])
  )
  return computeAllocation({
    plan,
    items,
    holdings: holdingRows,
    funds: fundMap,
    valuations: valuationMap
  })
}

test('目标配置：完成度 = 累计净投入 / 目标金额，缺口与总计口径正确', () => {
  const out = run({
    plan: { id: 1, name: '目标配置', total_amount: 100000 },
    items: [
      { name: '宽基', ratio: 0.6, group_name: '', fund_codes: ['510300', '510500'], asset_types: [] },
      { name: '现金', ratio: 0.4, group_name: '', fund_codes: [], asset_types: ['cash_flow'] }
    ],
    holdingRows: [
      holding('510300', 30000, 33000),
      holding('510500', 20000, 21000),
      holding('CASH', 40000, 40000)
    ],
    fundRows: [fund('510300', '沪深300ETF'), fund('510500', '中证500ETF'), fund('CASH', '现金', 'cash_flow')],
    valuations: [
      { code: '510300', market_value: 33000 },
      { code: '510500', market_value: 21000 },
      { code: 'CASH', market_value: 40000 }
    ]
  })

  const wide = out.items[0]
  assert.equal(wide.target_amount, 60000)
  assert.equal(wide.actual_invested, 50000)
  assert.ok(Math.abs(wide.completion - 50000 / 60000) < 1e-12)
  assert.equal(wide.gap, 10000)
  assert.equal(wide.market_value, 54000)

  const cash = out.items[1]
  assert.equal(cash.target_amount, 40000)
  assert.equal(cash.actual_invested, 40000)
  assert.equal(cash.completion, 1)

  assert.equal(out.totals.actual_invested, 90000)
  assert.equal(out.totals.market_value, 94000)
  assert.ok(Math.abs(out.totals.completion - 0.9) < 1e-12)
  assert.equal(out.totals.remaining, 10000)
  assert.ok(Math.abs(wide.market_share - 54000 / 94000) < 1e-12)
})

test('目标配置：公积金/现金流按类型自动归入现金，国债按类型归入债类', () => {
  const out = run({
    plan: { total_amount: 10000 },
    items: [
      { name: '中长债', ratio: 0.5, group_name: '', fund_codes: [], asset_types: ['treasury_bond'] },
      { name: '现金', ratio: 0.5, group_name: '', fund_codes: [], asset_types: ['cash_flow', 'provident_fund'] }
    ],
    holdingRows: [holding('BOND', 1000, 1000), holding('CASH', 1500, 1500), holding('GJJ', 500, 500)],
    fundRows: [
      fund('BOND', '国债', 'treasury_bond'),
      fund('CASH', '现金流', 'cash_flow'),
      fund('GJJ', '公积金', 'provident_fund')
    ],
    valuations: [
      { code: 'BOND', market_value: 1000 },
      { code: 'CASH', market_value: 1500 },
      { code: 'GJJ', market_value: 500 }
    ]
  })
  assert.equal(out.items[0].actual_invested, 1000)
  assert.equal(out.items[1].actual_invested, 2000)
  assert.equal(out.unassigned.length, 0)
})

test('目标配置：手工指定优先于自动类型（同一只国债可手动归到短债）', () => {
  const out = run({
    plan: { total_amount: 10000 },
    items: [
      { name: '中长债', ratio: 0.5, fund_codes: [], asset_types: ['treasury_bond'] },
      { name: '短债', ratio: 0.5, fund_codes: ['019547'], asset_types: [] }
    ],
    holdingRows: [holding('019547', 3000, 3000)],
    fundRows: [fund('019547', '短久期国债', 'treasury_bond')],
    valuations: [{ code: '019547', market_value: 3000 }]
  })
  assert.equal(out.items[0].actual_invested, 0)
  assert.equal(out.items[1].actual_invested, 3000)
})

test('目标配置：未归类资金单列提醒，计入总投入但不计入任何类别', () => {
  const out = run({
    plan: { total_amount: 10000 },
    items: [{ name: '宽基', ratio: 1, fund_codes: ['510300'], asset_types: [] }],
    holdingRows: [holding('510300', 7000, 9000), holding('999999', 5000, 6000)],
    fundRows: [fund('510300', '沪深300ETF'), fund('999999', '未归类基金')],
    valuations: [
      { code: '510300', market_value: 9000 },
      { code: '999999', market_value: 6000 }
    ]
  })
  assert.equal(out.items[0].actual_invested, 7000)
  assert.equal(out.unassigned.length, 1)
  assert.equal(out.unassigned[0].code, '999999')
  assert.equal(out.totals.actual_invested, 12000)
  assert.equal(out.totals.categorized_invested, 7000)
  assert.equal(out.totals.unassigned_invested, 5000)
  assert.ok(Math.abs(out.totals.completion - 1.2) < 1e-12)
  assert.ok(Math.abs(out.unassigned[0].market_value - 6000) < 1e-12)
  // 再平衡和资金占比只算已归类市值：宽基目标占比 100% → 差额 0、占比 100%
  assert.equal(out.totals.rebalance_base, 9000)
  assert.equal(out.items[0].rebalance_delta, 0)
  assert.equal(out.items[0].market_share, 1)
  assert.equal(out.items[0].deviation, 0)
  assert.equal(out.totals.categorized_invested, 7000)
  assert.equal(out.totals.categorized_completion, 0.7)
  assert.equal(out.totals.categorized_remaining, 3000)
})

test('目标配置：已关联但尚未买入的基金作为 0 持仓成员展示', () => {
  const out = run({
    plan: { total_amount: 10000 },
    items: [{ name: '黄金', ratio: 1, fund_codes: ['518880', '159934'], asset_types: [] }],
    holdingRows: [],
    fundRows: [fund('518880', '黄金ETF'), fund('159934', '黄金ETF联接')],
    valuations: []
  })
  assert.equal(out.items[0].members.length, 2)
  assert.equal(out.items[0].members.every((member) => member.held === false), true)
  assert.equal(out.items[0].actual_invested, 0)
  assert.equal(out.items[0].market_value, 0)
  assert.equal(out.totals.actual_invested, 0)
})

test('目标配置：分组小计（商品/另类）与再平衡差额', () => {
  const out = run({
    plan: { total_amount: 100000 },
    items: [
      { name: '原油QDII', ratio: 0.03, group_name: '商品/另类', fund_codes: ['161129'], asset_types: [] },
      { name: '有色ETF', ratio: 0.05, group_name: '商品/另类', fund_codes: ['512400'], asset_types: [] },
      { name: '豆粕ETF', ratio: 0.02, group_name: '商品/另类', fund_codes: ['159985'], asset_types: [] },
      { name: '宽基', ratio: 0.9, group_name: '', fund_codes: ['510300'], asset_types: [] }
    ],
    holdingRows: [
      holding('161129', 3000, 3600),
      holding('512400', 5000, 4500),
      holding('159985', 0, 0),
      holding('510300', 90000, 99000)
    ],
    fundRows: [
      fund('161129', '原油QDII'),
      fund('512400', '有色ETF'),
      fund('159985', '豆粕ETF'),
      fund('510300', '沪深300ETF')
    ],
    valuations: [
      { code: '161129', market_value: 3600 },
      { code: '512400', market_value: 4500 },
      { code: '159985', market_value: 0 },
      { code: '510300', market_value: 99000 }
    ]
  })
  assert.equal(out.groups.length, 1)
  const group = out.groups[0]
  assert.equal(group.name, '商品/另类')
  assert.ok(Math.abs(group.ratio - 0.1) < 1e-12)
  assert.equal(group.target_amount, 10000)
  assert.equal(group.actual_invested, 8000)
  assert.equal(group.market_value, 8100)
  // 宽基市值 99000，总市值 107100；宽基超配，再平衡差额 = 99000 - 0.9×107100
  const totalMarket = 107100
  const wide = out.items.find((item) => item.name === '宽基')
  assert.ok(Math.abs(wide.rebalance_delta - (99000 - 0.9 * totalMarket)) < 0.01)
  assert.ok(wide.deviation > 0)
})

test('目标配置：计划金额为 0 时完成度为 null，不产生除零', () => {
  const out = run({
    plan: { total_amount: 0 },
    items: [{ name: '宽基', ratio: 1, fund_codes: ['510300'], asset_types: [] }],
    holdingRows: [holding('510300', 1000, 1200)],
    fundRows: [fund('510300', '沪深300ETF')],
    valuations: [{ code: '510300', market_value: 1200 }]
  })
  assert.equal(out.items[0].target_amount, 0)
  assert.equal(out.items[0].completion, null)
  assert.equal(out.totals.completion, null)
  assert.equal(out.items[0].gap, -1000)
  // 有市值时再平衡差额仍可计算（100% 目标 + 全部市值 → 平衡）
  assert.equal(out.items[0].rebalance_delta, 0)
})

test('目标配置：完全没有市值时再平衡差额返回 null，页面显示「—」', () => {
  const out = run({
    plan: { total_amount: 100000 },
    items: [{ name: '宽基', ratio: 1, fund_codes: ['510300'], asset_types: [] }],
    holdingRows: [],
    fundRows: [fund('510300', '沪深300ETF')],
    valuations: []
  })
  assert.equal(out.items[0].rebalance_delta, null)
  assert.equal(out.items[0].market_share, null)
  assert.equal(out.items[0].deviation, null)
})

test('目标配置：实际投入按累计投入本金算，不扣现金分红', () => {
  const out = run({
    plan: { total_amount: 10000 },
    items: [{ name: '宽基', ratio: 1, fund_codes: ['510300'], asset_types: [] }],
    holdingRows: [{ fund_code: '510300', shares: 1000, invested: 980, deployed: 1000, avg_cost: 1 }],
    fundRows: [fund('510300', '沪深300ETF')],
    valuations: [{ code: '510300', market_value: 1000 }]
  })
  assert.equal(out.items[0].actual_invested, 1000)
  assert.equal(out.items[0].completion, 0.1)
  assert.equal(out.unassigned.length, 0)
})

test('目标配置校验：比例合计必须 100%', () => {
  const result = allocationPlanSchema.safeParse({
    name: '目标配置',
    total_amount: 100000,
    items: [
      { name: '宽基', ratio: 0.9, fund_codes: [], asset_types: [] },
      { name: '现金', ratio: 0.05, fund_codes: [], asset_types: [] }
    ]
  })
  assert.equal(result.success, false)
  assert.match(result.error.issues[0].message, /100%/)
})

test('目标配置校验：同一标的不能同时归入两个类别', () => {
  const result = allocationPlanSchema.safeParse({
    name: '目标配置',
    total_amount: 100000,
    items: [
      { name: '宽基', ratio: 0.5, fund_codes: ['510300'], asset_types: [] },
      { name: '黄金', ratio: 0.5, fund_codes: ['510300'], asset_types: [] }
    ]
  })
  assert.equal(result.success, false)
  assert.match(result.error.issues[0].message, /不能同时归入/)
})

test('目标配置校验：默认六大类比例可通过', () => {
  const result = allocationPlanSchema.safeParse({
    name: '目标配置',
    total_amount: 1000000,
    items: [
      { name: '宽基', ratio: 0.3, group_name: '', fund_codes: ['510300'], asset_types: [] },
      { name: '中长债', ratio: 0.2, group_name: '', fund_codes: [], asset_types: ['treasury_bond'] },
      { name: '短债', ratio: 0.2, group_name: '', fund_codes: [], asset_types: [] },
      { name: '黄金', ratio: 0.1, group_name: '', fund_codes: ['518880'], asset_types: [] },
      { name: '大宗商品', ratio: 0.1, group_name: '', fund_codes: ['161129', '512400', '159985'], asset_types: [] },
      { name: '现金', ratio: 0.1, group_name: '', fund_codes: [], asset_types: ['cash_flow', 'provident_fund'] }
    ]
  })
  assert.equal(result.success, true)
})

test('归类优先级：显式指定 > 资产类型；类型映射只取第一个命中', () => {
  const items = [
    { name: 'A', fund_codes: ['X'], asset_types: ['treasury_bond'] },
    { name: 'B', fund_codes: [], asset_types: ['treasury_bond'] }
  ]
  const funds = new Map([
    ['X', { code: 'X', asset_type: 'fund' }],
    ['Y', { code: 'Y', asset_type: 'treasury_bond' }]
  ])
  const map = classifyFunds(items, funds)
  assert.equal(map.get('X'), 0)
  assert.equal(map.get('Y'), 0)
})
