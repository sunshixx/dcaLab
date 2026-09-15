// API 请求体校验（zod）。所有比率均以小数传入（0.08 = 8%）。
import { z } from 'zod'

export const redemptionTierSchema = z.object({
  max_days: z.number().int().positive().nullable(), // null 表示“及以上”
  rate: z.number().min(0).max(0.2)
})

// 费率档按“第一个 max_days 满足持有天数的档位”取值，必须严格升序且 null 档只能在最后，
// 否则赎回费/模拟器会取错档（如 null 档在前则所有持有期都吃到该档费率）。
export const redemptionTiersSchema = z
  .array(redemptionTierSchema)
  .max(8)
  .default([])
  .superRefine((tiers, ctx) => {
    for (let i = 0; i < tiers.length; i++) {
      if (tiers[i].max_days == null && i < tiers.length - 1) {
        ctx.addIssue({ code: 'custom', message: '“及以上”档（max_days 为空）只能放在最后一档' })
      }
      const prev = tiers[i - 1]
      if (prev && prev.max_days != null && tiers[i].max_days != null && tiers[i].max_days <= prev.max_days) {
        ctx.addIssue({ code: 'custom', message: '赎回费档位 max_days 必须严格递增' })
      }
    }
  })

export const assetSchema = z.object({
  name: z.string().min(1).max(40),
  currency: z.enum(['CNY', 'USD']).default('CNY'),
  expected_return: z.number().min(-0.5).max(0.5),
  management_fee: z.number().min(0).max(0.05),
  cash_drag: z.number().min(0).max(0.05),
  dividend_yield: z.number().min(0).max(0.2),
  dividend_tax_rate: z.number().min(0).max(0.5),
  capital_gains_tax_rate: z.number().min(0).max(0.5),
  buy_premium: z.number().min(0).max(0.5),
  premium_months: z.number().int().min(0).max(600),
  sell_premium: z.number().min(-0.5).max(0.5),
  subscription_fee: z.number().min(0).max(0.05), // 申购费/佣金（每笔买入外扣）
  redemption_fee_tiers: redemptionTiersSchema,
  // 0 表示“只作为存量持仓、不参与定投分配”（公积金/现金流等一次性标的）
  weight: z.number().min(0).max(100).default(1),
  // 现金占净比（0~1）。场内 ETF 的真实现金头寸，可由东财资产配置接口取得。
  // 现金部分不参与市场增值，故拖累 = cash_ratio × expected_return，与下面手填的
  // cash_drag（场外联接的固定年化损耗）叠加。
  cash_ratio: z.number().min(0).max(1).default(0),
  initial_value: z.number().min(0).max(1e12).default(0),
  initial_cost: z.number().min(0).max(1e12).default(0),
  initial_investment: z.number().min(0).max(1e12).default(0)
})

export const globalSchema = z.object({
  exchange_rate: z.number().min(0.5).max(20).default(7.0), // CNY per USD
  fx_drift: z.number().min(-0.1).max(0.1).default(0),      // 人民币年化升/贬值
  inflation: z.number().min(0).max(0.2).default(0),        // 年化通胀（计算实际购买力）
  enable_dynamic_switch: z.boolean().default(false),
  premium_threshold: z.number().min(0).max(0.5).default(0.06),
  overflow_asset: assetSchema.optional() // 动态切换的“溢出桶”标的
})

export const calculateSchema = z
  .object({
    monthly_amount: z.number().min(1).max(10_000_000),
    contribution_frequency: z.enum(['monthly', 'trading_day', 'yearly']).default('monthly'),
    daily_amount: z.number().min(0.01).max(1_000_000).optional(),
    yearly_amount: z.number().min(0.01).max(100_000_000).optional(),
    years: z.number().int().min(1).max(50),
    assets: z.array(assetSchema).min(1).max(6),
    global: globalSchema.default({})
  })
  .superRefine((v, ctx) => {
    // 缺 daily_amount 时按交易日频率会把月金额当每日金额投入（放大 252 倍），必须显式报错
    if (v.contribution_frequency === 'trading_day' && !(v.daily_amount > 0)) {
      ctx.addIssue({ code: 'custom', path: ['daily_amount'], message: '按交易日定投必须提供每日定投金额 daily_amount' })
    }
    // 同理：按年定投缺 yearly_amount 会把月金额当年金额（缩水 12 倍）
    if (v.contribution_frequency === 'yearly' && !(v.yearly_amount > 0)) {
      ctx.addIssue({ code: 'custom', path: ['yearly_amount'], message: '按年定投必须提供每年定投金额 yearly_amount' })
    }
  })

export const planSchema = z.object({
  name: z.string().min(1).max(60),
  params: calculateSchema
})

export const fundSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/, '代码只能包含字母、数字、下划线或短横线（最多 20 位）').optional(),
  name: z.string().min(1).max(60).optional(),
  asset_type: z.enum(['fund', 'provident_fund', 'treasury_bond', 'reverse_repo', 'cash_flow']).default('fund'),
  type: z.string().max(30).optional(),
  note: z.string().max(200).optional()
  ,management_fee: z.number().min(0).max(0.05).default(0)
  ,custody_fee: z.number().min(0).max(0.05).default(0)
  ,subscription_fee: z.number().min(0).max(0.05).default(0)
  ,redemption_fee_tiers: redemptionTiersSchema
}).superRefine((fund, ctx) => {
  if (fund.asset_type === 'fund' && !fund.code) ctx.addIssue({ code: 'custom', path: ['code'], message: '基金必须填写代码' })
  if (fund.asset_type !== 'fund' && !fund.name) ctx.addIssue({ code: 'custom', path: ['name'], message: '非基金标的请填写名称' })
})

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const isRealDate = (value) => {
  if (!DATE_RE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return date.toISOString().slice(0, 10) === value
}

export const transactionSchema = z
  .object({
    fund_code: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/),
    date: z.string().refine(isRealDate, '日期必须是有效的 YYYY-MM-DD 日期'),
    type: z.enum(['buy', 'sell', 'dividend_cash', 'dividend_reinvest', 'fee']),
    amount: z.number().min(0).max(1e9).default(0),
    nav: z.number().min(0).max(1e5).default(0),
    price: z.number().min(0).max(1e7).default(0),
    premium_rate: z.number().min(-0.5).max(0.5).nullable().default(null),
    shares: z.number().min(0).max(1e9).default(0),
    fee: z.number().min(0).max(1e7).default(0),
    currency: z.enum(['CNY', 'USD']).default('CNY'),
    fx_rate: z.number().min(0).max(100).default(0),
    note: z.string().max(200).default('')
    ,nominal_days: z.number().int().positive().nullable().default(null)
    ,annual_rate: z.number().min(0).max(1).nullable().default(null)
    ,commission_rate: z.number().min(0).max(0.1).nullable().default(null)
    ,tax_rate: z.number().min(0).max(1).nullable().default(null)
    ,face_value: z.number().min(0).max(1e12).nullable().default(null)
    ,last_interest_date: z.string().nullable().default(null)
    ,maturity_date: z.string().nullable().default(null)
    ,first_settlement_date: z.string().nullable().default(null)
    ,expiry_date: z.string().nullable().default(null)
    ,interest_days: z.number().int().nullable().default(null)
    ,occupied_days: z.number().int().nullable().default(null)
    ,expected_interest: z.number().nullable().default(null)
    ,expected_net_income: z.number().nullable().default(null)
  })
  .superRefine((t, ctx) => {
    if (t.type === 'buy' || t.type === 'dividend_reinvest') {
      if (t.amount <= 0) ctx.addIssue({ code: 'custom', message: '买入金额必须大于 0' })
      if (t.nav <= 0) ctx.addIssue({ code: 'custom', message: '买入需提供成交净值' })
      if (t.currency === 'USD' && t.price <= 0) ctx.addIssue({ code: 'custom', message: '美元交易需提供成交价格' })
      if (t.fee > t.amount) ctx.addIssue({ code: 'custom', message: '手续费不能高于实际扣款金额' })
    }
    if (t.type === 'sell' && t.shares <= 0) {
      ctx.addIssue({ code: 'custom', message: '卖出需提供份额' })
    }
    if (t.type === 'sell' && t.amount <= 0) {
      ctx.addIssue({ code: 'custom', message: '卖出需提供卖出总额' })
    }
    if (t.type === 'sell' && t.fee > t.amount) {
      ctx.addIssue({ code: 'custom', message: '赎回费不能高于卖出总额' })
    }
    if (t.type === 'dividend_cash' && t.amount <= 0) {
      ctx.addIssue({ code: 'custom', message: '分红金额必须大于 0' })
    }
  })

export const importCsvSchema = z.object({
  csv: z.string().min(1).max(2_000_000)
})
