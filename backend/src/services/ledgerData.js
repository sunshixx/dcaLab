// 记账数据加载：交易流水、自动分红再投、手工标的估值
//
// 目标配置页与记账本/持仓页必须共用同一套口径（尤其是「累计净投入」和
// 「自动分红再投合成份额」），否则同一笔钱在两个页面会算出不同结果。
// 故把这些函数从 ledger 路由抽到这里，两边同时引用。
import { sql } from '../models/db.js'
import { navHistorySince } from './marketData.js'
import { computeHoldings, sharesForBuy, nearbyDividendExists } from './bookkeeping.js'

// 非基金类手工标的：没有公开净值接口，估值取最近一次录入价格/净值
export const MANUAL_ASSET_TYPES = new Set(['provident_fund', 'treasury_bond', 'reverse_repo', 'cash_flow'])

export const loadTxs = (fundCode) =>
  (fundCode
    ? sql.all('SELECT * FROM transactions WHERE fund_code = ? ORDER BY date ASC, id ASC', fundCode)
    : sql.all('SELECT * FROM transactions ORDER BY date ASC, id ASC')
  ).map((tx) =>
    tx.type === 'buy' || tx.type === 'dividend_reinvest' ? { ...tx, shares: sharesForBuy(tx) } : tx
  )

export function chronological(txs) {
  return [...txs].sort((a, b) => a.date.localeCompare(b.date) || (a.id || 0) - (b.id || 0))
}

export async function addAutomaticReinvestments(txs) {
  const codes = [...new Set(txs.filter((tx) => tx.type === 'buy').map((tx) => tx.fund_code))]
    .filter((code) => {
      const fund = sql.get('SELECT asset_type FROM funds WHERE code = ?', code)
      return !fund || fund.asset_type === 'fund'
    })
  const histories = await Promise.all(
    codes.map(async (code) => ({ code, rows: await navHistorySince(code, txs.filter((tx) => tx.fund_code === code)[0].date).catch(() => []) }))
  )
  const result = chronological(txs)
  let syntheticId = -1
  const events = histories
    .flatMap(({ code, rows }) => rows.filter((row) => row.dividend_per_share > 0).map((row) => ({ ...row, fund_code: code })))
    .sort((a, b) => a.date.localeCompare(b.date) || a.fund_code.localeCompare(b.fund_code))
  for (const event of events) {
    // 除息日与手动记账的到账日常差几天，±7 天内已有分红记录即视为同一笔
    const hasExplicitDividend = nearbyDividendExists(result, event.fund_code, event.date, 7)
    if (hasExplicitDividend || event.nav <= 0) continue
    const before = result.filter((tx) => tx.fund_code === event.fund_code && tx.date < event.date)
    const holding = computeHoldings(before).find((row) => row.fund_code === event.fund_code)
    if (!holding || holding.shares <= 0) continue
    const amount = holding.shares * event.dividend_per_share
    result.push({
      id: syntheticId--,
      fund_code: event.fund_code,
      date: event.date,
      type: 'dividend_reinvest',
      amount,
      nav: event.nav,
      shares: amount / event.nav,
      fee: 0,
      currency: 'CNY',
      fx_rate: 1,
      note: '自动分红再投资',
      auto_reinvest: true
    })
    result.sort((a, b) => a.date.localeCompare(b.date) || (a.id || 0) - (b.id || 0))
  }
  return result
}

export function latestManualPrice(txs, code) {
  const latest = [...txs].reverse().find((tx) => tx.fund_code === code && (tx.price > 0 || tx.nav > 0))
  return latest ? latest.price || latest.nav : 1
}

export function parseTiers(raw) {
  try {
    const tiers = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw
    return Array.isArray(tiers) ? tiers : []
  } catch {
    return []
  }
}

export function parseFundProfile(row) {
  return { ...row, redemption_fee_tiers: parseTiers(row.redemption_fee_tiers) }
}
