<script setup>
// 目标配置：计划比例 + 计划总金额 → 记账本真实投入 / 实时市值
// 完成度管「买够没有」，资金占比与配置偏离管「结构偏不偏」，后者用于后续再平衡。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api } from '../api.js'
import { fmtMoney, fmtPct, ASSET_TYPE_CN } from '../fmt.js'
import ChartBox from '../components/ChartBox.vue'
import ProgressBar from '../components/ProgressBar.vue'
import RebalanceModal from '../components/RebalanceModal.vue'

const AUTO_TYPE_OPTIONS = [
  { value: 'provident_fund', label: ASSET_TYPE_CN.provident_fund },
  { value: 'treasury_bond', label: ASSET_TYPE_CN.treasury_bond },
  { value: 'reverse_repo', label: ASSET_TYPE_CN.reverse_repo },
  { value: 'cash_flow', label: ASSET_TYPE_CN.cash_flow }
]
const AUTO_REFRESH_MS = 60_000

const plan = ref(null)
const overview = ref(null)
const ledgerFunds = ref([])
const loading = ref(true)
const refreshing = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const editing = ref(false)
const draft = ref(null)
const mappingIndex = ref(-1)
const showRebalance = ref(false)
const fundSearch = ref('')
const expanded = ref([])
const lastUpdated = ref('')

let timer = null
let lastFetchAt = 0

const totals = computed(() => overview.value?.totals || null)

const ratioSum = computed(() =>
  draft.value ? draft.value.items.reduce((sum, item) => sum + (Number(item.ratio_pct) || 0), 0) : 0
)
const ratioBalanced = computed(() => Math.abs(ratioSum.value - 100) < 0.005)
const canSave = computed(() => {
  if (!draft.value || !ratioBalanced.value || draft.value.items.length === 0) return false
  if (!(Number(draft.value.total_amount) > 0)) return false
  return draft.value.items.every((item) => String(item.name || '').trim().length > 0)
})

// 展示行：分组小计插在首个子项之前（同组只插一次）；类别行下面可按需展开成分标的明细
const viewRows = computed(() => {
  if (!overview.value) return []
  const rows = []
  const renderedGroups = new Set()
  for (const item of overview.value.items) {
    if (item.group_name && !renderedGroups.has(item.group_name)) {
      const group = overview.value.groups.find((entry) => entry.name === item.group_name)
      if (group) {
        rows.push({ type: 'group', key: `g-${item.group_name}`, name: item.group_name, group })
        renderedGroups.add(item.group_name)
      }
    }
    rows.push({ type: 'item', key: `i-${item.name}`, item })
    if (expanded.value.includes(item.name)) {
      for (const member of item.members) {
        rows.push({ type: 'member', key: `m-${item.name}-${member.code}`, member })
      }
    }
  }
  return rows
})

const chartOption = computed(() => {
  if (!overview.value || overview.value.items.length === 0) return {}
  const items = overview.value.items
  return {
    tooltip: { valueFormatter: (value) => fmtMoney(value) + ' 元' },
    legend: { data: ['目标金额', '实际投入', '当前市值'], top: 2 },
    grid: { left: 70, right: 22, top: 34, bottom: 46 },
    xAxis: { type: 'category', data: items.map((item) => item.name), axisLabel: { interval: 0, fontSize: 11 } },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: (value) => (Math.abs(value) >= 10000 ? (value / 10000).toFixed(0) + '万' : value) }
    },
    series: [
      { name: '目标金额', type: 'bar', barGap: '12%', data: items.map((item) => item.target_amount), itemStyle: { color: '#4a7ebb' } },
      { name: '实际投入', type: 'bar', data: items.map((item) => item.actual_invested), itemStyle: { color: '#9bbb59' } },
      { name: '当前市值', type: 'bar', data: items.map((item) => item.market_value), itemStyle: { color: '#c0504d' } }
    ]
  }
})

const mappingItem = computed(() => {
  if (mappingIndex.value < 0 || !draft.value) return null
  return draft.value.items[mappingIndex.value] || null
})

const filteredFunds = computed(() => {
  const keyword = fundSearch.value.trim().toLowerCase()
  const list = [...ledgerFunds.value].sort((a, b) => a.code.localeCompare(b.code))
  if (!keyword) return list
  return list.filter(
    (fund) => fund.code.toLowerCase().includes(keyword) || String(fund.name || '').toLowerCase().includes(keyword)
  )
})

function assetTypeLabel(fund) {
  if (!fund) return '—'
  if (fund.asset_type === 'fund') return fund.type || '基金'
  return ASSET_TYPE_CN[fund.asset_type] || fund.asset_type
}

function autoTypeLabel(value) {
  return AUTO_TYPE_OPTIONS.find((option) => option.value === value)?.label || value
}

function autoTypeSummary(item) {
  if (!item.asset_types.length) return '—'
  return item.asset_types.map(autoTypeLabel).join('、')
}

function fundName(code) {
  return ledgerFunds.value.find((fund) => fund.code === code)?.name || code
}

function memberSummary(item) {
  if (!item.fund_codes.length) {
    return item.asset_types.length ? `按类型自动归入：${autoTypeSummary(item)}` : '未指定标的'
  }
  const names = item.fund_codes.map(fundName)
  return names.length > 3 ? `${names.slice(0, 3).join('、')} 等 ${names.length} 只` : names.join('、')
}

function pp(value) {
  if (value == null) return '—'
  const pct = value * 100
  if (Math.abs(pct) < 0.05) return '0.0pp'
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}pp`
}

function gapText(gap) {
  if (gap == null) return '—'
  if (gap > 0.005) return `还需 ${fmtMoney(gap)}`
  if (gap < -0.005) return `超配 ${fmtMoney(-gap)}`
  return '已达标'
}

function gapClass(gap) {
  if (gap == null) return ''
  if (gap > 0.005) return 'allocation-need'
  if (gap < -0.005) return 'allocation-over'
  return 'allocation-ok'
}

function deviationClass(value) {
  if (value == null) return ''
  if (value * 100 > 0.5) return 'allocation-over'
  if (value * 100 < -0.5) return 'allocation-under'
  return ''
}

function rebalanceText(value) {
  if (value == null) return '—'
  if (value > 0.5) return `减 ${fmtMoney(value)}`
  if (value < -0.5) return `补 ${fmtMoney(-value)}`
  return '平衡'
}

function rebalanceClass(value) {
  if (value == null) return ''
  if (value > 0.5) return 'allocation-over'
  if (value < -0.5) return 'allocation-under'
  return 'allocation-ok'
}

function isExpanded(name) {
  return expanded.value.includes(name)
}

function toggleExpand(name) {
  expanded.value = isExpanded(name) ? expanded.value.filter((entry) => entry !== name) : [...expanded.value, name]
}

async function loadPlan() {
  plan.value = await api('/allocation/plan')
}

async function loadFunds() {
  ledgerFunds.value = await api('/ledger/funds')
}

async function loadOverview(fresh = false) {
  if (fresh) refreshing.value = true
  try {
    const data = await api(`/allocation/overview${fresh ? '?refresh=1' : ''}`)
    overview.value = data
    lastUpdated.value = data.updated_at || ''
    lastFetchAt = Date.now()
    error.value = ''
  } catch (e) {
    error.value = String(e.message || e)
  } finally {
    refreshing.value = false
    loading.value = false
  }
}

function manualRefresh() {
  if (editing.value) return
  // 记账本/计划可能在其它标签页改动过，一并刷新
  loadPlan().catch(() => {})
  loadFunds().catch(() => {})
  loadOverview(true)
}

function startEdit() {
  if (!plan.value) return
  showRebalance.value = false
  notice.value = ''
  error.value = ''
  draft.value = {
    name: plan.value.name,
    total_amount: plan.value.total_amount,
    items: plan.value.items.map((item) => ({
      name: item.name,
      ratio_pct: Math.round(item.ratio * 10000) / 100,
      group_name: item.group_name || '',
      fund_codes: [...(item.fund_codes || [])],
      asset_types: [...(item.asset_types || [])]
    }))
  }
  editing.value = true
}

function cancelEdit() {
  editing.value = false
  draft.value = null
  mappingIndex.value = -1
}

function addItem() {
  draft.value.items.push({ name: '新类别', ratio_pct: 0, group_name: '', fund_codes: [], asset_types: [] })
}

function removeItem(index) {
  draft.value.items.splice(index, 1)
  if (mappingIndex.value === index) mappingIndex.value = -1
  else if (mappingIndex.value > index) mappingIndex.value -= 1
}

function openMapping(index) {
  mappingIndex.value = index
  fundSearch.value = ''
}

function closeMapping() {
  mappingIndex.value = -1
  fundSearch.value = ''
}

function fundOwnerName(code) {
  if (!draft.value) return ''
  const item = draft.value.items.find((entry) => entry.fund_codes.includes(code))
  return item ? item.name : ''
}

function autoOwnerName(assetType) {
  if (!draft.value) return ''
  const item = draft.value.items.find((entry) => entry.asset_types.includes(assetType))
  return item ? item.name : ''
}

function toggleFund(code) {
  const current = mappingItem.value
  if (!current) return
  if (current.fund_codes.includes(code)) {
    current.fund_codes = current.fund_codes.filter((entry) => entry !== code)
    return
  }
  // 一只基金只能归一个类别：勾选即从其它类别移出
  for (const item of draft.value.items) {
    if (item !== current) item.fund_codes = item.fund_codes.filter((entry) => entry !== code)
  }
  current.fund_codes = [...current.fund_codes, code]
}

function toggleAutoType(assetType) {
  const current = mappingItem.value
  if (!current) return
  if (current.asset_types.includes(assetType)) {
    current.asset_types = current.asset_types.filter((entry) => entry !== assetType)
    return
  }
  // 自动类型也只允许挂在一个类别下，避免同一类型重复计入
  for (const item of draft.value.items) {
    if (item !== current) item.asset_types = item.asset_types.filter((entry) => entry !== assetType)
  }
  current.asset_types = [...current.asset_types, assetType]
}

async function saveEdit() {
  if (!canSave.value || !draft.value) return
  saving.value = true
  error.value = ''
  try {
    await api('/allocation/plan', {
      method: 'PUT',
      body: {
        name: String(draft.value.name || '').trim() || '目标配置',
        total_amount: Number(draft.value.total_amount) || 0,
        items: draft.value.items.map((item) => ({
          name: String(item.name || '').trim(),
          ratio: Number((Number(item.ratio_pct || 0) / 100).toFixed(6)),
          group_name: String(item.group_name || '').trim(),
          fund_codes: item.fund_codes,
          asset_types: item.asset_types
        }))
      }
    })
    await loadPlan()
    await loadOverview(true)
    editing.value = false
    draft.value = null
    mappingIndex.value = -1
    notice.value = '配置已保存，目标金额与完成度已按新比例重算'
  } catch (e) {
    error.value = String(e.message || e)
  } finally {
    saving.value = false
  }
}

function onVisibilityChange() {
  if (document.hidden || editing.value || Date.now() - lastFetchAt <= 30_000) return
  loadPlan().catch(() => {})
  loadFunds().catch(() => {})
  loadOverview(false)
}

function onWindowFocus() {
  if (editing.value || Date.now() - lastFetchAt <= 30_000) return
  loadPlan().catch(() => {})
  loadFunds().catch(() => {})
  loadOverview(false)
}

onMounted(async () => {
  try {
    await Promise.all([loadPlan(), loadFunds()])
    await loadOverview(true)
  } catch (e) {
    error.value = String(e.message || e)
    loading.value = false
  }
  timer = setInterval(() => {
    if (document.hidden || editing.value) return
    loadOverview(false)
  }, AUTO_REFRESH_MS)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('focus', onWindowFocus)
})

onBeforeUnmount(() => {
  clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('focus', onWindowFocus)
})
</script>

<template>
  <div class="allocation-page">
    <h2 class="bz-section">目标配置与投入进度</h2>

    <div v-if="error" class="bz-error">{{ error }}</div>
    <div v-if="notice" class="bz-ok">{{ notice }}</div>

    <div class="allocation-toolbar">
      <div class="toolbar-actions">
        <template v-if="!editing">
          <button class="primary" :disabled="!plan" @click="startEdit">编辑配置</button>
        </template>
        <template v-else>
          <button class="primary" :disabled="!canSave || saving" @click="saveEdit">
            {{ saving ? '保存中…' : '保存配置' }}
          </button>
          <button :disabled="saving" @click="cancelEdit">取消</button>
        </template>
        <button :disabled="refreshing || editing || !overview" @click="manualRefresh">
          {{ refreshing ? '刷新中…' : '刷新行情' }}
        </button>
        <button
          :disabled="!overview || !totals || editing || !(totals.ratio_sum > 0)"
          title="按当前已归类市值或新增资金生成增减配清单"
          @click="showRebalance = true"
        >
          再平衡方案
        </button>
      </div>
      <div class="stamp">
        <span v-if="overview">数据更新：{{ lastUpdated || '—' }} · 每 60 秒自动刷新</span>
        <span v-else>加载中…</span>
      </div>
    </div>

    <div v-if="loading && !overview" class="bz-note">正在读取目标配置与记账本真实投入…</div>

    <!-- 编辑态 -->
    <fieldset v-if="editing && draft" class="allocation-plan-form">
      <legend>计划</legend>
      <div class="bz-form-row">
        <label>计划名称</label>
        <input v-model="draft.name" type="text" class="wide" maxlength="40" />
      </div>
      <div class="bz-form-row">
        <label>计划总金额（元）</label>
        <input v-model.number="draft.total_amount" type="number" min="0" step="1000" />
        <span class="bz-hint">各类目标金额 = 计划总金额 × 目标比例</span>
      </div>
    </fieldset>

    <div v-if="editing && draft" class="allocation-table-wrap">
      <table class="bz allocation-editor">
        <thead>
          <tr>
            <th>类别名称</th>
            <th>分组（可选）</th>
            <th class="num">目标比例 %</th>
            <th class="num">目标金额</th>
            <th>关联标的</th>
            <th>自动归入类型</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, index) in draft.items" :key="index">
            <td><input v-model="item.name" type="text" maxlength="20" class="allocation-input-name" /></td>
            <td><input v-model="item.group_name" type="text" maxlength="20" class="allocation-input-group" placeholder="如：商品/另类" /></td>
            <td class="num"><input v-model.number="item.ratio_pct" type="number" min="0" max="100" step="0.01" class="allocation-input-ratio" /></td>
            <td class="num">{{ fmtMoney(((Number(draft.total_amount) || 0) * (Number(item.ratio_pct) || 0)) / 100) }}</td>
            <td>
              <button @click="openMapping(index)">关联标的（{{ item.fund_codes.length }}）</button>
              <div class="bz-hint">{{ memberSummary(item) }}</div>
            </td>
            <td>
              <span class="bz-hint">{{ autoTypeSummary(item) }}</span>
            </td>
            <td><button class="danger" @click="removeItem(index)">删除</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="editing && draft" class="allocation-edit-footer">
      <button @click="addItem">+ 添加类别</button>
      <span :class="ratioBalanced ? 'allocation-ok' : 'allocation-over'">比例合计：{{ ratioSum.toFixed(2) }}%</span>
      <span class="bz-hint">必须正好 100% 才能保存。类别名重复、同一标的归入两个类别都会被拒绝。</span>
    </div>

    <!-- 展示态 -->
    <template v-if="!editing && overview && totals">
      <table class="bz bz-summary allocation-summary">
        <tbody>
          <tr>
            <th>计划总金额</th>
            <td class="num big">{{ fmtMoney(totals.planned_total) }} 元</td>
            <th>真实累计投入</th>
            <td class="num big">{{ fmtMoney(totals.actual_invested) }} 元</td>
            <th>总体完成度</th>
            <td class="num big">{{ fmtPct(totals.completion, 1) }}</td>
          </tr>
          <tr>
            <th>当前总市值</th>
            <td class="num">{{ fmtMoney(totals.market_value) }} 元</td>
            <th>剩余待投</th>
            <td class="num" :class="(totals.remaining || 0) < 0 ? 'allocation-over' : ''">{{ fmtMoney(totals.remaining) }} 元</td>
            <th>未归类资金</th>
            <td class="num">
              {{ fmtMoney(totals.unassigned_invested) }} 元
              <span v-if="overview.unassigned.length" class="allocation-over">（{{ overview.unassigned.length }} 个标的）</span>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="allocation-overall">
        <ProgressBar :value="totals.completion" large />
        <div class="bz-hint">
          投入完成度 {{ fmtPct(totals.completion, 1) }} · 累计投入本金 {{ fmtMoney(totals.actual_invested) }} 元 /
          计划 {{ fmtMoney(totals.planned_total) }} 元 · 当前市值 {{ fmtMoney(totals.market_value) }} 元
        </div>
      </div>

      <div v-if="overview.unassigned.length" class="bz-note">
        <b>有 {{ overview.unassigned.length }} 个持仓还没归类</b>（已计入总投入和当前市值，但不算进任何类别）：
        <span v-for="item in overview.unassigned" :key="item.code">
          {{ item.name }}（{{ item.code }}）
          <span class="bz-hint">投入 {{ fmtMoney(item.invested) }} · 市值 {{ fmtMoney(item.market_value) }}</span>；
        </span>
        <button style="margin-left: 6px" @click="startEdit">去归类</button>
      </div>

      <div class="allocation-table-wrap">
        <table class="bz allocation-table">
          <thead>
            <tr>
              <th>类别</th>
              <th class="num">目标比例</th>
              <th class="num">目标金额</th>
              <th class="num">实际投入</th>
              <th>完成度</th>
              <th class="num">差额</th>
              <th class="num">当前市值</th>
              <th class="num">资金占比（已归类）</th>
              <th class="num">配置偏离</th>
              <th class="num">再平衡（按当前市值）</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in viewRows" :key="row.key">
              <tr v-if="row.type === 'group'" class="allocation-group-row">
                <td>{{ row.name }} <span class="bz-hint">（{{ row.group.items.length }} 个子类合计）</span></td>
                <td class="num">{{ fmtPct(row.group.ratio, 1) }}</td>
                <td class="num">{{ fmtMoney(row.group.target_amount) }}</td>
                <td class="num">{{ fmtMoney(row.group.actual_invested) }}</td>
                <td>
                  <ProgressBar :value="row.group.completion" />
                  <span class="allocation-progress-text">{{ fmtPct(row.group.completion, 1) }}</span>
                </td>
                <td class="num" :class="gapClass(row.group.gap)">{{ gapText(row.group.gap) }}</td>
                <td class="num">{{ fmtMoney(row.group.market_value) }}</td>
                <td class="num">{{ fmtPct(row.group.market_share, 1) }}</td>
                <td class="num" :class="deviationClass(row.group.deviation)">{{ pp(row.group.deviation) }}</td>
                <td class="num" :class="rebalanceClass(row.group.rebalance_delta)">{{ rebalanceText(row.group.rebalance_delta) }}</td>
              </tr>
              <tr v-else-if="row.type === 'item'">
                <td
                  class="allocation-category"
                  :class="{ clickable: row.item.members.length > 0 }"
                  :title="row.item.members.map((m) => `${m.name} ${fmtMoney(m.invested)} 元`).join('\n')"
                  @click="row.item.members.length && toggleExpand(row.item.name)"
                >
                  <span v-if="row.item.members.length" class="allocation-cat-toggle">{{ isExpanded(row.item.name) ? '▾' : '▸' }}</span>
                  {{ row.item.name }}
                  <span class="bz-hint">{{ row.item.members.length }} 只</span>
                  <span v-if="row.item.asset_types.length" class="bz-badge" :title="'按资产类型自动归入：' + autoTypeSummary(row.item)">自动</span>
                </td>
                <td class="num">{{ fmtPct(row.item.ratio, 1) }}</td>
                <td class="num">{{ fmtMoney(row.item.target_amount) }}</td>
                <td class="num">{{ fmtMoney(row.item.actual_invested) }}</td>
                <td>
                  <ProgressBar :value="row.item.completion" />
                  <span class="allocation-progress-text">{{ fmtPct(row.item.completion, 1) }}</span>
                </td>
                <td class="num" :class="gapClass(row.item.gap)">{{ gapText(row.item.gap) }}</td>
                <td class="num">{{ fmtMoney(row.item.market_value) }}</td>
                <td class="num">{{ fmtPct(row.item.market_share, 1) }}</td>
                <td class="num" :class="deviationClass(row.item.deviation)">{{ pp(row.item.deviation) }}</td>
                <td class="num" :class="rebalanceClass(row.item.rebalance_delta)">{{ rebalanceText(row.item.rebalance_delta) }}</td>
              </tr>
              <tr v-else class="allocation-member-row">
                <td colspan="3">└ {{ row.member.name }} <span class="bz-hint">{{ row.member.code }}</span></td>
                <td class="num">{{ fmtMoney(row.member.invested) }}</td>
                <td colspan="2" class="bz-hint">{{ row.member.valuation_source || '—' }}</td>
                <td class="num">{{ fmtMoney(row.member.market_value) }}</td>
                <td colspan="3" class="bz-hint">{{ row.member.valuation_date || '' }}</td>
              </tr>
            </template>
            <tr v-if="!viewRows.length">
              <td colspan="10" style="text-align: center; color: #777">还没有配置类别 —— 点「编辑配置」添加</td>
            </tr>
            <tr class="allocation-total-row">
              <td>{{ overview.unassigned.length ? '已归类合计' : '合计' }}</td>
              <td class="num">{{ fmtPct(totals.ratio_sum, 1) }}</td>
              <td class="num">{{ fmtMoney(totals.planned_total) }}</td>
              <td class="num">{{ fmtMoney(totals.categorized_invested) }}</td>
              <td>
                <ProgressBar :value="totals.categorized_completion" />
                <span class="allocation-progress-text">{{ fmtPct(totals.categorized_completion, 1) }}</span>
              </td>
              <td class="num" :class="gapClass(totals.categorized_remaining)">{{ gapText(totals.categorized_remaining) }}</td>
              <td class="num">{{ fmtMoney(totals.categorized_market_value) }}</td>
              <td class="num">{{ (totals.categorized_market_value || 0) > 0 ? '100.0%' : '—' }}</td>
              <td class="num">—</td>
              <td class="num">—</td>
            </tr>
          </tbody>
        </table>
      </div>

      <ChartBox v-if="chartOption.series" title="目标 vs 实际 vs 当前市值（元）" :option="chartOption" height="300px" />
    </template>

    <!-- 标的归类弹窗 -->
    <div v-if="editing && mappingItem" class="bz-modal-backdrop" @click.self="closeMapping">
      <div class="bz-modal">
        <div class="modal-head">
          <span>「{{ mappingItem.name }}」关联标的</span>
          <button @click="closeMapping">关闭</button>
        </div>
        <div class="modal-body">
          <fieldset>
            <legend>按资产类型自动归入</legend>
            <label v-for="option in AUTO_TYPE_OPTIONS" :key="option.value" class="allocation-check">
              <input
                type="checkbox"
                :checked="mappingItem.asset_types.includes(option.value)"
                @change="toggleAutoType(option.value)"
              />
              {{ option.label }}
            </label>
            <div class="bz-hint">勾选后，记账本里该类资产（含以后新增）自动计入本类别；单个标的的手工指定优先。</div>
          </fieldset>

          <div class="bz-form-row">
            <label>筛选标的</label>
            <input v-model="fundSearch" type="text" class="wide" placeholder="代码或名称" />
            <span class="bz-hint">记账本共 {{ ledgerFunds.length }} 个标的</span>
          </div>

          <table class="bz allocation-fund-table">
            <thead>
              <tr>
                <th>选择</th>
                <th>代码</th>
                <th>名称</th>
                <th>类型</th>
                <th>当前归类</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="fund in filteredFunds" :key="fund.code">
                <td>
                  <input
                    type="checkbox"
                    :checked="mappingItem.fund_codes.includes(fund.code)"
                    @change="toggleFund(fund.code)"
                  />
                </td>
                <td>{{ fund.code }}</td>
                <td>{{ fund.name }}</td>
                <td>{{ assetTypeLabel(fund) }}</td>
                <td>
                  <span v-if="mappingItem.fund_codes.includes(fund.code)" class="bz-badge">本类别</span>
                  <span v-else-if="fundOwnerName(fund.code)" class="bz-hint">{{ fundOwnerName(fund.code) }}</span>
                  <span v-else-if="autoOwnerName(fund.asset_type)" class="bz-hint">自动：{{ autoOwnerName(fund.asset_type) }}</span>
                  <span v-else class="allocation-over">未归类</span>
                </td>
              </tr>
              <tr v-if="!filteredFunds.length">
                <td colspan="5" style="text-align: center; color: #777">没有匹配的标的</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="modal-foot">
          <button class="primary" @click="closeMapping">完成</button>
        </div>
      </div>
    </div>

    <RebalanceModal v-if="showRebalance && overview && totals" :overview="overview" @close="showRebalance = false" />
  </div>
</template>
