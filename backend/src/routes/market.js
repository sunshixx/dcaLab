// 行情代理：基金查询 / 历史净值
import { Router } from 'express'
import { fundSnapshot, navHistory } from '../services/marketData.js'

const r = Router()

const CODE_RE = /^\d{6}$/

// 信息 + 单位净值估值（合并快照）
r.get('/fund/:code', async (req, res) => {
  const code = req.params.code
  if (!CODE_RE.test(code)) return res.status(400).json({ error: '基金代码须为 6 位数字' })
  const snap = await fundSnapshot(code)
  if (!snap.found && !(snap.valuation_nav > 0)) return res.status(404).json({ error: '未查询到该基金代码' })
  res.json(snap)
})

// 历史净值（?limit=&page=）
r.get('/fund/:code/navs', async (req, res) => {
  const code = req.params.code
  if (!CODE_RE.test(code)) return res.status(400).json({ error: '基金代码须为 6 位数字' })
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 30)
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 100)
  const rows = await navHistory(code, { pageSize: limit, pageIndex: page })
  if (!rows) return res.status(502).json({ error: '历史净值接口暂不可用' })
  res.json(rows)
})

export default r
