import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sharesForBuy, computeHoldings, portfolioXirr } from '../src/services/bookkeeping.js'

test('实际扣款口径：自动份额扣除手续费，真实确认份额保持不变', () => {
  assert.equal(sharesForBuy({ amount: 1000, fee: 1, nav: 2, shares: 0 }), 499.5)
  assert.equal(sharesForBuy({ amount: 1000, fee: 1, nav: 2, shares: 499.5 }), 499.5)
  assert.equal(sharesForBuy({ amount: 1000, fee: 1, nav: 2, shares: 500 }), 499.5)
  assert.equal(sharesForBuy({ amount: 1000, fee: 1, nav: 2, shares: 498 }), 498)
})

test('现金分红降低净投入但不改变当前持仓成本', () => {
  const [h] = computeHoldings([
    { fund_code: '000001', type: 'buy', amount: 1000, fee: 1, nav: 2, shares: 0 },
    { fund_code: '000001', type: 'dividend_cash', amount: 20, fee: 0, nav: 0, shares: 0 }
  ])
  assert.equal(h.shares, 499.5)
  assert.equal(h.total_cost, 1000)
  assert.equal(h.invested, 980)
  assert.equal(h.dividend_cash_total, 20)
})

test('组合 XIRR：期末市值与现金分红均作为流入，买入按实际扣款流出', () => {
  const r = portfolioXirr(
    [
      { date: '2024-01-01', type: 'buy', amount: 1000, fee: 1 },
      { date: '2024-07-01', type: 'dividend_cash', amount: 20, fee: 0 }
    ],
    [{ code: '000001', value: 1000 }]
  )
  assert.ok(Number.isFinite(r) && r > 0, `xirr=${r}`)
})

test('累计实际投入作为简单收益率分母，不因卖出回款而被放大', () => {
  const [h] = computeHoldings([
    { fund_code: '000001', type: 'buy', amount: 1000, fee: 0, nav: 1, shares: 1000 },
    { fund_code: '000001', type: 'sell', amount: 600, fee: 0, nav: 1, shares: 500 }
  ])
  const currentValue = h.shares * 1
  const totalPl = currentValue - h.total_cost + h.realized_pl
  assert.equal(totalPl, 100)
  assert.equal(h.contributed, 1000)
  assert.equal(totalPl / h.contributed, 0.1)
})