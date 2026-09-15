<script setup>
// 持仓概览：单位净值估值、市值与盈亏、配置饼图、投入 vs 市值曲线、组合 XIRR
import { onMounted, computed } from 'vue'
import { useLedgerStore } from '../stores/ledgerStore.js'
import { fmtMoney, fmtWan, fmtPct, ASSET_TYPE_CN } from '../fmt.js'
import ChartBox from '../components/ChartBox.vue'
import { RETRO_COLORS } from '../chartTheme.js'

const store = useLedgerStore()
onMounted(() => {
  store.loadHoldings({ fresh: true }).catch((e) => (store.error = e.message))
  store.loadStats({ fresh: true }).catch(() => {})
  store.loadSeries().catch(() => {})
})

const allocOption = computed(() => {
  if (!store.holdings.length) return {}
  const data = store.holdings.filter((h) => h.market_value > 0).map((h) => ({ name: h.fund_name, value: h.market_value }))
  if (!data.length) return {}
  return {
    tooltip: { trigger: 'item', formatter: '{b}<br/>{c} 元（{d}%）' },
    legend: { bottom: 0, textStyle: { fontSize: 11 } },
    series: [
      {
        type: 'pie',
        radius: '58%',
        center: ['50%', '45%'],
        data,
        label: { formatter: '{d}%', fontSize: 11 },
        color: RETRO_COLORS,
        itemStyle: { borderColor: '#fff', borderWidth: 1 }
      }
    ]
  }
})

const seriesOption = computed(() => {
  const s = store.series
  if (!s || !s.dates.length) return {}
  return {
    xAxis: { type: 'category', data: s.dates },
    yAxis: { type: 'value', axisLabel: { formatter: (v) => (v / 10000).toFixed(1) + '万' } },
    series: [
      { name: '累计投入', type: 'line', data: s.invested, symbol: 'none', lineStyle: { width: 2 } },
      { name: '组合市值', type: 'line', data: s.value, symbol: 'none', lineStyle: { width: 2 }, areaStyle: { opacity: 0.08 } }
    ]
  }
})

const st = computed(() => store.stats)
const assetTypeName = (type) => ASSET_TYPE_CN[type] || '基金'
</script>

<template>
  <div>
    <div v-if="store.error" class="bz-error">{{ store.error }}</div>

    <template v-if="st">
      <h2 class="bz-section">组合总览</h2>
      <table class="bz bz-summary">
        <tr>
          <th>定投基金累计净投入</th>
          <td class="num big">{{ fmtMoney(st.total_invested) }} 元</td>
          <th>全部持仓当前市值</th>
          <td class="num big">{{ fmtMoney(st.total_market_value) }} 元</td>
        </tr>
        <tr>
          <th>定投基金未实现盈亏</th>
          <td class="num" :class="st.unrealized_pl >= 0 ? 'pos' : 'neg'">
            {{ fmtMoney(st.unrealized_pl) }}（{{ fmtPct(st.remaining_cash_cost > 0 ? st.unrealized_pl / st.remaining_cash_cost : null) }}）
          </td>
          <th>定投基金已实现盈亏</th>
          <td class="num" :class="st.realized_pl >= 0 ? 'pos' : 'neg'">{{ fmtMoney(st.realized_pl) }}</td>
        </tr>
        <tr>
          <th>定投基金累计现金分红</th>
          <td class="num">{{ fmtMoney(st.dividend_cash_total) }}</td>
          <th>定投基金累计分红再投</th>
          <td class="num">{{ fmtMoney(st.dividend_reinvest_total) }}</td>
        </tr>
        <tr>
          <th>定投基金总盈亏</th>
          <td class="num" :class="st.total_pl >= 0 ? 'pos' : 'neg'">{{ fmtMoney(st.total_pl) }}</td>
          <th>定投基金 XIRR（金额加权年化）</th>
          <td class="num big" :class="(st.xirr || 0) >= 0 ? 'pos' : 'neg'">
            {{ st.xirr == null ? '—（现金流不足或方向单一）' : fmtPct(st.xirr) }}
          </td>
        </tr>
        <tr>
          <th>定投基金收益率（按累计实际投入，含手续费）</th>
          <td class="num">{{ fmtPct(st.simple_return) }}</td>
          <th></th>
          <td></td>
        </tr>
      </table>

      <div class="portfolio-charts">
        <div class="portfolio-growth-chart">
          <ChartBox v-if="seriesOption.xAxis" title="投入 vs 市值走势（按历史净值回溯，月度）" :option="seriesOption" />
        </div>
        <div class="portfolio-allocation-chart">
          <ChartBox v-if="allocOption.series" title="资产配置（按市值）" :option="allocOption" />
        </div>
      </div>

      <div class="portfolio-table-panel">
        <h2 class="bz-section">分资产持仓</h2>
        <table class="bz">
            <tr>
              <th>标的</th>
              <th class="num">持有份额</th>
              <th class="num">净值持仓成本</th>
              <th class="num">最新估值净值</th>
              <th class="num">市值</th>
              <th class="num">浮动盈亏</th>
              <th class="num">收益率</th>
              <th>买入时溢价率</th>
              <th>估值来源 / 日期</th>
            </tr>
            <tr v-for="h in store.holdings" :key="h.fund_code">
              <td>{{ h.fund_name }}<span class="bz-hint"> {{ h.fund_code }} · {{ assetTypeName(h.asset_type) }}</span></td>
              <td class="num">{{ h.shares.toFixed(2) }}</td>
              <td class="num" :title="h.avg_cost_with_fee ? `含手续费现金成本：${h.avg_cost_with_fee.toFixed(4)}` : ''">
                {{ h.avg_cost ? h.avg_cost.toFixed(4) : '—' }}
              </td>
              <td class="num">{{ h.latest_nav != null ? h.latest_nav : '—' }}</td>
              <td class="num">{{ fmtMoney(h.market_value) }}</td>
              <td class="num" :class="h.unrealized_pl >= 0 ? 'pos' : 'neg'">{{ fmtMoney(h.unrealized_pl) }}</td>
              <td class="num" :class="h.unrealized_pl >= 0 ? 'pos' : 'neg'">{{ fmtPct(h.unrealized_pl_pct) }}</td>
              <td>{{ h.nav_premium_rate == null ? '—' : fmtPct(h.nav_premium_rate) }}</td>
              <td>
                <span class="bz-badge">{{ h.valuation_source || '—' }}</span>
                <span v-if="h.nav_date" class="bz-hint">{{ h.nav_date }}</span>
              </td>
            </tr>
            <tr v-if="!store.holdings.length">
              <td colspan="10" style="text-align: center; color: #777">暂无持仓 —— 去记账本录入交易</td>
            </tr>
        </table>
      </div>
    </template>
    <div v-else class="bz-note">加载中…（或尚无交易记录）</div>
  </div>
</template>
