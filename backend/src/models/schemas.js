// API 请求体校验（zod）。所有比率均以小数传入（0.08 = 8%）。
import { z } from 'zod'

export const redemptionTierSchema = z.object({
  max_days: z.number().int().positive().nullable(), // null 表示“及以上”
  rate: z.number().min(0).max(0.2)
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
  redemption_fee_tiers: z.array(redemptionTierSchema).max(8).default([]),
  weight: z.number().min(0.01).max(100).default(1),
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

export const calculateSchema = z.object({
  monthly_amount: z.number().min(1).max(10_000_000),
  contribution_frequency: z.enum(['monthly', 'trading_day']).default('monthly'),
  daily_amount: z.number().min(0.01).max(1_000_000).optional(),
  years: z.number().int().min(1).max(50),
  assets: z.array(assetSchema).min(1).max(6),
  global: globalSchema.default({})
})

export const planSchema = z.object({
  name: z.string().min(1).max(60),
  params: calculateSchema
})

export const fundSchema = z.object({
  code: z.string().regex(/^(?:\d{6}|[A-Za-z]{1,8})$/, '请输入 6 位基金代码或美股 ticker'),
  name: z.string().min(1).max(60).optional(),
  type: z.string().max(30).optional(),
  note: z.string().max(200).optional()
  ,management_fee: z.number().min(0).max(0.05).default(0)
  ,custody_fee: z.number().min(0).max(0.05).default(0)
  ,subscription_fee: z.number().min(0).max(0.05).default(0)
  ,redemption_fee_tiers: z.array(redemptionTierSchema).max(8).default([])
})

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const isRealDate = (value) => {
  if (!DATE_RE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return date.toISOString().slice(0, 10) === value
}

export const transactionSchema = z
  .object({
    fund_code: z.string().regex(/^(?:\d{6}|[A-Za-z]{1,8})$/),
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
