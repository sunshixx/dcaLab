import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transactionSchema, fundSchema, calculateSchema } from '../src/models/schemas.js'

const base = {
  fund_code: '000001',
  date: '2026-09-10',
  type: 'buy',
  amount: 100,
  nav: 2,
  shares: 0,
  fee: 1,
  note: ''
}

test('交易校验：买入手续费不能超过实际扣款', () => {
  const result = transactionSchema.safeParse({ ...base, fee: 101 })
  assert.equal(result.success, false)
})

test('交易校验：卖出赎回费不能超过卖出总额', () => {
  const result = transactionSchema.safeParse({ ...base, type: 'sell', shares: 10, fee: 101 })
  assert.equal(result.success, false)
})

test('交易校验：正常定投交易通过', () => {
  const result = transactionSchema.safeParse(base)
  assert.equal(result.success, true)
})

test('交易校验：卖出必须提供卖出总额', () => {
  const result = transactionSchema.safeParse({ ...base, type: 'sell', shares: 10, amount: 0 })
  assert.equal(result.success, false)
})

test('记账标的支持公积金、国债、国债逆回购和现金流', () => {
  for (const asset_type of ['provident_fund', 'treasury_bond', 'reverse_repo', 'cash_flow']) {
    const result = fundSchema.safeParse({ code: asset_type === 'provident_fund' ? 'GJJ' : '204001', name: asset_type, asset_type })
    assert.equal(result.success, true)
  }
})

// ── 回归：赎回费档位顺序 ──
const tierBase = { code: '000001', name: '测试基金' }

test('费率档：升序且 null 在最后 → 通过', () => {
  const result = fundSchema.safeParse({
    ...tierBase,
    redemption_fee_tiers: [
      { max_days: 7, rate: 0.015 },
      { max_days: 365, rate: 0.005 },
      { max_days: 730, rate: 0.0025 },
      { max_days: null, rate: 0 }
    ]
  })
  assert.equal(result.success, true)
})

test('费率档：null 档不在最后 → 拒绝', () => {
  const result = fundSchema.safeParse({
    ...tierBase,
    redemption_fee_tiers: [
      { max_days: null, rate: 0 },
      { max_days: 7, rate: 0.015 }
    ]
  })
  assert.equal(result.success, false)
})

test('费率档：max_days 非递增 → 拒绝', () => {
  const result = fundSchema.safeParse({
    ...tierBase,
    redemption_fee_tiers: [
      { max_days: 365, rate: 0.005 },
      { max_days: 7, rate: 0.015 }
    ]
  })
  assert.equal(result.success, false)
})

// ── 回归：trading_day 缺 daily_amount ──
const calcAsset = {
  name: '测试标的',
  expected_return: 0.07,
  management_fee: 0.002,
  cash_drag: 0,
  dividend_yield: 0,
  dividend_tax_rate: 0,
  capital_gains_tax_rate: 0,
  buy_premium: 0,
  premium_months: 0,
  sell_premium: 0,
  subscription_fee: 0
}

test('模拟参数：trading_day 缺 daily_amount → 拒绝', () => {
  const result = calculateSchema.safeParse({
    monthly_amount: 1000,
    contribution_frequency: 'trading_day',
    years: 1,
    assets: [calcAsset]
  })
  assert.equal(result.success, false)
})

test('模拟参数：trading_day 带 daily_amount → 通过', () => {
  const result = calculateSchema.safeParse({
    monthly_amount: 1000,
    daily_amount: 100,
    contribution_frequency: 'trading_day',
    years: 1,
    assets: [calcAsset]
  })
  assert.equal(result.success, true)
})