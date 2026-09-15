import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateReverseRepo, isChinaBusinessDay } from '../src/services/chinaFixedIncome.js'

test('中国逆回购普通交易日：利息日和资金占用日分开计算', () => {
  const result = calculateReverseRepo({ date: '2026-09-16', nominalDays: 1, principal: 100000, annualRate: 0.025, commissionRate: 0.00001 })
  assert.equal(result.firstSettlementDate, '2026-09-17')
  assert.equal(result.expiryDate, '2026-09-18')
  assert.equal(result.interestDays, 1)
  assert.equal(result.occupiedDays, 2)
  assert.ok(Math.abs(result.expectedNetIncome - 4.48) < 0.01)
})

test('国庆前逆回购顺延交收，但利息仍按实际计息日计算', () => {
  const result = calculateReverseRepo({ date: '2026-09-30', nominalDays: 1, principal: 100000, annualRate: 0.035, commissionRate: 0.00001 })
  assert.equal(result.firstSettlementDate, '2026-10-08')
  assert.equal(result.expiryDate, '2026-10-09')
  assert.equal(result.interestDays, 1)
  assert.equal(result.occupiedDays, 9)
})

test('逆回购交易日校验：中国休市日不可交易', () => {
  assert.equal(isChinaBusinessDay('2026-10-01'), false)
  assert.equal(isChinaBusinessDay('2026-09-16'), true)
})