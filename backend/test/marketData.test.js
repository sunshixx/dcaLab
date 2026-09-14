import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDividendPerShare, selectValuation } from '../src/services/marketData.js'

test('持仓估值优先使用单位净值估算，不使用场内现价', () => {
  const valuation = selectValuation(
    { nav: 1.2, nav_date: '2026-09-10' },
    { estimated_nav: 1.25, as_of: '2026-09-14 15:00' }
  )
  assert.deepEqual(valuation, {
    nav: 1.25,
    date: '2026-09-14 15:00',
    source: '盘中估算'
  })
})

test('没有盘中估算时使用最近已公布单位净值', () => {
  const valuation = selectValuation(
    { nav: 1.2, nav_date: '2026-09-10' },
    null
  )
  assert.deepEqual(valuation, {
    nav: 1.2,
    date: '2026-09-10',
    source: '最近净值'
  })
})

test('分红字段：只解析明确的每 N 份派息格式', () => {
  assert.equal(parseDividendPerShare('每10份基金份额派发0.50元'), 0.05)
  assert.equal(parseDividendPerShare('每10份派0.50元'), 0.05)
  assert.equal(parseDividendPerShare(''), 0)
  assert.equal(parseDividendPerShare('净值波动'), 0)
})