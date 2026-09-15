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

// 默认每期定投额（月投口径）；两个默认标的合计 3000，与旧版默认一致
const DEFAULT_DCA_AMOUNT = 1500

function cloneTemplate() {
  const params = {}
  for (const t of TEMPLATES) {
    params[t.key] = JSON.parse(JSON.stringify(t.asset))
    params[t.key].dca_amount = DEFAULT_DCA_AMOUNT
  }
  return params
}

// 一个月的交易日数（252/12），用于「月投 ↔ 日投」金额换算
export const TRADING_DAYS_PER_MONTH = 21
// 各定投频率的每年期数，用于频率间金额换算（保持年投入总额不变）
export const PERIODS_PER_YEAR = { trading_day: 252, monthly: 12, yearly: 1 }
const round2 = (x) => Math.round(x * 100) / 100

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
  getters: {
    // 每期定投合计 = 各已选标的自己的定投金额之和（总投入不再均分给所有标的）
    totalContribution(state) {
      return round2(
        state.selected.reduce((s, k) => s + (Number(state.assetParams[k]?.dca_amount) || 0), 0)
      )
    }
  },
  actions: {
    setDcaAmount(key, amount) {
      if (!this.assetParams[key]) return
      this.assetParams[key].dca_amount = round2(Math.max(0, Number(amount) || 0))
    },
    // 直接改合计：按现有比例等比缩放各标的金额
    setTotalContribution(total) {
      const t = Math.max(0, Number(total) || 0)
      const keys = [...this.selected]
      if (!keys.length) return
      const sum = keys.reduce((s, k) => s + (Number(this.assetParams[k]?.dca_amount) || 0), 0)
      if (sum <= 0) {
        const each = round2(t / keys.length)
        for (const k of keys) this.assetParams[k].dca_amount = each
        return
      }
      let acc = 0
      keys.forEach((k, i) => {
        const v = i === keys.length - 1
          ? round2(t - acc)
          : round2(((Number(this.assetParams[k].dca_amount) || 0) * t) / sum)
        acc = round2(acc + v)
        this.assetParams[k].dca_amount = v
      })
    },
    // 切换定投频率时逐标的换算金额，保持「年投入总额」不变。
    // 若只改频率不换算，总投入会静默变化（日投↔月投差 21 倍，月投↔年投差 12 倍）。
    setFrequency(freq) {
      if (freq === this.contribution_frequency) return
      const fromPPY = PERIODS_PER_YEAR[this.contribution_frequency] || 12
      const toPPY = PERIODS_PER_YEAR[freq] || 12
      const factor = fromPPY / toPPY
      for (const k of Object.keys(this.assetParams)) {
        const cur = Number(this.assetParams[k].dca_amount) || 0
        this.assetParams[k].dca_amount = round2(cur * factor)
      }
      this.contribution_frequency = freq
    },
    // 拉取基金真实资产配置，把「现金占净比」写进标的参数（用于真实计算现金拖累）
    async fetchCashRatio(key, code) {
      const p = this.assetParams[key]
      if (!p) return null
      const alloc = await api(`/market/fund/${code}/allocation?refresh=1`)
      p.cash_ratio = Number(alloc.cash_ratio) || 0
      p.cash_ratio_as_of = alloc.as_of || ''
      p.cash_ratio_stock = Number(alloc.stock_ratio) || 0
      return alloc
    },
    buildPayload() {
      // 把每个标的的「每期定投金额」归一化成占比（0~1）作为 weight，
      // 合计 contribution 取各标的金额之和 → 后端 c = Σ金额 × (金额ᵢ/Σ金额) = 金额ᵢ，
      // 即每个标的拿到自己的金额，而不是均分。
      const total = this.totalContribution
      const assets = this.selected.map((k) => {
        const p = this.assetParams[k]
        const amount = Number(p.dca_amount) || 0
        return { ...p, weight: total > 0 ? amount / total : 0 }
      })
      const freq = this.contribution_frequency
      const isDaily = freq === 'trading_day'
      const isYearly = freq === 'yearly'
      return {
        monthly_amount: isDaily || isYearly ? 1 : Math.max(1, total),
        contribution_frequency: freq,
        daily_amount: isDaily ? Math.max(0.01, total) : 0.01,
        yearly_amount: isYearly ? Math.max(0.01, total) : 0.01,
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
      // 按币种选默认参数模板：USD 标的用 QDII 模板（股息率/预扣税/现金拖累均为美股口径），
      // CNY 标的用 A股 ETF 模板；不能用同一套模板，否则股息与税参全被带偏
      // 按「底层市场」而不是「计价币种」选参数模板：
      // 人民币计价的 QDII 美股基金 ≠ A股 ETF —— 股息率、股息预扣税、现金拖累全不同。
      // 此前只按币种判断，把标普500/纳指100 当成了红利低波（4.2% 股息 + 0 税），严重高估收益。
      const MANUAL_TYPES = ['provident_fund', 'treasury_bond', 'reverse_repo', 'cash_flow']
      const pickBase = (item) => {
        const text = `${item.fund_type || ''} ${item.name || ''}`
        if (/纳斯达克|纳指|Nasdaq|NDX/i.test(text)) return TEMPLATES[1].asset // 纳指100：低股息
        if (/标普|S&P|SPX|QDII|海外|美国|美元|全球|国际/i.test(text)) return TEMPLATES[0].asset // 美股离岸（QDII 口径）
        return TEMPLATES[2].asset // A股 ETF 口径（股息免税、无现金拖累）
      }
      const baseFor = (item) => {
        const base = JSON.parse(JSON.stringify(pickBase(item)))
        base.currency = item.currency || 'CNY' // 计价币种保持实际值，避免被当成美元标的做汇率折算
        if (MANUAL_TYPES.includes(item.asset_type)) {
          // 公积金/现金流/国债/逆回购属于现金类存量：无股息、无费率、无现金拖累
          Object.assign(base, {
            dividend_yield: 0, dividend_tax_rate: 0, cash_drag: 0,
            management_fee: 0, subscription_fee: 0, capital_gains_tax_rate: 0,
            redemption_fee_tiers: [], buy_premium: 0, premium_months: 0, sell_premium: 0
          })
        }
        return base
      }
      // 各标的的默认定投额直接取账本推导出的「典型每期买入额」，
      // 这样 天弘100/日、摩根10/日 不会被强行拉平；无历史时才退回均分。
      const suggested = context.assets.map((a) => Number(a.suggested_contribution) || 0)
      const sumSuggested = suggested.reduce((s, v) => s + v, 0)
      const fallbackEach = round2((Number(this.monthly_amount) || 3000) / context.assets.length)
      this.catalog = context.assets.map((item, i) => {
        const base = baseFor(item)
        return {
          key: item.code,
          label: `${item.name}（${item.code}）`,
          asset: {
            ...base,
            name: item.name,
            expected_return: item.expected_return,
            initial_value: item.initial_value,
            initial_cost: item.initial_cost,
            initial_investment: item.initial_investment,
            management_fee: item.management_fee ?? base.management_fee,
            subscription_fee: item.subscription_fee ?? base.subscription_fee,
            redemption_fee_tiers: item.redemption_fee_tiers?.length ? item.redemption_fee_tiers : base.redemption_fee_tiers,
            buy_premium: item.buy_premium_rate || 0,
            premium_months: item.buy_premium_rate > 0 ? 1 : 0,
            weight: 1,
            // 真实现金占净比：后端已按 毛=(净+费率)/(1−现金占比) 反解过毛收益，
            // 这里必须沿用同一个占比，否则管理费与现金拖累会被重复计提。
            cash_ratio: Number(item.cash_ratio) || 0,
            cash_ratio_as_of: item.cash_ratio_as_of || '',
            net_return_history: item.net_return_history ?? null,
            dca_amount: sumSuggested > 0 ? suggested[i] : fallbackEach
          },
          market: item
        }
      })
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
      // 旧版方案把 weight 当“权重”（多为 1）；新版把 weight 当“每期金额”。
      // 用「全部 ≤1.01 且多于一个标的」判定旧方案，按原总额等比还原金额。
      const savedWeights = params.assets.map((a) => Number(a.weight) || 0)
      const legacyWeights = savedWeights.length > 1 && savedWeights.every((w) => w <= 1.01)
      const legacyTotal = Number(params.monthly_amount) || 3000
      const legacySum = savedWeights.reduce((s, w) => s + w, 0) || 1
      for (const t of TEMPLATES) {
        const hit = params.assets.find((a) => a.name === t.asset.name)
        if (hit) {
          const amount = legacyWeights
            ? round2((legacyTotal * (Number(hit.weight) || 0)) / legacySum)
            : Number(hit.weight) || 0
          this.assetParams[t.key] = { ...JSON.parse(JSON.stringify(t.asset)), ...hit, dca_amount: amount }
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
