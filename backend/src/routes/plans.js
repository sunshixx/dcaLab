// 方案保存/加载/删除（参数绑定查询）
import { Router } from 'express'
import { sql } from '../models/db.js'
import { planSchema } from '../models/schemas.js'

const r = Router()

r.get('/', (_req, res) => {
  res.json(sql.all('SELECT id, name, created_at FROM plans ORDER BY id DESC'))
})

r.get('/:id', (req, res) => {
  const row = sql.get('SELECT id, name, created_at, params FROM plans WHERE id = ?', Number(req.params.id))
  if (!row) return res.status(404).json({ error: '方案不存在' })
  row.params = JSON.parse(row.params)
  res.json(row)
})

r.post('/', (req, res) => {
  const parsed = planSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: '参数校验失败', issues: parsed.error.issues })
  }
  const { name, params } = parsed.data
  const ret = sql.run('INSERT INTO plans (name, params) VALUES (?, ?)', name, JSON.stringify(params))
  res.status(201).json({ id: Number(ret.lastInsertRowid), name })
})

r.delete('/:id', (req, res) => {
  const ret = sql.run('DELETE FROM plans WHERE id = ?', Number(req.params.id))
  if (ret.changes === 0) return res.status(404).json({ error: '方案不存在' })
  res.json({ ok: true })
})

export default r
