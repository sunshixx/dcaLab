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
    loading: false,
    error: ''
  }),
  getters: {
    filteredTxs(state) {
      if (!state.filterFund) return [...state.transactions].reverse()
      return state.transactions.filter((t) => t.fund_code === state.filterFund).reverse()
    },
    fundNameMap(state) {
      return new Map(state.funds.map((f) => [f.code, f.name]))
    }
  },
  actions: {
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
      await api('/ledger/funds', { method: 'POST', body: payload })
      await this.loadAll()
    },
    async removeFund(code) {
      await api(`/ledger/funds/${code}`, { method: 'DELETE' })
      await this.loadAll()
    },
    async addTx(payload) {
      await api('/ledger/transactions', { method: 'POST', body: payload })
      await this.loadAll()
    },
    async removeTx(id) {
      await api(`/ledger/transactions/${id}`, { method: 'DELETE' })
      await this.loadAll()
    },
    async loadHoldings() {
      this.holdings = await api('/ledger/holdings')
    },
    async loadStats() {
      this.stats = await api('/ledger/stats')
    },
    async loadSeries() {
      this.series = await api('/ledger/series')
    },
    async importCsv(text) {
      return api('/ledger/import.csv', { method: 'POST', body: { csv: text } })
    }
  }
})
