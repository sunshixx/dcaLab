// 数字/百分比格式化工具

export function fmtMoney(x, dash = '—') {
  if (x == null || !Number.isFinite(x)) return dash
  return x.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

// 大额自动换算为“万元”
export function fmtWan(x, dash = '—') {
  if (x == null || !Number.isFinite(x)) return dash
  if (Math.abs(x) >= 100000) return (x / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' 万'
  return x.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

export function fmtPct(x, digits = 2, dash = '—') {
  if (x == null || !Number.isFinite(x)) return dash
  return (x * 100).toFixed(digits) + '%'
}

// 小数 ↔ 百分数输入框
export function toPctInput(v) {
  return v == null || v === '' ? '' : String(Number((v * 100).toFixed(4)))
}
export function fromPctInput(s) {
  const n = parseFloat(s)
  return Number.isFinite(n) ? n / 100 : 0
}

export const TX_TYPE_CN = {
  buy: '买入',
  sell: '卖出',
  dividend_cash: '现金分红',
  dividend_reinvest: '分红再投',
  fee: '费用调整'
}
