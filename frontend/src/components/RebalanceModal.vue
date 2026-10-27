<script setup>
// 再平衡方案：基于当前实时市值生成「增配 / 减配」清单
// 模式一：按当前已归类市值全额再平衡（有买有卖）
// 模式二：只用新增资金补低配（只买不卖）
import { computed, ref } from 'vue'
import { fmtMoney, fmtPct } from '../fmt.js'

const props = defineProps({
  overview: { type: Object, required: true }
})
defineEmits(['close'])

const mode = ref(Number(props.overview.totals?.rebalance_base) > 0 ? 'full' : 'cash')
const newCash = ref(null)
const expanded = ref([])
const copied = ref(false)

const items = computed(() => props.overview.items || [])
const base = computed(() => {
  const value = Number(props.overview.totals?.rebalance_base)
  if (Number.isFinite(value) && value > 0) return value
  return items.value.reduce((sum, item) => sum + (Number(item.market_value) || 0), 0)
})
const unassigned = computed(() => Number(props.overview.totals?.unassigned_market_value) || 0)
const cashAmount = computed(() => Math.max(0, Number(newCash.value) || 0))
const postBase = computed(() => base.value + cashAmount.value)

const rows = computed(() => {
  if (mode.value === 'full') {
    return items.value.map((item) => {
      const current = Number(item.market_value) || 0
      const target = item.ratio * base.value
      const delta = target - current
      const action = delta > 0.005 ? '增配' : delta < -0.005 ? '减配' : '不动'
      const amount = action === '不动' ? 0 : Math.abs(delta)
      const after = action === '不动' ? current : target
      const afterShare = base.value > 0 ? after / base.value : null
      return {
        key: item.name,
        item,
        current,
        currentShare: base.value > 0 ? current / base.value : null,
        target,
        delta,
        action,
        amount,
        after,
        afterShare,
        deviation: afterShare == null ? null : afterShare - item.ratio
      }
    })
  }

  // 只用新增资金：目标市值按「当前已归类市值 + 新增资金」放大，只给低配类别分钱
  const total = postBase.value
  const deficits = items.value.map((item) =>
    Math.max(0, item.ratio * total - (Number(item.market_value) || 0))
  )
  const deficitSum = deficits.reduce((sum, value) => sum + value, 0)
  return items.value.map((item, index) => {
    const current = Number(item.market_value) || 0
    const target = item.ratio * total
    const deficit = deficits[index]
    const buy = deficitSum > 0 ? (cashAmount.value * deficit) / deficitSum : 0
    const after = current + buy
    const afterShare = total > 0 ? after / total : null
    return {
      key: item.name,
      item,
      current,
      currentShare: base.value > 0 ? current / base.value : null,
      target,
      delta: target - current,
      action: buy > 0.005 ? '增配' : '不动',
      amount: buy > 0.005 ? buy : 0,
      after,
      afterShare,
      deviation: afterShare == null ? null : afterShare - item.ratio
    }
  })
})

const buyTotal = computed(() =>
  rows.value.reduce((sum, row) => sum + (row.action === '增配' ? row.amount : 0), 0)
)
const sellTotal = computed(() =>
  rows.value.reduce((sum, row) => sum + (row.action === '减配' ? row.amount : 0), 0)
)
const residual = computed(() => rows.value.some((row) => Math.abs(row.deviation || 0) > 0.005))
const missingMembers = computed(() =>
  rows.value.some((row) => row.action !== '不动' && !(row.item.members || []).length)
)

function signedMoney(value) {
  if (Math.abs(value) < 0.005) return '0'
  return (value > 0 ? '+' : '−') + fmtMoney(Math.abs(value))
}

function isExpanded(name) {
  return expanded.value.includes(name)
}

function toggle(name) {
  expanded.value = isExpanded(name)
    ? expanded.value.filter((entry) => entry !== name)
    : [...expanded.value, name]
}

function memberSuggestions(row) {
  const members = row.item.members || []
  if (!members.length) return []
  const signed = mode.value === 'full' ? row.delta : row.amount
  const totalValue = members.reduce((sum, member) => sum + Math.max(0, Number(member.market_value) || 0), 0)
  return members.map((member) => {
    const weight = totalValue > 0 ? Math.max(0, Number(member.market_value) || 0) / totalValue : 1 / members.length
    return { ...member, suggested: signed * weight }
  })
}

const planText = computed(() => {
  const lines = []
  lines.push(`再平衡方案（${mode.value === 'full' ? '按当前市值' : '只用新增资金'}）`)
  lines.push(`再平衡基准：已归类市值 ${fmtMoney(base.value)} 元`)
  if (unassigned.value > 0) lines.push(`未归类市值 ${fmtMoney(unassigned.value)} 元不参与`)
  if (mode.value === 'cash') lines.push(`本次新增资金：${fmtMoney(cashAmount.value)} 元`)
  for (const row of rows.value) {
    if (row.action === '不动') continue
    lines.push(
      `${row.item.name}：${row.action} ${fmtMoney(row.amount)} 元（当前 ${fmtMoney(row.current)}，目标 ${fmtMoney(row.target)}）`
    )
    for (const member of memberSuggestions(row)) {
      if (Math.abs(member.suggested) < 0.005) continue
      lines.push(
        `  - ${member.name}（${member.code}） ${member.suggested > 0 ? '增配' : '减配'} ${fmtMoney(Math.abs(member.suggested))} 元`
      )
    }
  }
  if (mode.value === 'full') {
    lines.push(`合计：增配 ${fmtMoney(buyTotal.value)} 元，减配 ${fmtMoney(sellTotal.value)} 元`)
  } else {
    lines.push(`合计：买入 ${fmtMoney(buyTotal.value)} 元（不卖出）`)
  }
  return lines.join('\n')
})

async function copyPlan() {
  const text = planText.value
  const done = () => {
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  }
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(text)
    done()
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    try {
      document.execCommand('copy')
      done()
    } catch {
      /* 忽略：浏览器不允许复制时保持原状 */
    }
    document.body.removeChild(area)
  }
}
</script>

<template>
  <div class="bz-modal-backdrop" @click.self="$emit('close')">
    <div class="bz-modal rebalance-modal">
      <div class="modal-head">
        <span>再平衡方案</span>
        <button @click="$emit('close')">关闭</button>
      </div>
      <div class="modal-body">
        <div class="rebalance-tabs">
          <button :class="{ active: mode === 'full' }" @click="mode = 'full'">按当前市值再平衡</button>
          <button :class="{ active: mode === 'cash' }" @click="mode = 'cash'">只用新增资金</button>
        </div>

        <div class="rebalance-meta">
          <span>再平衡基准：已归类持仓市值 <b>{{ fmtMoney(base) }}</b> 元</span>
          <span v-if="mode === 'cash' && cashAmount > 0">加资金后组合市值 <b>{{ fmtMoney(postBase) }}</b> 元</span>
          <span v-if="unassigned > 0" class="allocation-over">未归类 {{ fmtMoney(unassigned) }} 元不参与</span>
          <span class="bz-hint">数据更新：{{ overview.updated_at || '—' }}</span>
        </div>

        <div v-if="mode === 'cash'" class="bz-form-row">
          <label>本次新增资金（元）</label>
          <input v-model.number="newCash" type="number" min="0" step="1000" placeholder="例如 10000" />
          <span class="bz-hint">只买不卖，按低配缺口分配</span>
        </div>

        <div class="rebalance-table-wrap">
          <table class="bz rebalance-table">
            <thead>
              <tr>
                <th>类别</th>
                <th class="num">目标比例</th>
                <th class="num">当前市值</th>
                <th class="num">当前占比</th>
                <th class="num">目标市值</th>
                <th class="num">差额</th>
                <th>操作</th>
                <th class="num">建议金额</th>
                <th class="num">交易后占比</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="row in rows" :key="row.key">
                <tr :class="{ 'rebalance-hold': row.action === '不动' }">
                  <td
                    class="allocation-category"
                    :class="{ clickable: row.item.members.length > 0 }"
                    @click="row.item.members.length && toggle(row.item.name)"
                  >
                    <span v-if="row.item.members.length" class="allocation-cat-toggle">{{ isExpanded(row.item.name) ? '▾' : '▸' }}</span>
                    {{ row.item.name }}
                    <span class="bz-hint">{{ row.item.members.length }} 只</span>
                  </td>
                  <td class="num">{{ fmtPct(row.item.ratio, 1) }}</td>
                  <td class="num">{{ fmtMoney(row.current) }}</td>
                  <td class="num">{{ fmtPct(row.currentShare, 1) }}</td>
                  <td class="num">{{ fmtMoney(row.target) }}</td>
                  <td class="num" :class="row.delta > 0 ? 'allocation-need' : row.delta < 0 ? 'allocation-over' : ''">
                    {{ signedMoney(row.delta) }}
                  </td>
                  <td>{{ row.action }}</td>
                  <td class="num">{{ row.amount > 0 ? fmtMoney(row.amount) : '—' }}</td>
                  <td class="num">{{ fmtPct(row.afterShare, 1) }}</td>
                </tr>
                <template v-if="isExpanded(row.item.name) && row.item.members.length">
                  <tr v-for="member in memberSuggestions(row)" :key="member.code" class="rebalance-member-row">
                    <td colspan="4">└ {{ member.name }} <span class="bz-hint">{{ member.code }}</span> · 市值 {{ fmtMoney(member.market_value) }}</td>
                    <td colspan="3" class="bz-hint">{{ member.valuation_source || '—' }}</td>
                    <td class="num">{{ Math.abs(member.suggested) > 0.005 ? fmtMoney(Math.abs(member.suggested)) : '—' }}</td>
                    <td class="num">{{ member.suggested > 0.005 ? '增配' : member.suggested < -0.005 ? '减配' : '' }}</td>
                  </tr>
                </template>
                <tr v-if="!isExpanded(row.item.name) && row.action !== '不动' && !row.item.members.length">
                  <td colspan="9" class="bz-hint">未关联标的，先在「编辑配置」里关联基金才能拆分到具体标的</td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <div class="rebalance-summary">
          <span v-if="mode === 'full'">增配合计 <b>{{ fmtMoney(buyTotal) }}</b> 元 · 减配合计 <b>{{ fmtMoney(sellTotal) }}</b> 元</span>
          <span v-else>新增资金 <b>{{ fmtMoney(cashAmount) }}</b> 元 · 建议买入 <b>{{ fmtMoney(buyTotal) }}</b> 元（不卖出）</span>
          <span v-if="mode === 'cash' && residual" class="bz-hint">只买不卖，仍有超配未消除</span>
          <span v-else-if="missingMembers" class="bz-hint">部分类别未关联标的，金额只到类别层</span>
        </div>
      </div>
      <div class="modal-foot rebalance-foot">
        <span v-if="copied" class="bz-ok">已复制</span>
        <span v-if="!base && mode === 'full'" class="bz-note">暂无可再平衡的已归类持仓市值</span>
        <button class="primary" :disabled="!buyTotal && !sellTotal" @click="copyPlan">复制清单</button>
        <button @click="$emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>
