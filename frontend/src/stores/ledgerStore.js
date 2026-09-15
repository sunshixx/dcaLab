// 记账本状态：基金、流水、持仓、统计
import { defineStore } from 'pinia'
import { api } from '../api.js'

export const useLedgerStore = defineStore('ledger', {
  state: () => ({
    funds: [],
    transactions: [],
    holdings: [],
    stats: null,
    series: null,
    filterFund: '',
    page: 1,
    pageSize: 20,
    loading: false,
    error: ''
  }),
  getters: {
    // 过滤后的全量流水（按日期倒序，最新在前）——用于统计总条数
    filteredTxs(state) {
      const list = state.filterFund
        ? state.transactions.filter((t) => t.fund_code === state.filterFund)
        : [...state.transactions]
      return list.reverse()
    },
    totalPages() {
      return Math.max(1, Math.ceil(this.filteredTxs.length / this.pageSize))
    },
    // 页码做钳制，删记录后页码越界也不会显示空页
    currentPage() {
      return Math.min(Math.max(1, this.page), this.totalPages)
    },
    // 当前页实际渲染的流水
    pagedTxs() {
      const start = (this.currentPage - 1) * this.pageSize
      return this.filteredTxs.slice(start, start + this.pageSize)
    },
    fundNameMap(state) {
      return new Map(state.funds.map((f) => [f.code, f.name]))
    }
  },
  actions: {
    setPage(p) {
      this.page = Math.min(Math.max(1, Number(p) || 1), this.totalPages)
    },
    setPageSize(n) {
      const size = Number(n) > 0 ? Number(n) : 20
      this.pageSize = size
      this.page = 1
    },
    async loadAll() {
      this.loading = true
      this.error = ''
      try {
        const [funds, txs] = await Promise.all([api('/ledger/funds'), api('/ledger/transactions')])
        this.funds = funds
        this.transactions = txs
      } catch (e) {
        this.error = String(e.message || e)
      } finally {
        this.loading = false
      }
    },
    async addFund(payload) {
      const result = await api('/ledger/funds', { method: 'POST', body: payload })
      await this.loadAll()
      return result
    },
    async removeFund(code) {
      await api(`/ledger/funds/${code}`, { method: 'DELETE' })
      await this.loadAll()
    },
    async addTx(payload) {
      await api('/ledger/transactions', { method: 'POST', body: payload })
      await this.loadAll()
      this.page = 1 // 新记录按日期倒序排在最前，跳回第 1 页让用户直接看到
    },
    async removeTx(id) {
      await api(`/ledger/transactions/${id}`, { method: 'DELETE' })
      await this.loadAll()
    },
    async loadHoldings({ fresh = false } = {}) {
      this.holdings = await api(`/ledger/holdings${fresh ? '?refresh=1' : ''}`)
    },
    async loadStats({ fresh = false } = {}) {
      this.stats = await api(`/ledger/stats${fresh ? '?refresh=1' : ''}`)
    },
    async loadSeries() {
      this.series = await api('/ledger/series')
    },
    async importCsv(text) {
      return api('/ledger/import.csv', { method: 'POST', body: { csv: text } })
    }
  }
})
