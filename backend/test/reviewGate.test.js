import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cnReportGate } from '../src/services/reviewRefresher.js'

// 闸门依赖「当前 CST 时间」，为可测试需固定 now。
// 这里通过传入历史日期来验证放行逻辑，并单独校验盘中拦截的时点边界。
// cnReportGate 用真实当前时间判定，因此：
//   - 传入非今天的日期 → 一律放行（历史数据已结算）
//   - 传入今天 → 取决于当前时刻是否已过 15:35 CST

const todayCST = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date())

const cstNow = () => {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date())
  const get = (t) => Number(p.find((x) => x.type === t)?.value || 0)
  return get('hour') * 60 + get('minute')
}

test('历史日期一律放行（数据已结算）', () => {
  assert.equal(cnReportGate('2026-09-11').allowed, true)
  assert.equal(cnReportGate('2020-01-02').allowed, true)
})

test('未来日期放行（不走当日拦截分支）', () => {
  assert.equal(cnReportGate('2099-12-31').allowed, true)
})

test('今天：收盘结算前拦截，结算后放行', () => {
  const gate = cnReportGate(todayCST())
  const minutes = cstNow()
  const readyAt = 15 * 60 + 35
  const isWeekendOrHoliday = !isBusiness(todayCST())
  if (isWeekendOrHoliday) {
    assert.equal(gate.allowed, true, '休市日应放行以生成休市分支报告')
  } else if (minutes < readyAt) {
    assert.equal(gate.allowed, false, `当前 ${minutes} 分早于 ${readyAt}，应拦截`)
    assert.ok(gate.reason.includes('尚未完成收盘结算'), '拦截原因应说明收盘结算')
  } else {
    assert.equal(gate.allowed, true, `当前 ${minutes} 分已过 ${readyAt}，应放行`)
  }
})

function isBusiness(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  const holidays = new Set([
    '2026-01-01', '2026-01-02', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
    '2026-04-04', '2026-04-05', '2026-04-06', '2026-05-01', '2026-05-02', '2026-05-03',
    '2026-06-19', '2026-06-20', '2026-06-21', '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'
  ])
  return !holidays.has(dateStr)
}
