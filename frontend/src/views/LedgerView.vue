<script setup>
// 记账本：添加基金（输代码自动查名）→ 录交易（自动回查净值）→ 流水管理 → CSV 导入导出
import { onMounted, ref, computed } from 'vue'
import { useLedgerStore } from '../stores/ledgerStore.js'
import { api } from '../api.js'
import { fmtMoney, fmtPct, TX_TYPE_CN } from '../fmt.js'

const store = useLedgerStore()
onMounted(() => store.loadAll())

// ── 添加基金 ──
const newCode = ref('')
const newName = ref('')
const addFundMsg = ref('')
const adding = ref(false)
async function addFund() {
  addFundMsg.value = ''
  if (!/^\d{6}$/.test(newCode.value)) {
    addFundMsg.value = '基金代码须为 6 位数字'
    return
  }
  adding.value = true
  try {
    await store.addFund({ code: newCode.value, name: newName.value || undefined })
    addFundMsg.value = 'ok'
    newCode.value = ''
    newName.value = ''
  } catch (e) {
    addFundMsg.value = e.message
  } finally {
    adding.value = false
  }
}

// ── 录入交易 ──
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const tx = ref({ fund_code: '', date: today(), type: 'buy', amount: null, nav: '', shares: '', fee: '', note: '' })
const txMsg = ref('')
const navHint = ref(null) // {nav, date, source}
const looking = ref(false)

// 输入代码+日期后自动回查该日净值
async function lookupNav() {
  navHint.value = null
  if (!/^\d{6}$/.test(tx.value.fund_code) || !tx.value.date) return
  looking.value = true
  try {
    const navs = await api(`/market/fund/${tx.value.fund_code}/navs?limit=30`)
    const hit = navs.find((n) => n.date <= tx.value.date)
    if (hit) {
      navHint.value = { nav: hit.nav, date: hit.date, source: hit.date === tx.value.date ? '当日净值' : `最近此前净值(${hit.date})` }
      tx.value.nav = hit.nav
    } else {
      navHint.value = { nav: null, source: '未查到该日期之前的净值，请手填' }
    }
  } catch {
    navHint.value = { nav: null, source: '净值查询暂不可用，请手填' }
  } finally {
    looking.value = false
  }
}

async function submitTx() {
  txMsg.value = ''
  try {
    await store.addTx({
      fund_code: tx.value.fund_code,
      date: tx.value.date,
      type: tx.value.type,
      amount: Number(tx.value.amount) || 0,
      nav: Number(tx.value.nav) || 0,
      shares: Number(tx.value.shares) || 0,
      fee: Number(tx.value.fee) || 0,
      note: tx.value.note
    })
    txMsg.value = 'ok'
    tx.value.amount = null
    tx.value.shares = ''
    tx.value.fee = ''
    tx.value.note = ''
  } catch (e) {
    txMsg.value = e.message
  }
}

// ── CSV 导入 ──
const csvFile = ref(null)
const importMsg = ref('')
async function doImport() {
  importMsg.value = ''
  const file = csvFile.value && csvFile.value.files && csvFile.value.files[0]
  if (!file) {
    importMsg.value = '请选择 CSV 文件'
    return
  }
  try {
    const text = await file.text()
    const res = await store.importCsv(text)
    importMsg.value = `导入 ${res.inserted} 条` + (res.skipped.length ? `，跳过 ${res.skipped.length} 条：` + res.skipped.slice(0, 3).join('；') : '')
    await store.loadAll()
  } catch (e) {
    importMsg.value = e.message
  }
}

const typeClass = (t) => (t === 'sell' ? 'neg' : t === 'buy' ? 'pos' : '')
</script>

<template>
  <div class="bz-layout">
    <!-- ── 左：录入区 ── -->
    <div class="bz-params">
      <fieldset>
        <legend>① 添加基金到记账本</legend>
        <div class="bz-form-row">
          <label>基金代码</label>
          <input type="text" v-model="newCode" maxlength="6" placeholder="如 050025" @keyup.enter="addFund" />
        </div>
        <div class="bz-form-row">
          <label>名称（可留空自动查询）</label>
          <input type="text" v-model="newName" class="wide" />
        </div>
        <p>
          <button :disabled="adding" @click="addFund">查询并添加</button>
          <span v-if="adding" class="bz-hint"> 查询中…</span>
        </p>
        <div v-if="addFundMsg && addFundMsg !== 'ok'" class="bz-error">{{ addFundMsg }}</div>
        <div v-else-if="addFundMsg === 'ok'" class="bz-ok">已添加</div>
      </fieldset>

      <fieldset>
        <legend>② 录入交易</legend>
        <div class="bz-form-row">
          <label>基金</label>
          <select v-model="tx.fund_code" @change="lookupNav">
            <option value="" disabled>选择基金</option>
            <option v-for="f in store.funds" :key="f.code" :value="f.code">{{ f.code }} {{ f.name }}</option>
          </select>
        </div>
        <div class="bz-form-row">
          <label>类型</label>
          <select v-model="tx.type">
            <option value="buy">买入（申购）</option>
            <option value="sell">卖出（赎回）</option>
            <option value="dividend_cash">现金分红</option>
            <option value="dividend_reinvest">分红再投资</option>
            <option value="fee">费用调整</option>
          </select>
        </div>
        <div class="bz-form-row">
          <label>日期</label>
          <input type="date" v-model="tx.date" @change="lookupNav" />
        </div>
        <div class="bz-form-row">
          <label>{{ tx.type === 'sell' ? '卖出总额（元）' : tx.type === 'dividend_cash' ? '分红到账（元）' : tx.type === 'fee' ? '费用金额（元）' : '实际扣款（元）' }}</label>
          <input type="number" v-model.number="tx.amount" min="0" />
          <span v-if="tx.type === 'buy' || tx.type === 'dividend_reinvest'" class="bz-hint">含手续费</span>
        </div>
        <div class="bz-form-row">
          <label>成交净值</label>
          <input type="number" v-model.number="tx.nav" step="0.0001" min="0" @change="lookupNav" />
          <button style="padding: 1px 6px" :disabled="looking" @click="lookupNav">回查</button>
        </div>
        <div v-if="navHint" class="bz-hint" style="margin-left: 154px">
          {{ navHint.source }}<template v-if="navHint.nav">：{{ navHint.nav }}</template>
        </div>
        <div class="bz-form-row">
          <label>份额（可留空自动算）</label>
          <input type="number" v-model.number="tx.shares" min="0" />
        </div>
        <div class="bz-form-row">
          <label>手续费（元）</label>
          <input type="number" v-model.number="tx.fee" min="0" step="0.01" />
          <span v-if="tx.type === 'buy' || tx.type === 'dividend_reinvest'" class="bz-hint">从实际扣款中扣除</span>
        </div>
        <div class="bz-form-row">
          <label>备注</label>
          <input type="text" v-model="tx.note" class="wide" />
        </div>
        <p>
          <button class="primary" @click="submitTx">保存记录</button>
        </p>
        <div v-if="txMsg && txMsg !== 'ok'" class="bz-error">{{ txMsg }}</div>
        <div v-else-if="txMsg === 'ok'" class="bz-ok">已保存</div>
      </fieldset>

      <fieldset>
        <legend>CSV 导入 / 导出</legend>
        <div class="bz-form-row">
          <input type="file" ref="csvFile" accept=".csv,text/csv" />
        </div>
        <p>
          <button @click="doImport">导入 CSV</button>
          <a class="bz-btn" href="/api/ledger/export.csv" download>导出 CSV</a>
        </p>
        <div v-if="importMsg" class="bz-note">{{ importMsg }}</div>
        <div class="bz-hint">
          列顺序：基金代码,基金名称,日期,类型(买入/卖出/现金分红/分红再投/费用调整),金额,净值,份额,手续费,备注
        </div>
      </fieldset>
    </div>

    <!-- ── 右：流水区 ── -->
    <div class="bz-results">
      <h2 class="bz-section">
        交易流水
        <select v-model="store.filterFund" style="font-size: 12px">
          <option value="">全部基金</option>
          <option v-for="f in store.funds" :key="f.code" :value="f.code">{{ f.code }} {{ f.name }}</option>
        </select>
      </h2>
      <div v-if="store.error" class="bz-error">{{ store.error }}</div>
      <div class="bz-scroll">
        <table class="bz">
          <tr>
            <th>#</th>
            <th>日期</th>
            <th>基金</th>
            <th>类型</th>
            <th class="num">金额</th>
            <th class="num">净值</th>
            <th class="num">份额</th>
            <th class="num">手续费</th>
            <th>备注</th>
            <th></th>
          </tr>
          <tr v-if="store.filteredTxs.length === 0">
            <td colspan="10" style="text-align: center; color: #777">暂无记录 —— 先在左侧添加基金并录入交易</td>
          </tr>
          <tr v-for="t in store.filteredTxs" :key="t.id">
            <td>{{ t.id }}</td>
            <td>{{ t.date }}</td>
            <td>{{ t.fund_code }} {{ store.fundNameMap.get(t.fund_code) }}</td>
            <td :class="typeClass(t.type)">{{ TX_TYPE_CN[t.type] }}</td>
            <td class="num">{{ fmtMoney(t.amount) }}</td>
            <td class="num">{{ t.nav || '—' }}</td>
            <td class="num">{{ t.shares ? t.shares.toFixed(2) : '—' }}</td>
            <td class="num">{{ t.fee || '—' }}</td>
            <td class="wrap">{{ t.note }}</td>
            <td>
              <span v-if="t.auto_reinvest" class="bz-hint">自动</span>
              <button v-else class="danger" style="padding: 0 6px" @click="store.removeTx(t.id).catch((e) => alert(e.message))">删</button>
            </td>
          </tr>
        </table>
      </div>

      <h2 class="bz-section">记账本中的基金</h2>
      <table class="bz">
        <tr>
          <th>代码</th>
          <th>名称</th>
          <th>类型</th>
          <th>备注</th>
          <th></th>
        </tr>
        <tr v-for="f in store.funds" :key="f.code">
          <td>{{ f.code }}</td>
          <td>{{ f.name }}</td>
          <td>{{ f.type }}</td>
          <td>{{ f.note }}</td>
          <td>
            <button class="danger" style="padding: 0 6px" @click="store.removeFund(f.code).catch((e) => alert(e.message))">删</button>
          </td>
        </tr>
      </table>
    </div>
  </div>
</template>
