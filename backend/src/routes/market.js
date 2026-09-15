// 行情代理：基金查询 / 历史净值 / 资产配置
import { Router } from 'express'
import { fundSnapshot, navHistory, fundAssetAllocation } from '../services/marketData.js'

const r = Router()

const CODE_RE = /^(?:\d{6}|[A-Za-z]{1,8})$/

// 信息 + 单位净值估值（合并快照）
r.get('/fund/:code', async (req, res) => {
  const code = req.params.code
  if (!CODE_RE.test(code)) return res.status(400).json({ error: '请输入 6 位基金代码或美股 ticker' })
  const snap = await fundSnapshot(code, { date: String(req.query.date || '') })
  if (!snap.found && !(snap.valuation_nav > 0)) return res.status(404).json({ error: '未查询到该基金代码' })
  res.json(snap)
})

// 历史净值（?limit=&page=）
r.get('/fund/:code/navs', async (req, res) => {
  const code = req.params.code
  if (!CODE_RE.test(code)) return res.status(400).json({ error: '请输入 6 位基金代码或美股 ticker' })
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '美股 ETF 暂无历史净值接口' })
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 30)
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 100)
  const rows = await navHistory(code, { pageSize: limit, pageIndex: page })
  if (!rows) return res.status(502).json({ error: '历史净值接口暂不可用' })
  res.json(rows)
})

// 基金资产配置（股票/债券/现金占净比）——供模拟器真实计算场内现金拖累
// ?refresh=1 绕过缓存
r.get('/fund/:code/allocation', async (req, res) => {
  const code = req.params.code
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '资产配置仅支持 6 位中国基金代码' })
  const alloc = await fundAssetAllocation(code, { fresh: req.query.refresh === '1' }).catch(() => null)
  if (!alloc) return res.status(404).json({ error: '未取得该基金的资产配置数据（可能尚未披露定期报告）' })
  res.json(alloc)
})

export default r
