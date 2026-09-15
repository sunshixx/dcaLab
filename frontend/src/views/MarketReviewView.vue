<script setup>
// 市场复盘：汇总展示 generate-us-market-daily-review 技能产出的每日复盘（美股 / A股）
// 数据来自后端 /api/review（读取技能生成的审计 JSON）
import { ref, computed, onMounted, watch } from 'vue'
import { api } from '../api.js'
import ChartBox from '../components/ChartBox.vue'

const MARKET_CN = { us: '美股', cn: 'A股' }

const market = ref('cn')
const date = ref('')
const list = ref({ us: [], cn: [] })
const summary = ref(null)
const error = ref('')
const notice = ref('')
const loading = ref(false)
const refreshing = ref(false)

onMounted(refreshAndLoad)

async function refreshAndLoad() {
  refreshing.value = true
  error.value = ''
  notice.value = ''
  // 先展示本地已有报告，再在后台检查缓存并按需实时刷新。
  await loadList()
  const results = await Promise.allSettled([
    api('/review/refresh/cn', { method: 'POST', body: {} }),
    api('/review/refresh/us', { method: 'POST', body: {} })
  ])
  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason.message)
  // 闸门拦截（如 A股未收盘）不是错误：请求成功但被拒绝，作为提示展示
  const blocked = results
    .filter((r) => r.status === 'fulfilled' && r.value && r.value.blocked)
    .map((r) => r.value.error)
  await loadList()
  if (blocked.length) {
    notice.value = blocked.join('；')
  }
  if (failures.length) {
    error.value = `部分市场刷新失败：${failures.join('；')}`
  }
  refreshing.value = false
}

async function loadList() {
  error.value = ''
  try {
    list.value = await api('/review/list')
    // 默认选中最新一天（优先 A股，其次美股）
    if (!date.value) {
      const first = list.value.cn[0] || list.value.us[0]
      if (first) {
        market.value = list.value.cn.length ? 'cn' : 'us'
        date.value = first.date
      }
    }
    await loadSummary()
  } catch (e) {
    error.value = e.message
  }
}

async function loadSummary() {
  if (!date.value) return
  loading.value = true
  error.value = ''
  try {
    summary.value = await api(`/review/summary?market=${market.value}&date=${date.value}`)
  } catch (e) {
    summary.value = null
    error.value = e.message
  } finally {
    loading.value = false
  }
}

// 切换市场时：若有该市场数据则选中其最新日期
watch(market, () => {
  const arr = list.value[market.value] || []
  date.value = arr.length ? arr[0].date : ''
  loadSummary()
})
watch(date, () => {
  if (date.value) loadSummary()
})

const reports = computed(() => list.value[market.value] || [])
const hasData = computed(() => summary.value != null)

// ── 数值工具：JSON 里 day_pct 已是「百分比数值」（如 1.23 = +1.23%），直接显示，不再乘 100 ──
function pct(v, digits = 2) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  const n = Number(v)
  return (n > 0 ? '+' : '') + n.toFixed(digits) + '%'
}
function cls(v) {
  const n = Number(v)
  if (v == null || !Number.isFinite(n) || Math.abs(n) < 0.005) return ''
  return n > 0 ? 'pos' : 'neg'
}
function price(v, digits = 2) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
function cnyAmount(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  const n = Number(v)
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(1) + ' 亿'
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(1) + ' 万'
  return n.toLocaleString('zh-CN')
}

// KPI 卡片数据（优先渲染器归一化后的 rendered_benchmark_kpis）
const kpiCards = computed(() => {
  const s = summary.value
  if (!s) return []
  const rows = (s.rendered_benchmark_kpis && s.rendered_benchmark_kpis.length)
    ? s.rendered_benchmark_kpis
    : (s.benchmark_kpis || [])
  return rows.filter((r) => r && (r.day_pct != null || r.kpi_label))
})

const keyStocks = computed(() => (summary.value ? (summary.value.key_stocks || []) : []))
const movers = computed(() => (summary.value ? (summary.value.movers || []) : []))
const marketNews = computed(() => (summary.value ? (summary.value.market_news || []) : []))
const globalNews = computed(() => (summary.value ? (summary.value.global_news || []) : []))
const voices = computed(() => (summary.value ? (summary.value.voices || []) : []))
const nextWatch = computed(() => (summary.value ? (summary.value.next_watch || []) : []))

// 关键个股涨跌幅横条图
const stockBarOption = computed(() => {
  const items = keyStocks.value
    .filter((r) => r && Number.isFinite(Number(r.day_pct)))
    .map((r) => ({ name: r.name || r.ticker || r.key, value: Number(r.day_pct) }))
  if (!items.length) return {}
  return barOption(items)
})

// 异动股涨跌幅横条图
const moverBarOption = computed(() => {
  const items = movers.value
    .filter((r) => r && Number.isFinite(Number(r.day_pct)))
    .map((r) => ({ name: r.name || r.ticker || r.key, value: Number(r.day_pct) }))
  if (!items.length) return {}
  return barOption(items)
})

function barOption(items) {
  const maxNameLen = Math.max(...items.map((i) => i.name.length), 3)
  const leftPad = Math.min(maxNameLen * 8 + 14, 160)
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p) => `${p[0].name}<br/>${pct(p[0].value)}` },
    grid: { left: leftPad, right: 66, top: 10, bottom: 24 },
    xAxis: { type: 'value', axisLabel: { formatter: '{value}%', fontSize: 10 } },
    yAxis: { type: 'category', data: items.map((i) => i.name), axisLabel: { fontSize: 11 }, inverse: true },
    series: [
      {
        type: 'bar',
        barWidth: 14,
        data: items.map((i) => i.value),
        itemStyle: { color: (p) => (p.value >= 0 ? '#9bbb59' : '#c0504d') },
        label: { show: true, position: 'right', formatter: ({ value }) => (value > 0 ? '+' : '') + value.toFixed(2) + '%', fontSize: 10, color: '#333' }
      }
    ]
  }
}

const stockChartHeight = computed(() => {
  const n = keyStocks.value.filter((r) => r && Number.isFinite(Number(r.day_pct))).length
  return Math.max(140, n * 24 + 40)
})
const moverChartHeight = computed(() => {
  const n = movers.value.filter((r) => r && Number.isFinite(Number(r.day_pct))).length
  return Math.max(140, n * 24 + 40)
})

const sources = computed(() => {
  const s = summary.value
  if (!s || !s.sources) return []
  return Object.entries(s.sources).map(([label, url]) => ({ label, url }))
})
</script>

<template>
  <div>
    <!-- 顶部：市场切换 + 日期选择 -->
    <div style="margin-bottom: 10px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap">
      <span style="font-weight: bold">复盘市场：</span>
      <select v-model="market" style="width: 120px">
        <option value="cn">A股</option>
        <option value="us">美股</option>
      </select>
      <span style="font-weight: bold">报告日期：</span>
      <select v-model="date" style="min-width: 180px">
        <option v-for="rp in reports" :key="rp.date" :value="rp.date">
          {{ rp.date }}（{{ rp.report_type }}）
        </option>
      </select>
      <span v-if="reports.length === 0 && !refreshing" class="bz-hint">该市场暂无复盘报告</span>
      <span v-if="refreshing" class="bz-hint">正在刷新行情、新闻并生成报告，请稍候...</span>
      <a v-if="summary && summary.html" :href="'/api/review/html/' + summary.html" target="_blank" rel="noopener"
        class="bz-btn" style="margin-left: auto">打开完整 HTML 报告 ↗</a>
    </div>

    <div v-if="error" class="bz-error">{{ error }}</div>

    <div v-if="notice" class="bz-note">⏳ {{ notice }}</div>

    <div v-if="refreshing" class="bz-note">正在加载最新复盘内容...</div>

    <template v-if="hasData">
      <!-- 报告头 -->
      <h2 class="bz-section">
        {{ summary.title || (MARKET_CN[market] + '每日盘后回顾 — ' + summary.report_date) }}
      </h2>
      <div class="bz-note" style="margin-top: 0">
        报告日期 {{ summary.report_date }} · 类型 {{ summary.report_type }} · 生成时间 {{ summary.generated_at || '—' }}
      </div>

      <!-- 01 一句话总览 -->
      <h2 class="bz-section">① 一句话市场总览</h2>
      <p v-if="summary.overview_lead" style="font-weight: bold">{{ summary.overview_lead }}</p>
      <p v-if="summary.overview" style="white-space: pre-wrap">{{ summary.overview }}</p>

      <!-- 02 核心 KPI -->
      <template v-if="kpiCards.length">
        <h2 class="bz-section">② 核心 KPI</h2>
        <table class="bz bz-summary">
          <tr>
            <th style="width: 150px">指数</th>
            <th class="num">收盘</th>
            <th class="num">当日涨跌</th>
            <th>口径</th>
          </tr>
          <tr v-for="k in kpiCards" :key="k.ticker || k.kpi_label || k.name">
            <td>{{ k.kpi_label || k.name || k.ticker }}</td>
            <td class="num">{{ price(k.close) }}</td>
            <td class="num" :class="cls(k.day_pct)">{{ pct(k.day_pct) }}</td>
            <td class="bz-hint">{{ k.kpi_basis || '前收至收盘' }}</td>
          </tr>
        </table>
      </template>

      <!-- 核心标的 / 个股 -->
      <template v-if="keyStocks.length">
        <h2 class="bz-section">{{ market === 'cn' ? '③ 核心科技龙头 / 关注个股' : '③ 重点科技股' }}</h2>
        <div class="bz-scroll" style="max-height: 320px">
          <table class="bz">
            <tr>
              <th>名称</th>
              <th>代码</th>
              <th class="num">开盘</th>
              <th class="num">最高</th>
              <th class="num">最低</th>
              <th class="num">收盘</th>
              <th class="num">当日涨跌</th>
              <th class="num">成交额</th>
            </tr>
            <tr v-for="s in keyStocks" :key="s.ticker || s.key">
              <td>{{ s.name }}</td>
              <td class="bz-hint">{{ s.ticker || s.key }}</td>
              <td class="num">{{ price(s.open) }}</td>
              <td class="num">{{ price(s.high) }}</td>
              <td class="num">{{ price(s.low) }}</td>
              <td class="num">{{ price(s.close) }}</td>
              <td class="num" :class="cls(s.day_pct)">{{ pct(s.day_pct) }}</td>
              <td class="num">{{ cnyAmount(s.amount) }}</td>
            </tr>
          </table>
        </div>
        <ChartBox v-if="stockBarOption.series" title="核心标的当日涨跌幅" :option="stockBarOption" :height="stockChartHeight + 'px'" />
      </template>

      <!-- 异动股 -->
      <template v-if="movers.length">
        <h2 class="bz-section">④ 当日大幅波动股票（{{ movers.length }} 只）</h2>
        <div class="bz-scroll" style="max-height: 360px">
          <table class="bz">
            <tr>
              <th>名称</th>
              <th>代码</th>
              <th class="num">收盘</th>
              <th class="num">当日涨跌</th>
              <th>类型</th>
              <th>驱动与点评</th>
            </tr>
            <tr v-for="m in movers" :key="m.ticker || m.key">
              <td>{{ m.name }}</td>
              <td class="bz-hint">{{ m.ticker || m.key }}</td>
              <td class="num">{{ price(m.close) }}</td>
              <td class="num" :class="cls(m.day_pct)">{{ pct(m.day_pct) }}</td>
              <td><span class="bz-badge" style="margin-left: 0">{{ m.category || '—' }}</span></td>
              <td class="wrap">{{ m.driver || '—' }}</td>
            </tr>
          </table>
        </div>
        <ChartBox v-if="moverBarOption.series" title="异动股当日涨跌幅" :option="moverBarOption" :height="moverChartHeight + 'px'" />
      </template>

      <!-- 关键新闻 -->
      <template v-if="marketNews.length">
        <h2 class="bz-section">⑤ 影响{{ MARKET_CN[market] }}的关键新闻</h2>
        <div v-for="(n, i) in marketNews" :key="i" style="border: 1px solid #bbb; padding: 6px 10px; margin-bottom: 6px">
          <strong>{{ n.title }}</strong>
          <div class="bz-hint">{{ n.source_time || '' }}</div>
          <p v-if="n.fact" style="margin: 4px 0 2px">{{ n.fact }}</p>
          <p v-if="n.inference" style="margin: 0 0 4px" class="bz-hint">{{ n.inference }}</p>
          <a v-if="n.url" :href="n.url" target="_blank" rel="noopener">原文来源 ↗</a>
        </div>
      </template>

      <!-- 国际新闻 -->
      <template v-if="globalNews.length">
        <h2 class="bz-section">⑥ 过去 24 小时国际新闻（{{ globalNews.length }} 条）</h2>
        <div class="bz-scroll" style="max-height: 460px">
          <div v-for="(g, i) in globalNews" :key="i" style="border: 1px solid #bbb; padding: 6px 10px; margin-bottom: 6px">
            <strong>{{ i + 1 }}. {{ g.title }}</strong>
            <div class="bz-hint">{{ g.region }} · {{ g.source_time }}<span v-if="g.impact_type"> · {{ g.impact_type }}</span></div>
            <p v-if="g.summary" style="margin: 4px 0 2px">{{ g.summary }}</p>
            <p v-if="g.importance" style="margin: 0 0 2px"><strong>为什么重要：</strong>{{ g.importance }}</p>
            <p v-if="g.impact" style="margin: 0 0 4px" class="bz-hint"><strong>可能影响：</strong>{{ g.impact }}</p>
            <a v-if="g.url" :href="g.url" target="_blank" rel="noopener">原文来源 ↗</a>
          </div>
        </div>
      </template>

      <!-- 重要人物 -->
      <template v-if="voices.length">
        <h2 class="bz-section">⑦ 重要人物发言与言论</h2>
        <div v-for="(v, i) in voices" :key="i" style="border: 1px solid #bbb; padding: 6px 10px; margin-bottom: 6px">
          <strong>{{ v.person }}</strong><span v-if="v.title" class="bz-hint">｜{{ v.title }}</span>
          <div class="bz-hint">{{ v.time_platform || '' }}<span v-if="v.platform"> · {{ v.platform }}</span></div>
          <blockquote v-if="v.quote" style="margin: 4px 0 4px 10px; border-left: 3px solid #999; padding-left: 8px">{{ v.quote }}</blockquote>
          <p v-if="v.context" style="margin: 0 0 4px">{{ v.context }}</p>
          <a v-if="v.url" :href="v.url" target="_blank" rel="noopener">原文来源 ↗</a>
        </div>
      </template>

      <!-- 下一交易日关注 -->
      <template v-if="nextWatch.length">
        <h2 class="bz-section">⑧ 下一交易日关注</h2>
        <table class="bz">
          <tr><th>时间</th><th>事项</th><th>说明</th><th>来源</th></tr>
          <tr v-for="(w, i) in nextWatch" :key="i">
            <td>{{ w.time || '—' }}</td>
            <td>{{ w.title }}</td>
            <td class="wrap">{{ w.detail || '—' }}</td>
            <td><a v-if="w.url" :href="w.url" target="_blank" rel="noopener">{{ w.source_label || '来源' }}</a><span v-else>{{ w.source_label || '—' }}</span></td>
          </tr>
        </table>
      </template>

      <!-- 数据说明 / 缺口 / 来源 -->
      <h2 class="bz-section">数据说明与来源</h2>
      <div class="bz-note">
        <div v-if="summary.data_notes && summary.data_notes.length">
          <strong>数据说明：</strong>
          <ul style="margin: 4px 0 6px 18px">
            <li v-for="(n, i) in summary.data_notes" :key="i">{{ n }}</li>
          </ul>
        </div>
        <div v-if="summary.data_gaps && summary.data_gaps.length" style="margin-top: 4px">
          <strong>数据缺口 / 待复核：</strong>
          <ul style="margin: 4px 0 6px 18px; color: #900">
            <li v-for="(g, i) in summary.data_gaps" :key="i">{{ g }}</li>
          </ul>
        </div>
        <div v-if="sources.length">
          <strong>来源：</strong>
          <template v-for="(s, i) in sources" :key="i">
            <a :href="s.url" target="_blank" rel="noopener">{{ s.label }}</a><span v-if="i < sources.length - 1"> · </span>
          </template>
        </div>
      </div>
    </template>

    <div v-else-if="!refreshing && loading" class="bz-note">加载中…</div>
    <div v-else-if="!refreshing && !loading && !error" class="bz-note">
      暂无复盘数据。请先用 generate-us-market-daily-review 技能生成报告，其产出会落入 <code>reports/</code> 目录并被本页自动读取。
    </div>
  </div>
</template>
