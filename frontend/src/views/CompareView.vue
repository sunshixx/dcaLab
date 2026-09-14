<script setup>
// 方案对比：保存当前参数 → 并排重算多个方案 → 表格 + 柱状图对比
import { onMounted, ref, computed } from 'vue'
import { api } from '../api.js'
import { fmtMoney, fmtWan, fmtPct } from '../fmt.js'
import ChartBox from '../components/ChartBox.vue'
import { useCalcStore } from '../stores/calcStore.js'

const calc = useCalcStore()
const plans = ref([])
const results = ref([]) // [{id, name, result}]
const loading = ref(false)
const msg = ref('')

onMounted(refresh)

async function refresh() {
  try {
    plans.value = await api('/plans')
  } catch (e) {
    msg.value = e.message
  }
}

async function recomputeAll() {
  loading.value = true
  msg.value = ''
  results.value = []
  try {
    for (const p of plans.value) {
      const full = await api(`/plans/${p.id}`)
      const r = await api('/calculate', { method: 'POST', body: full.params })
      results.value.push({ id: p.id, name: p.name, r, monthly: full.params.monthly_amount })
    }
  } catch (e) {
    msg.value = e.message
  } finally {
    loading.value = false
  }
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
      <button class="primary" :disabled="loading || !plans.length" @click="recomputeAll">
        {{ loading ? '重算中…' : '重算全部方案' }}
      </button>
      <button @click="saveCurrent">把当前模拟器参数存为方案</button>
      <span class="bz-hint"> 建议分别保存“纯场内 / 纯场外 / 动态切换”三套参数做对比</span>
    </p>
    <div v-if="msg" class="bz-error">{{ msg }}</div>
    <div v-if="!plans.length" class="bz-note">还没有已保存的方案 —— 在模拟器页保存，或用上方按钮把当前参数存为方案。</div>

    <template v-if="results.length">
      <ChartBox title="方案终值对比" :option="compareOption" />

      <h2 class="bz-section">方案明细对比</h2>
      <table class="bz">
        <tr>
          <th>方案</th>
          <th class="num">月投入</th>
          <th class="num">年数</th>
          <th class="num">标的数</th>
          <th class="num">总投入</th>
          <th class="num">名义终值</th>
          <th class="num">实际购买力</th>
          <th class="num">费用（名义）</th>
          <th class="num">费用（终值口径）</th>
          <th class="num">真实成本率</th>
          <th></th>
        </tr>
        <tr v-for="x in results" :key="x.id">
          <td>{{ x.name }}</td>
          <td class="num">{{ fmtMoney(x.monthly) }}</td>
          <td class="num">{{ x.r.years }}</td>
          <td class="num">{{ x.r.asset_details.length }}</td>
          <td class="num">{{ fmtMoney(x.r.total_investment) }}</td>
          <td class="num big">{{ fmtWan(x.r.final_value) }}</td>
          <td class="num">{{ fmtWan(x.r.final_value_real) }}</td>
          <td class="num">{{ fmtMoney(x.r.total_cost) }}</td>
          <td class="num">{{ fmtMoney(x.r.total_cost_terminal) }}</td>
          <td class="num">{{ fmtPct(x.r.total_cost_terminal / x.r.final_value) }}</td>
          <td><button class="danger" style="padding: 0 6px" @click="del(x.id)">删</button></td>
        </tr>
      </table>
    </template>
  </div>
</template>
