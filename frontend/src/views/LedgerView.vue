<script setup>
// 记账本：添加基金（输代码自动查名）→ 录交易（自动回查净值）→ 流水管理 → CSV 导入导出
import { onMounted, ref, computed } from 'vue'
import { useLedgerStore } from '../stores/ledgerStore.js'
import { api } from '../api.js'
import { fmtMoney, fmtPct, toPctInput, fromPctInput, TX_TYPE_CN } from '../fmt.js'

const store = useLedgerStore()
onMounted(() => store.loadAll())

// ── 添加基金 ──
const newCode = ref('')
const newName = ref('')
const addFundMsg = ref('')
const adding = ref(false)
const CODE_RE = /^(?:\d{6}|[A-Za-z]{1,8})$/
const feeProfile = ref({ management: 0, custody: 0, subscription: 0, under7: 0, under365: 0, under730: 0, over730: 0 })
async function addFund() {
  addFundMsg.value = ''
  if (!CODE_RE.test(newCode.value)) {
    addFundMsg.value = '请输入 6 位基金代码或美股 ticker（如 QQQ）'
    return
  }
  adding.value = true
  try {
    const result = await store.addFund({
      code: newCode.value,
      name: newName.value || undefined,
      management_fee: feeProfile.value.management,
      custody_fee: feeProfile.value.custody,
      subscription_fee: feeProfile.value.subscription,
      redemption_fee_tiers: [
        { max_days: 7, rate: feeProfile.value.under7 },
        { max_days: 365, rate: feeProfile.value.under365 },
        { max_days: 730, rate: feeProfile.value.under730 },
        { max_days: null, rate: feeProfile.value.over730 }
      ]
    })
    addFundMsg.value = result.updated ? 'updated' : 'ok'
    newCode.value = ''
    newName.value = ''
    feeProfile.value = { management: 0, custody: 0, subscription: 0, under7: 0, under365: 0, under730: 0, over730: 0 }
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
const tx = ref({ fund_code: '', date: today(), type: 'buy', amount: null, nav: '', shares: '', fee: '', fx_rate: '', premium_rate: '', note: '' })
const txMsg = ref('')
const navHint = ref(null) // {nav, date, source}
const looking = ref(false)
const quoteTime = ref('')
const fxMessage = ref('')
const selectedFund = computed(() => store.funds.find((f) => f.code === tx.value.fund_code))

function formatQuoteTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n) => String(n).padStart(2, '0')
  return `查询：${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 输入代码+日期后自动回查该日净值
async function lookupNav() {
  navHint.value = null
  quoteTime.value = ''
  fxMessage.value = ''
  if (selectedFund.value?.market === 'US_ETF') {
    tx.value.nav = ''
    tx.value.fx_rate = ''
  }
  if (!CODE_RE.test(tx.value.fund_code) || !tx.value.date) return
  looking.value = true
  try {
    if (selectedFund.value && selectedFund.value.market === 'US_ETF') {
      const quote = await api(`/market/fund/${tx.value.fund_code}?date=${encodeURIComponent(tx.value.date)}`)
      if (!quote.quote_price) {
        fxMessage.value = '请手动输入'
        return
      }
      tx.value.nav = quote.quote_price
      tx.value.fx_rate = quote.fx_rate || ''
      if (!quote.fx_rate) fxMessage.value = '实时汇率不可用，请手动输入'
      quoteTime.value = formatQuoteTime(quote.valuation_date)
      navHint.value = null
      return
    }
    if (selectedFund.value && selectedFund.value.market === 'CN_ETF') {
      const quote = await api(`/market/fund/${tx.value.fund_code}?date=${encodeURIComponent(tx.value.date)}`)
      if (!quote.quote_price && !quote.valuation_nav) {
        fxMessage.value = '请手动输入'
        return
      }
      tx.value.nav = quote.quote_price || quote.valuation_nav
      navHint.value = {
        nav: tx.value.nav,
        source: quote.premium_rate == null ? '场内价格（暂无可用 NAV）' : `场内价格，溢价率 ${(quote.premium_rate * 100).toFixed(2)}%`
      }
      return
    }
    const navs = await api(`/market/fund/${tx.value.fund_code}/navs?limit=30`)
    const hit = navs.find((n) => n.date <= tx.value.date)
    if (hit) {
      navHint.value = { nav: hit.nav, date: hit.date, source: hit.date === tx.value.date ? '当日净值' : `最近此前净值(${hit.date})` }
      tx.value.nav = hit.nav
    } else {
      navHint.value = { nav: null, source: '未查到该日期之前的净值，请手填' }
    }
  } catch {
    if (selectedFund.value?.currency === 'USD') {
      tx.value.fx_rate = ''
      fxMessage.value = '请手动输入'
      navHint.value = null
      return
    }
    quoteTime.value = ''
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
      price: Number(tx.value.nav) || 0,
      currency: selectedFund.value?.currency || 'CNY',
      fx_rate: selectedFund.value?.currency === 'USD' ? Number(tx.value.fx_rate) || 0 : 1,
      premium_rate: tx.value.type === 'buy' && tx.value.premium_rate !== '' ? Number(tx.value.premium_rate) : null,
      note: tx.value.note
    })
    txMsg.value = 'ok'
    tx.value.amount = null
    tx.value.shares = ''
    tx.value.fee = ''
    tx.value.premium_rate = ''
    fxMessage.value = ''
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
          <input type="text" v-model="newCode" maxlength="8" placeholder="如 050025 或 QQQ" @keyup.enter="addFund" />
        </div>
        <div class="bz-form-row">
          <label>名称（可留空自动查询）</label>
          <input type="text" v-model="newName" class="wide" />
        </div>
        <details class="adv">
          <summary>费率档案（可选，按百分比填写）</summary>
          <div class="bz-form-row">
            <label>管理费 %</label>
            <input type="text" :value="toPctInput(feeProfile.management)" @change="feeProfile.management = fromPctInput($event.target.value)" />
          </div>
          <div class="bz-form-row">
            <label>托管费 %</label>
            <input type="text" :value="toPctInput(feeProfile.custody)" @change="feeProfile.custody = fromPctInput($event.target.value)" />
          </div>
          <div class="bz-form-row">
            <label>申购费/佣金 %</label>
            <input type="text" :value="toPctInput(feeProfile.subscription)" @change="feeProfile.subscription = fromPctInput($event.target.value)" />
          </div>
          <div class="bz-form-row">
            <label>赎回费 &lt;7天 %</label>
            <input type="text" :value="toPctInput(feeProfile.under7)" @change="feeProfile.under7 = fromPctInput($event.target.value)" />
          </div>
          <div class="bz-form-row">
            <label>赎回费 7天~1年 %</label>
            <input type="text" :value="toPctInput(feeProfile.under365)" @change="feeProfile.under365 = fromPctInput($event.target.value)" />
          </div>
          <div class="bz-form-row">
            <label>赎回费 1~2年 %</label>
            <input type="text" :value="toPctInput(feeProfile.under730)" @change="feeProfile.under730 = fromPctInput($event.target.value)" />
          </div>
          <div class="bz-form-row">
            <label>赎回费 ≥2年 %</label>
            <input type="text" :value="toPctInput(feeProfile.over730)" @change="feeProfile.over730 = fromPctInput($event.target.value)" />
          </div>
        </details>
        <p>
          <button :disabled="adding" @click="addFund">查询并添加</button>
          <span v-if="adding" class="bz-hint"> 查询中…</span>
        </p>
        <div v-if="addFundMsg && addFundMsg !== 'ok'" class="bz-error">{{ addFundMsg }}</div>
        <div v-else-if="addFundMsg === 'ok'" class="bz-ok">已添加</div>
        <div v-else-if="addFundMsg === 'updated'" class="bz-ok">已更新已有基金及费率</div>
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
          <label>{{ tx.type === 'sell' ? '卖出总额' : tx.type === 'dividend_cash' ? '分红到账' : tx.type === 'fee' ? '费用金额' : '实际扣款' }}（{{ selectedFund?.currency || 'CNY' }}）</label>
          <input type="number" v-model.number="tx.amount" min="0" />
          <span v-if="tx.type === 'buy' || tx.type === 'dividend_reinvest'" class="bz-hint">含手续费</span>
        </div>
        <div class="bz-form-row">
          <label>{{ selectedFund?.market === 'US_ETF' ? '成交价格（USD/股）' : selectedFund?.market === 'CN_ETF' ? '成交价格（元/份）' : '成交净值' }}</label>
          <input type="number" v-model.number="tx.nav" step="0.0001" min="0" @change="lookupNav" />
          <button style="padding: 1px 6px" :disabled="looking" @click="lookupNav">回查</button>
        </div>
        <div v-if="selectedFund?.currency === 'USD'" class="bz-form-row">
          <label>成交汇率（CNY/USD）</label>
          <input type="number" v-model.number="tx.fx_rate" min="0.1" step="0.0001" />
          <span v-if="quoteTime" class="bz-hint">{{ quoteTime }}</span>
          <span v-if="fxMessage" class="bz-hint">{{ fxMessage }}</span>
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
        <div v-if="tx.type === 'buy'" class="bz-form-row">
          <label>买入时溢价率 %</label>
          <input type="text" placeholder="查不到可留空" :value="tx.premium_rate === '' ? '' : toPctInput(tx.premium_rate)"
            @change="tx.premium_rate = $event.target.value.trim() === '' ? '' : fromPctInput($event.target.value)" />
          <span class="bz-hint">只记录买入时刻</span>
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
