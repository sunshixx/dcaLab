const REPO_TERMS = [1, 2, 3, 4, 7, 14, 28, 91, 182]

// 交易所日历应最终由公告数据驱动；先覆盖当前使用的 2026 年中国休市日。
const HOLIDAYS_2026 = new Set([
  '2026-01-01', '2026-01-02', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
  '2026-04-04', '2026-04-05', '2026-04-06', '2026-05-01', '2026-05-02', '2026-05-03',
  '2026-06-19', '2026-06-20', '2026-06-21', '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'
])

const iso = (date) => date.toISOString().slice(0, 10)
const parseDate = (value) => new Date(`${value}T00:00:00Z`)
const isBusinessDay = (date) => date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !HOLIDAYS_2026.has(iso(date))

export function isChinaBusinessDay(value) {
  const date = parseDate(value)
  return !Number.isNaN(date.getTime()) && isBusinessDay(date)
}

function nextBusinessDay(date) {
  const result = new Date(date)
  while (!isBusinessDay(result)) result.setUTCDate(result.getUTCDate() + 1)
  return result
}

export function calculateReverseRepo({ date, nominalDays, principal, annualRate, commissionRate = 0, taxRate = 0.2 }) {
  if (!REPO_TERMS.includes(nominalDays)) throw new Error('逆回购期限只能是 1/2/3/4/7/14/28/91/182 天')
  const tradeDate = parseDate(date)
  const firstSettlement = nextBusinessDay(new Date(tradeDate.getTime() + 86400000))
  const expiryBase = new Date(firstSettlement)
  expiryBase.setUTCDate(expiryBase.getUTCDate() + nominalDays)
  const expiry = nextBusinessDay(expiryBase)
  const interestDays = Math.round((expiry - firstSettlement) / 86400000)
  const occupiedDays = Math.round((expiry - tradeDate) / 86400000)
  const interest = principal * annualRate * interestDays / 365
  const commission = principal * commissionRate
  const tax = interest * taxRate
  return {
    firstSettlementDate: iso(firstSettlement),
    expiryDate: iso(expiry),
    interestDays,
    occupiedDays,
    expectedInterest: interest,
    expectedNetIncome: interest - commission - tax,
    commission,
    tax
  }
}

export { REPO_TERMS }