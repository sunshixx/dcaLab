import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDividendPerShare, selectValuation } from '../src/services/marketData.js'

test('持仓估值优先使用单位净值估算，但基准日恒为已公布净值日期', () => {
  const valuation = selectValuation(
    { nav: 1.2, nav_date: '2026-09-10' },
    { estimated_nav: 1.25, as_of: '2026-09-14 15:00' }
  )
  assert.deepEqual(valuation, {
    nav: 1.25,
    date: '2026-09-10', // 基准日不随估算改变
    estimateTime: '2026-09-14 15:00', // 估算时点单独成字段
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
    estimateTime: '',
    source: '最近净值'
  })
})

// ── 回归：估值基准日必须稳定，不能在「估算时点」和「净值日期」之间跳动 ──
test('估值基准日不因盘中估算是否可用而改变', () => {
  const latest = { nav: 1.2, nav_date: '2026-09-10' }
  const withEstimate = selectValuation(latest, { estimated_nav: 1.25, as_of: '2026-09-14 15:00' })
  const withoutEstimate = selectValuation(latest, null)
  assert.equal(withEstimate.date, withoutEstimate.date, '有/无估算时基准日必须一致')
  assert.equal(withEstimate.date, '2026-09-10')
  // 估算时点只出现在 estimateTime，不得污染 date
  assert.notEqual(withEstimate.date, withEstimate.estimateTime)
})

test('估算值与净值都不可用时返回 null', () => {
  assert.equal(selectValuation(null, null), null)
  assert.equal(selectValuation({ nav: 0, nav_date: '' }, null), null)
})

test('分红字段：只解析明确的每 N 份派息格式', () => {
  assert.equal(parseDividendPerShare('每10份基金份额派发0.50元'), 0.05)
  assert.equal(parseDividendPerShare('每10份派0.50元'), 0.05)
  assert.equal(parseDividendPerShare(''), 0)
  assert.equal(parseDividendPerShare('净值波动'), 0)
})