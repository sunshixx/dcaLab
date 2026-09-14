<script setup>
// 模拟器：左参数面板 / 右结果区（汇总表 + 图表 + 费用分解 + 逐年数据）
import { onMounted, computed } from 'vue'
import { useCalcStore } from '../stores/calcStore.js'
import { fmtMoney, fmtWan, fmtPct, toPctInput, fromPctInput } from '../fmt.js'
import ChartBox from '../components/ChartBox.vue'

const store = useCalcStore()
onMounted(() => {
  store.fetchPlans().catch(() => {})
  store.fetchSimulationContext()
    .catch(() => {})
    .finally(() => store.calculate())
})

const r = computed(() => store.result)

const summary = computed(() => {
  if (!r.value) return []
  const res = r.value
  const net = res.final_value - res.total_investment
  return [
    ['总投入', fmtMoney(res.total_investment) + ' 元'],
    ['期末终值（名义）', fmtWan(res.final_value) + ' 元'],
    ['实际购买力（扣通胀）', fmtWan(res.final_value_real) + ' 元'],
    ['净收益（名义）', fmtWan(net) + ' 元'],
    ['总费用（名义口径）', fmtMoney(res.total_cost) + ' 元'],
    ['总费用（终值口径·真实成本）', fmtMoney(res.total_cost_terminal) + ' 元'],
    ['费用 / 投入', fmtPct(res.total_cost / res.total_investment)],
    ['真实成本 / 终值', fmtPct(res.total_cost_terminal / res.final_value)]
  ]
})

const COST_LABELS = {
  subscription_fees: '申购费/佣金',
  management_fees: '管理费+托管费',
  dividend_taxes: '股息预扣税',
  premium_loss: '买入溢价损耗',
  cash_drag_loss: '现金拖累',
  redemption_fees: '赎回费',
  capital_gains_tax: '资本利得税'
}
const costRows = computed(() => {
  if (!r.value) return []
  const res = r.value
  return Object.keys(COST_LABELS).map((k) => ({
    label: COST_LABELS[k],
    nominal: res.cost_breakdown[k],
    terminal: res.cost_breakdown_terminal[k],
    pctOfInvest: res.cost_breakdown[k] / res.total_investment
  }))
})

const growthOption = computed(() => {
  if (!r.value) return {}
  const y = r.value.yearly_data
  return {
    xAxis: { type: 'category', data: [0, ...y.map((d) => d.year)] },
    yAxis: { type: 'value', axisLabel: { formatter: (v) => (v / 10000).toFixed(0) + '万' } },
    series: [
      {
        name: '累计投入',
        type: 'line',
        step: 'end',
        data: [0, ...y.map((d) => d.cumulative_investment)],
        lineStyle: { width: 2 },
        symbol: 'none'
      },
      {
        name: '组合市值',
        type: 'line',
        data: [0, ...y.map((d) => d.portfolio_value)],
        lineStyle: { width: 2 },
        symbol: 'none',
        areaStyle: { opacity: 0.08 }
      }
    ]
  }
})

const costOption = computed(() => {
  if (!r.value) return {}
  const y = r.value.yearly_data
  return {
    xAxis: { type: 'category', data: y.map((d) => d.year) },
    yAxis: { type: 'value', axisLabel: { formatter: (v) => (v / 10000).toFixed(0) + '万' } },
    series: [
      {
        name: '费用累计（名义）',
        type: 'line',
        data: y.map((d) => d.cost_lost),
        symbol: 'none',
        lineStyle: { width: 2 }
      },
      {
        name: '费用累计（终值口径）',
        type: 'line',
        data: y.map((d) => d.cost_lost_terminal),
        symbol: 'none',
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.12 }
      }
    ]
  }
})

const scenarioOption = computed(() => {
  if (!r.value) return {}
  const s = r.value.scenarios
  return {
    xAxis: { type: 'category', data: s.map((x) => x.label) },
    yAxis: { type: 'value', axisLabel: { formatter: (v) => (v / 10000).toFixed(0) + '万' } },
    series: [
      {
        name: '名义终值',
        type: 'bar',
        barWidth: 34,
        data: s.map((x) => x.final_value),
        itemStyle: { color: '#4a7ebb', borderColor: '#2f5c84', borderWidth: 1 }
      },
      {
        name: '实际购买力',
        type: 'bar',
        barWidth: 34,
        data: s.map((x) => x.final_value_real),
        itemStyle: { color: '#9bbb59', borderColor: '#718a3e', borderWidth: 1 }
      }
    ]
  }
})

function savePlan() {
  const name = window.prompt('方案名称：', `方案 ${new Date().toLocaleDateString('zh-CN')}`)
  if (name && name.trim()) store.savePlan(name.trim()).catch((e) => alert(e.message))
}
</script>

<template>
  <div class="bz-layout">
    <!-- ── 左：参数面板 ── -->
    <div class="bz-params">
      <fieldset>
        <legend>全局参数</legend>
        <div class="bz-form-row">
          <label>定投频率</label>
          <select v-model="store.contribution_frequency">
            <option value="monthly">每月一次</option>
            <option value="trading_day">每个交易日</option>
          </select>
        </div>
        <div v-if="store.contribution_frequency === 'monthly'" class="bz-form-row">
          <label>月定投金额（元）</label>
          <input type="number" v-model.number="store.monthly_amount" min="1" />
        </div>
        <div v-else class="bz-form-row">
          <label>每日定投金额（元）</label>
          <input type="number" v-model.number="store.daily_amount" min="0.01" step="0.01" />
          <span class="bz-hint">按周一至周五约 252 个交易日/年</span>
        </div>
        <div class="bz-form-row">
          <label>定投总年数</label>
          <input type="number" v-model.number="store.years" min="1" max="50" />
        </div>
        <div class="bz-form-row">
          <label>汇率（CNY/USD）</label>
          <input type="number" v-model.number="store.global.exchange_rate" step="0.01" />
        </div>
        <div class="bz-form-row">
          <label>汇率年化漂移 %</label>
          <input type="text" :value="toPctInput(store.global.fx_drift)"
            @change="store.global.fx_drift = fromPctInput($event.target.value)" />
          <span class="bz-hint">正=人民币贬值</span>
        </div>
        <div class="bz-form-row">
          <label>年化通胀率 %</label>
          <input type="text" :value="toPctInput(store.global.inflation)"
            @change="store.global.inflation = fromPctInput($event.target.value)" />
        </div>
      </fieldset>

      <fieldset>
        <legend>标的指数（勾选参与定投）</legend>
        <div v-for="t in store.catalog" :key="t.key" class="bz-asset"
          :class="{ disabled: !store.selected.includes(t.key) }">
          <div class="asset-head">
            <label>
              <input type="checkbox" :value="t.key" v-model="store.selected" />
              {{ t.label }}
              <span v-if="t.asset.currency === 'USD'" class="bz-badge">USD</span>
              <span v-if="t.market" class="bz-hint">
                当前市值 {{ fmtMoney(t.market.initial_value) }} 元 · 历史年化估计 {{ fmtPct(t.market.expected_return) }}
              </span>
            </label>
          </div>
          <details v-if="store.selected.includes(t.key)" class="adv" open>
            <summary>高级参数</summary>
            <div class="bz-form-row">
              <label>年化预期收益率 %</label>
              <input type="text" :value="toPctInput(store.assetParams[t.key].expected_return)"
                @change="store.assetParams[t.key].expected_return = fromPctInput($event.target.value)" />
            </div>
            <div class="bz-form-row">
              <label>管理费+托管费 %</label>
              <input type="text" :value="toPctInput(store.assetParams[t.key].management_fee)"
                @change="store.assetParams[t.key].management_fee = fromPctInput($event.target.value)" />
            </div>
            <div class="bz-form-row">
              <label>现金拖累 %（场外联接）</label>
              <input type="text" :value="toPctInput(store.assetParams[t.key].cash_drag)"
                @change="store.assetParams[t.key].cash_drag = fromPctInput($event.target.value)" />
            </div>
            <div class="bz-form-row">
              <label>股息率 %</label>
              <input type="text" :value="toPctInput(store.assetParams[t.key].dividend_yield)"
                @change="store.assetParams[t.key].dividend_yield = fromPctInput($event.target.value)" />
            </div>
            <div class="bz-form-row">
              <label>股息预扣税率 %</label>
              <input type="text" :value="toPctInput(store.assetParams[t.key].dividend_tax_rate)"
                @change="store.assetParams[t.key].dividend_tax_rate = fromPctInput($event.target.value)" />
            </div>
            <div class="bz-form-row">
              <label>资本利得税率 %</label>
              <input type="text" :value="toPctInput(store.assetParams[t.key].capital_gains_tax_rate)"
                @change="store.assetParams[t.key].capital_gains_tax_rate = fromPctInput($event.target.value)" />
              <span class="bz-hint">境外券商直投填 20</span>
            </div>
            <div class="bz-form-row">
              <label>买入溢价率 %</label>
              <input type="text" :value="toPctInput(store.assetParams[t.key].buy_premium)"
                @change="store.assetParams[t.key].buy_premium = fromPctInput($event.target.value)" />
            </div>
            <div class="bz-form-row">
              <label>溢价持续月数</label>
              <input type="number" v-model.number="store.assetParams[t.key].premium_months" min="0" />
              <span class="bz-hint">0=仅首月</span>
            </div>
            <div class="bz-form-row">
              <label>卖出时溢价率 %</label>
              <input type="text" :value="toPctInput(store.assetParams[t.key].sell_premium)"
                @change="store.assetParams[t.key].sell_premium = fromPctInput($event.target.value)" />
            </div>
            <div class="bz-form-row">
              <label>申购费/佣金 %</label>
              <input type="text" :value="toPctInput(store.assetParams[t.key].subscription_fee)"
                @change="store.assetParams[t.key].subscription_fee = fromPctInput($event.target.value)" />
            </div>
            <div class="bz-form-row">
              <label>资金权重</label>
              <input type="number" v-model.number="store.assetParams[t.key].weight" min="0.01" step="0.5" />
            </div>
            <details class="adv">
              <summary>赎回费阶梯（场外）</summary>
              <div class="bz-form-row">
                <label>持有&lt;7天 %</label>
                <input type="text" width="60"
                  :value="toPctInput(store.assetParams[t.key].redemption_fee_tiers[0]?.rate ?? 0)"
                  @change="store.assetParams[t.key].redemption_fee_tiers[0] && (store.assetParams[t.key].redemption_fee_tiers[0].rate = fromPctInput($event.target.value))" />
              </div>
              <div class="bz-form-row">
                <label>7天~1年 %</label>
                <input type="text"
                  :value="toPctInput(store.assetParams[t.key].redemption_fee_tiers[1]?.rate ?? 0)"
                  @change="store.assetParams[t.key].redemption_fee_tiers[1] && (store.assetParams[t.key].redemption_fee_tiers[1].rate = fromPctInput($event.target.value))" />
              </div>
              <div class="bz-form-row">
                <label>1~2年 %</label>
                <input type="text"
                  :value="toPctInput(store.assetParams[t.key].redemption_fee_tiers[2]?.rate ?? 0)"
                  @change="store.assetParams[t.key].redemption_fee_tiers[2] && (store.assetParams[t.key].redemption_fee_tiers[2].rate = fromPctInput($event.target.value))" />
              </div>
              <div class="bz-form-row">
                <label>≥2年 %</label>
                <input type="text"
                  :value="toPctInput(store.assetParams[t.key].redemption_fee_tiers[3]?.rate ?? 0)"
                  @change="store.assetParams[t.key].redemption_fee_tiers[3] && (store.assetParams[t.key].redemption_fee_tiers[3].rate = fromPctInput($event.target.value))" />
              </div>
            </details>
          </details>
        </div>
      </fieldset>

      <fieldset>
        <legend>动态切换（高溢价自动绕行）</legend>
        <div class="bz-form-row">
          <label>
            <input type="checkbox" v-model="store.global.enable_dynamic_switch" />
            开启动态切换
          </label>
        </div>
        <template v-if="store.global.enable_dynamic_switch">
          <div class="bz-form-row">
            <label>溢价阈值 %</label>
            <input type="text" :value="toPctInput(store.global.premium_threshold)"
              @change="store.global.premium_threshold = fromPctInput($event.target.value)" />
            <span class="bz-hint">超过则该月资金转入溢出桶</span>
          </div>
          <div class="bz-form-row">
            <label>溢出桶收益率 %</label>
            <input type="text" :value="toPctInput(store.global.overflow_asset.expected_return)"
              @change="store.global.overflow_asset.expected_return = fromPctInput($event.target.value)" />
          </div>
          <div class="bz-form-row">
            <label>溢出桶股息率 %</label>
            <input type="text" :value="toPctInput(store.global.overflow_asset.dividend_yield)"
              @change="store.global.overflow_asset.dividend_yield = fromPctInput($event.target.value)" />
          </div>
        </template>
      </fieldset>

      <p>
        <button class="primary" :disabled="store.loading" @click="store.calculate()">
          {{ store.loading ? '计算中…' : '开始计算' }}
        </button>
        <button @click="savePlan">保存方案</button>
      </p>

      <fieldset v-if="store.plans.length">
        <legend>已存方案</legend>
        <div v-for="p in store.plans" :key="p.id" class="bz-form-row">
          <a href="javascript:void(0)" @click="store.loadPlan(p.id)">{{ p.name }}</a>
          <span class="bz-hint">{{ p.created_at }}</span>
          <button class="danger" style="float: right; padding: 0 6px"
            @click="store.deletePlan(p.id).catch((e) => alert(e.message))">删</button>
        </div>
      </fieldset>
    </div>

    <!-- ── 右：结果区 ── -->
    <div class="bz-results">
      <div v-if="store.error" class="bz-error">{{ store.error }}</div>

      <template v-if="r">
        <h2 class="bz-section">结果汇总</h2>
        <table class="bz bz-summary">
          <tr v-for="(row, i) in summary" :key="i">
            <th style="width: 240px">{{ row[0] }}</th>
            <td class="num" :class="{ big: i <= 2 }">{{ row[1] }}</td>
          </tr>
        </table>

        <ChartBox title="资产增长曲线（累计投入 vs 组合市值）" :option="growthOption" />
        <ChartBox title="费用累计 —— 名义口径 vs 终值口径（含复利机会成本）" :option="costOption" />
        <ChartBox title="三情景对比（收益率 ±2pp 敏感性）" :option="scenarioOption" />

        <h2 class="bz-section">费用分解</h2>
        <table class="bz">
          <tr>
            <th>费用项</th>
            <th class="num">名义金额（元）</th>
            <th class="num">终值口径（元）</th>
            <th class="num">占投入比</th>
          </tr>
          <tr v-for="c in costRows" :key="c.label">
            <td>{{ c.label }}</td>
            <td class="num">{{ fmtMoney(c.nominal) }}</td>
            <td class="num">{{ fmtMoney(c.terminal) }}</td>
            <td class="num">{{ fmtPct(c.pctOfInvest) }}</td>
          </tr>
          <tr>
            <th>合计</th>
            <th class="num">{{ fmtMoney(r.total_cost) }}</th>
            <th class="num">{{ fmtMoney(r.total_cost_terminal) }}</th>
            <th class="num">{{ fmtPct(r.total_cost / r.total_investment) }}</th>
          </tr>
        </table>

        <h2 class="bz-section">分标的明细</h2>
        <table class="bz">
          <tr>
            <th>标的</th>
            <th class="num">投入</th>
            <th class="num">期末终值</th>
            <th class="num">名义费用</th>
            <th class="num">终值口径费用</th>
            <th class="num">被分流月数</th>
          </tr>
          <tr v-for="a in r.asset_details" :key="a.name">
            <td>{{ a.name }}<span v-if="a.currency === 'USD'" class="bz-badge">USD</span></td>
            <td class="num">{{ fmtMoney(a.invested) }}</td>
            <td class="num">{{ fmtMoney(a.final_value) }}</td>
            <td class="num">{{ fmtMoney(a.total_cost) }}</td>
            <td class="num">{{ fmtMoney(a.total_cost_terminal) }}</td>
            <td class="num">{{ a.switched_months || 0 }}</td>
          </tr>
        </table>

        <h2 class="bz-section">逐年数据</h2>
        <div class="bz-scroll">
          <table class="bz">
            <tr>
              <th>年份</th>
              <th class="num">累计投入</th>
              <th class="num">组合市值</th>
              <th class="num">费用累计（名义）</th>
              <th class="num">费用累计（终值口径）</th>
            </tr>
            <tr v-for="d in r.yearly_data" :key="d.year">
              <td>第 {{ d.year }} 年</td>
              <td class="num">{{ fmtMoney(d.cumulative_investment) }}</td>
              <td class="num" :class="d.portfolio_value >= d.cumulative_investment ? 'pos' : 'neg'">
                {{ fmtMoney(d.portfolio_value) }}
              </td>
              <td class="num">{{ fmtMoney(d.cost_lost) }}</td>
              <td class="num">{{ fmtMoney(d.cost_lost_terminal) }}</td>
            </tr>
          </table>
        </div>
      </template>

      <div v-else-if="!store.loading" class="bz-note">
        在左侧输入参数后点击「开始计算」。
      </div>
    </div>
  </div>
</template>
