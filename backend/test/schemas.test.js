import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transactionSchema } from '../src/models/schemas.js'

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