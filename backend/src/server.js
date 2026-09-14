// DCA-Lab 后端入口：Express 5，端口 3001
import express from 'express'
import calculateRoutes from './routes/calculate.js'
import plansRoutes from './routes/plans.js'
import ledgerRoutes from './routes/ledger.js'
import marketRoutes from './routes/market.js'
import reviewRoutes from './routes/review.js'

const app = express()
app.use(express.json({ limit: '4mb' }))

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'dca-cost-lab-backend' }))
app.use('/api/calculate', calculateRoutes)
app.use('/api/plans', plansRoutes)
app.use('/api/ledger', ledgerRoutes)
app.use('/api/market', marketRoutes)
app.use('/api/review', reviewRoutes)

app.use((_req, res) => res.status(404).json({ error: '接口不存在' }))
// 统一错误出口
app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: '服务器内部错误' })
})

const PORT = Number(process.env.PORT || 3001)
app.listen(PORT, () => {
  console.log(`[dca-cost-lab] backend listening on http://localhost:${PORT}`)
})
