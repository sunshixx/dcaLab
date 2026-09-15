<script setup>
// 方案对比：勾选已保存方案 → 并排重算 → 表格 + 柱状图对比
import { onMounted, ref, computed, watch } from 'vue'
import { api } from '../api.js'
import { fmtMoney, fmtWan, fmtPct } from '../fmt.js'
import ChartBox from '../components/ChartBox.vue'
import { useCalcStore } from '../stores/calcStore.js'

const calc = useCalcStore()
const plans = ref([])
const picked = ref([]) // 选中的方案 id
const results = ref([]) // [{id, name, result}]
const loading = ref(false)
const msg = ref('')

onMounted(refresh)

// 频率 → 每期金额字段与单位（方案可能存的是按日/按月/按年，不能一律显示「月投入」）
const FREQ = {
  monthly: { unit: '月', field: 'monthly_amount' },
  trading_day: { unit: '交易日', field: 'daily_amount' },
  yearly: { unit: '年', field: 'yearly_amount' }
}
const perPeriod = (params) => {
  const f = FREQ[params.contribution_frequency] || FREQ.monthly
  const amount = Number(params[f.field])
  return Number.isFinite(amount) ? `${fmtMoney(amount)} 元/${f.unit}` : '—'
}

async function refresh() {
  try {
    plans.value = await api('/plans')
    // 默认勾选全部；已被删除的去掉
    const ids = new Set(plans.value.map((p) => p.id))
    picked.value = picked.value.filter((id) => ids.has(id))
    if (!picked.value.length) picked.value = plans.value.map((p) => p.id)
    await recompute()
  } catch (e) {
    msg.value = e.message
  }
}

// 并发守卫：refresh() 的显式调用与 picked 的 watch 会同时触发，
// 若不加序号，两次运行会各自向 results 追加，导致每个方案重复渲染。
let runSeq = 0

async function recompute() {
  const seq = ++runSeq
  loading.value = true
  msg.value = ''
  const acc = []
  try {
    for (const id of picked.value) {
      const meta = plans.value.find((p) => p.id === id)
      if (!meta) continue
      const full = await api(`/plans/${id}`)
      const r = await api('/calculate', { method: 'POST', body: full.params })
      if (seq !== runSeq) return // 已有更新的运行，丢弃本次结果
      acc.push({ id, name: meta.name, r, params: full.params })
    }
    if (seq !== runSeq) return
    results.value = acc
  } catch (e) {
    if (seq === runSeq) msg.value = `重算失败：${e.message}`
  } finally {
    if (seq === runSeq) loading.value = false
  }
}

// 勾选变化即重算，无需再点按钮
watch(picked, () => recompute(), { deep: true })

function toggleAll(on) {
  picked.value = on ? plans.value.map((p) => p.id) : []
}

function del(id) {
  if (!window.confirm('删除该方案？')) return
  api(`/plans/${id}`, { method: 'DELETE' }).then(refresh).catch((e) => (msg.value = e.message))
}

const compareOption = computed(() => {
  if (!results.value.length) return {}
  const names = results.value.map((x) => x.name)
  return {
    xAxis: { type: 'category', data: names },
    yAxis: { type: 'value', axisLabel: { formatter: (v) => (v / 10000).toFixed(0) + '万' } },
    series: [
      {
        name: '名义终值',
        type: 'bar',
        barWidth: 40,
        data: results.value.map((x) => x.r.final_value),
        itemStyle: { color: '#4a7ebb', borderColor: '#2f5c84', borderWidth: 1 }
      },
      {
        name: '实际购买力',
        type: 'bar',
        barWidth: 40,
        data: results.value.map((x) => x.r.final_value_real),
        itemStyle: { color: '#9bbb59', borderColor: '#718a3e', borderWidth: 1 }
      },
      {
        name: '总费用（终值口径）',
        type: 'bar',
        barWidth: 40,
        data: results.value.map((x) => x.r.total_cost_terminal),
        itemStyle: { color: '#c0504d', borderColor: '#8f3a38', borderWidth: 1 }
      }
    ]
  }
})

// 当前页面参数快捷保存（复用模拟器 store 的 payload）
async function saveCurrent() {
  const name = window.prompt('把当前模拟器参数保存为方案，名称：', `方案 ${new Date().toLocaleDateString('zh-CN')}`)
  if (!name) return
  try {
    await calc.savePlan(name)
    await refresh()
  } catch (e) {
    msg.value = e.message
  }
}
</script>

<template>
  <div>
    <p>
      <button @click="saveCurrent">把当前模拟器参数存为方案</button>
      <span class="bz-hint"> 在模拟器页点「保存方案」也会出现在这里</span>
    </p>

    <fieldset v-if="plans.length">
      <legend>选择要对比的方案（勾选即自动重算）</legend>
      <div class="bz-form-row">
        <button style="padding: 1px 8px" @click="toggleAll(true)">全选</button>
        <button style="padding: 1px 8px" @click="toggleAll(false)">全不选</button>
        <span class="bz-hint"> 已选 {{ picked.length }} / {{ plans.length }}</span>
      </div>
      <div v-for="p in plans" :key="p.id" class="bz-form-row">
        <label>
          <input type="checkbox" :value="p.id" v-model="picked" />
          {{ p.name }}
        </label>
        <span class="bz-hint">{{ p.created_at }}</span>
        <button class="danger" style="float: right; padding: 0 6px" @click="del(p.id)">删</button>
      </div>
    </fieldset>

    <div v-if="msg" class="bz-error">{{ msg }}</div>
    <div v-if="loading" class="bz-note">重算中…</div>
    <div v-if="!plans.length" class="bz-note">
      还没有已保存的方案 —— 在模拟器页调好参数后点「保存方案」，或用上方按钮把当前参数存为方案。
    </div>
    <div v-else-if="!picked.length && !loading" class="bz-note">请至少勾选一个方案。</div>

    <template v-if="results.length">
      <h2 class="bz-section">方案终值对比</h2>
      <ChartBox title="方案终值对比" :option="compareOption" />

      <h2 class="bz-section">方案明细对比</h2>
      <table class="bz">
        <tr>
          <th>方案</th>
          <th>定投频率</th>
          <th class="num">每期金额</th>
          <th class="num">年数</th>
          <th class="num">标的数</th>
          <th class="num">总投入</th>
          <th class="num">名义终值</th>
          <th class="num">实际购买力</th>
          <th class="num">费用（名义）</th>
          <th class="num">费用（终值口径）</th>
          <th class="num">真实成本率</th>
        </tr>
        <tr v-for="x in results" :key="x.id">
          <td>{{ x.name }}</td>
          <td>{{ (FREQ[x.params.contribution_frequency] || FREQ.monthly).unit === '交易日' ? '每个交易日' : (FREQ[x.params.contribution_frequency] || FREQ.monthly).unit === '年' ? '每年一次' : '每月一次' }}</td>
          <td class="num">{{ perPeriod(x.params) }}</td>
          <td class="num">{{ x.r.years }}</td>
          <td class="num">{{ x.r.asset_details.length }}</td>
          <td class="num">{{ fmtMoney(x.r.total_investment) }}</td>
          <td class="num big">{{ fmtWan(x.r.final_value) }}</td>
          <td class="num">{{ fmtWan(x.r.final_value_real) }}</td>
          <td class="num">{{ fmtMoney(x.r.total_cost) }}</td>
          <td class="num">{{ fmtMoney(x.r.total_cost_terminal) }}</td>
          <td class="num">{{ fmtPct(x.r.total_cost_terminal / x.r.final_value) }}</td>
        </tr>
      </table>
    </template>
  </div>
</template>
