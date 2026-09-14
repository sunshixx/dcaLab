// POST /api/calculate —— 定投模拟（含三情景）
import { Router } from 'express'
import { calculateSchema } from '../models/schemas.js'
import { simulateWithScenarios } from '../services/simulator.js'

const r = Router()

r.post('/', (req, res) => {
  const parsed = calculateSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({
      error: '参数校验失败',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    })
  }
  try {
    const result = simulateWithScenarios(parsed.data)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: `模拟失败：${e.message}` })
  }
})

export default r
