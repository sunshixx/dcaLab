// 模拟器状态：参数、默认标的模板、计算结果、方案存取
import { defineStore } from 'pinia'
import { api } from '../api.js'

// 四个标的的默认参数模板（费率取公开资料的行业典型值，均可改）
export const TEMPLATES = [
  {
    key: 'sp500',
    label: '标普500（QDII/联接）',
    asset: {
      name: '标普500',
      currency: 'USD',
      expected_return: 0.08,
      management_fee: 0.0075, // 联接基金 管理+托管 合计约 0.75%/年
      cash_drag: 0.005, // 场外联接留现金头寸的年化损耗
      dividend_yield: 0.013,
      dividend_tax_rate: 0.1, // QDII 股息预扣 10%
      capital_gains_tax_rate: 0,
      buy_premium: 0,
      premium_months: 0,
      sell_premium: 0,
      subscription_fee: 0.0012, // 申购费 1 折后 0.12%
      redemption_fee_tiers: [
        { max_days: 7, rate: 0.015 },
        { max_days: 365, rate: 0.005 },
        { max_days: 730, rate: 0.0025 },
        { max_days: null, rate: 0 }
      ],
      weight: 1
    }
  },
  {
    key: 'nasdaq100',
    label: '纳指100（QDII/联接）',
    asset: {
      name: '纳指100',
      currency: 'USD',
      expected_return: 0.09,
      management_fee: 0.0075,
      cash_drag: 0.005,
      dividend_yield: 0.005,
      dividend_tax_rate: 0.1,
      capital_gains_tax_rate: 0,
      buy_premium: 0,
      premium_months: 0,
      sell_premium: 0,
      subscription_fee: 0.0012,
      redemption_fee_tiers: [
        { max_days: 7, rate: 0.015 },
        { max_days: 365, rate: 0.005 },
        { max_days: 730, rate: 0.0025 },
        { max_days: null, rate: 0 }
      ],
      weight: 1
    }
  },
  {
    key: 'dividend_lowvol',
    label: '红利低波（A股 ETF）',
    asset: {
      name: '红利低波',
      currency: 'CNY',
      expected_return: 0.095,
      management_fee: 0.002, // 场内 ETF 0.2%/年
      cash_drag: 0,
      dividend_yield: 0.042,
      dividend_tax_rate: 0, // A股 持有超1年股息免征
      capital_gains_tax_rate: 0,
      buy_premium: 0,
      premium_months: 0,
      sell_premium: 0,
      subscription_fee: 0.0001, // 场内佣金 万1
      redemption_fee_tiers: [],
      weight: 1
    }
  },
  {
    key: 'hs300',
    label: '沪深300 / A500（A股 ETF）',
    asset: {
      name: '沪深300/A500',
      currency: 'CNY',
      expected_return: 0.07,
      management_fee: 0.002,
      cash_drag: 0,
      dividend_yield: 0.025,
      dividend_tax_rate: 0,
      capital_gains_tax_rate: 0,
      buy_premium: 0,
      premium_months: 0,
      sell_premium: 0,
      subscription_fee: 0.0001,
      redemption_fee_tiers: [],
      weight: 1
    }
  }
]

function cloneTemplate() {
  const params = {}
  for (const t of TEMPLATES) params[t.key] = JSON.parse(JSON.stringify(t.asset))
  return params
}

export const useCalcStore = defineStore('calc', {
  state: () => ({
    monthly_amount: 3000,
    contribution_frequency: 'monthly',
    daily_amount: 300,
    years: 20,
    selected: ['sp500', 'dividend_lowvol'],
    catalog: TEMPLATES.map((t) => ({ ...t, asset: JSON.parse(JSON.stringify(t.asset)) })),
    assetParams: cloneTemplate(),
    global: {
      exchange_rate: 7.0,
      fx_drift: 0,
      inflation: 0.025,
      enable_dynamic_switch: false,
      premium_threshold: 0.06,
      overflow_asset: JSON.parse(JSON.stringify(TEMPLATES[3].asset))
    },
    result: null,
    loading: false,
    error: '',
    plans: []
  }),
  actions: {
    buildPayload() {
      const assets = this.selected.map((k) => this.assetParams[k])
      return {
        monthly_amount: Number(this.monthly_amount),
        contribution_frequency: this.contribution_frequency,
        daily_amount: Number(this.daily_amount),
        years: Number(this.years),
        assets,
        global: {
          exchange_rate: Number(this.global.exchange_rate),
          fx_drift: Number(this.global.fx_drift),
          inflation: Number(this.global.inflation),
          enable_dynamic_switch: !!this.global.enable_dynamic_switch,
          premium_threshold: Number(this.global.premium_threshold),
          overflow_asset: this.global.overflow_asset
        }
      }
    },
    async calculate() {
      this.loading = true
      this.error = ''
      try {
        this.result = await api('/calculate', { method: 'POST', body: this.buildPayload() })
      } catch (e) {
        this.error = String(e.message || e)
        this.result = null
      } finally {
        this.loading = false
      }
    },
    async fetchPlans() {
      this.plans = await api('/plans')
    },
    async fetchSimulationContext() {
      const context = await api('/ledger/simulation-context')
      if (!context.assets || context.assets.length === 0) return false
      const base = JSON.parse(JSON.stringify(TEMPLATES[2].asset))
      this.catalog = context.assets.map((item) => ({
        key: item.code,
        label: `${item.name}（${item.code}）`,
        asset: {
          ...base,
          name: item.name,
          currency: item.currency || 'CNY',
          expected_return: item.expected_return,
          initial_value: item.initial_value,
          initial_cost: item.initial_cost,
          initial_investment: item.initial_investment,
          management_fee: item.management_fee ?? base.management_fee,
          subscription_fee: item.subscription_fee ?? base.subscription_fee,
          redemption_fee_tiers: item.redemption_fee_tiers?.length ? item.redemption_fee_tiers : base.redemption_fee_tiers,
          buy_premium: item.buy_premium_rate || 0,
          premium_months: item.buy_premium_rate > 0 ? 1 : 0,
          weight: 1
        },
        market: item
      }))
      this.assetParams = Object.fromEntries(this.catalog.map((item) => [item.key, item.asset]))
      this.selected = this.catalog.map((item) => item.key)
      const usdAsset = context.assets.find((item) => item.currency === 'USD' && item.fx_rate > 0)
      if (usdAsset) this.global.exchange_rate = usdAsset.fx_rate
      return true
    },
    async savePlan(name) {
      await api('/plans', { method: 'POST', body: { name, params: this.buildPayload() } })
      await this.fetchPlans()
    },
    async deletePlan(id) {
      await api(`/plans/${id}`, { method: 'DELETE' })
      await this.fetchPlans()
    },
    async loadPlan(id) {
      const p = await api(`/plans/${id}`)
      const params = p.params
      this.monthly_amount = params.monthly_amount
      this.contribution_frequency = params.contribution_frequency || 'monthly'
      this.daily_amount = params.daily_amount || 300
      this.years = params.years
      // 按名称匹配回模板槽位，未匹配的并入第一个空槽
      const keys = TEMPLATES.map((t) => t.key)
      const matched = new Set()
      for (const t of TEMPLATES) {
        const hit = params.assets.find((a) => a.name === t.asset.name)
        if (hit) {
          this.assetParams[t.key] = { ...JSON.parse(JSON.stringify(t.asset)), ...hit }
          matched.add(t.key)
        }
      }
      const extra = params.assets.filter((a) => !TEMPLATES.some((t) => t.asset.name === a.name))
      this.selected = [
        ...[...matched],
        ...extra.slice(0, keys.length).map((_x, i) => {
          // 附加标的占用后续模板槽位（简单处理：覆盖其参数并改名）
          const key = keys.find((k) => !matched.has(k))
          if (key) {
            this.assetParams[key] = { ...this.assetParams[key], ...extra[i] }
            matched.add(key)
            return key
          }
          return null
        })
      ].filter(Boolean)
      if (params.global) this.global = { ...this.global, ...params.global }
      await this.calculate()
    }
  }
})
