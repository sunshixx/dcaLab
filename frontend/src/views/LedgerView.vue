<script setup>
// 记账本：添加基金（输代码自动查名）→ 录交易（自动回查净值）→ 流水管理 → CSV 导入导出
import { onMounted, ref, computed, watch } from 'vue'
import { useLedgerStore } from '../stores/ledgerStore.js'
import { api } from '../api.js'
import { fmtMoney, fmtPct, toPctInput, fromPctInput, TX_TYPE_CN, ASSET_TYPE_CN } from '../fmt.js'

const store = useLedgerStore()
onMounted(() => store.loadAll())

// 切换基金筛选时回到第 1 页，避免停在越界页码上
watch(() => store.filterFund, () => { store.page = 1 })

// 分页页码按钮（最多显示 7 个，超出用省略号）
const pageNumbers = computed(() => {
  const total = store.totalPages
  const cur = store.currentPage
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages = new Set([1, total, cur, cur - 1, cur + 1, cur - 2, cur + 2])
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b)
  const out = []
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push('...')
    out.push(sorted[i])
  }
  return out
})

// ── 添加基金 ──
const newCode = ref('')
const newName = ref('')
const newAssetType = ref('fund')
const addFundMsg = ref('')
const adding = ref(false)
const CODE_RE = /^[A-Za-z0-9_-]{1,20}$/
const feeProfile = ref({ management: 0, custody: 0, subscription: 0, under7: 0, under365: 0, under730: 0, over730: 0 })
async function addFund() {
  addFundMsg.value = ''
  if (newAssetType.value === 'fund' && !CODE_RE.test(newCode.value)) {
    addFundMsg.value = '请输入 1~20 位字母、数字、下划线或短横线代码'
    return
  }
  if (newAssetType.value !== 'fund' && !newName.value.trim()) {
    addFundMsg.value = '非基金标的请填写名称'
    return
  }
  adding.value = true
  try {
    const result = await store.addFund({
      ...(newAssetType.value === 'fund' ? { code: newCode.value } : {}),
      name: newName.value || undefined,
      asset_type: newAssetType.value,
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
    newAssetType.value = 'fund'
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
const tx = ref({ fund_code: '', date: today(), type: 'buy', amount: null, nav: '', shares: '', fee: '', fx_rate: '', premium_rate: '', nominal_days: 1, annual_rate: '', commission_rate: 0.001, face_value: '', last_interest_date: '', maturity_date: '', note: '' })
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

const isManualAsset = computed(() => selectedFund.value && selectedFund.value.asset_type !== 'fund')
const isCashFlow = computed(() => selectedFund.value?.asset_type === 'cash_flow')
const isProvidentFund = computed(() => selectedFund.value?.asset_type === 'provident_fund')
const isTreasuryBond = computed(() => selectedFund.value?.asset_type === 'treasury_bond')
const isReverseRepo = computed(() => selectedFund.value?.asset_type === 'reverse_repo')
const isSimpleBalance = computed(() => isCashFlow.value || isProvidentFund.value)
const assetTypeName = (type) => ASSET_TYPE_CN[type] || type || '基金'
const repoTerms = [1, 2, 3, 4, 7, 14, 28, 91, 182]
const repoHolidays2026 = new Set(['2026-01-01', '2026-01-02', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-04-04', '2026-04-05', '2026-04-06', '2026-05-01', '2026-05-02', '2026-05-03', '2026-06-19', '2026-06-20', '2026-06-21', '2026-09-25', '2026-09-26', '2026-09-27', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'])
function nextRepoBusinessDay(date) {
  const value = new Date(`${date}T00:00:00Z`)
  while (value.getUTCDay() === 0 || value.getUTCDay() === 6 || repoHolidays2026.has(value.toISOString().slice(0, 10))) value.setUTCDate(value.getUTCDate() + 1)
  return value
}
const reverseRepoPreview = computed(() => {
  if (!isReverseRepo.value || tx.value.type !== 'buy' || !tx.value.date || !tx.value.amount || !tx.value.annual_rate) return null
  const first = new Date(`${tx.value.date}T00:00:00Z`)
  first.setUTCDate(first.getUTCDate() + 1)
  const firstSettlement = nextRepoBusinessDay(first.toISOString().slice(0, 10))
  const expiryBase = new Date(firstSettlement)
  expiryBase.setUTCDate(expiryBase.getUTCDate() + Number(tx.value.nominal_days))
  const expiry = nextRepoBusinessDay(expiryBase.toISOString().slice(0, 10))
  const interestDays = Math.round((expiry - firstSettlement) / 86400000)
  const occupiedDays = Math.round((expiry - new Date(`${tx.value.date}T00:00:00Z`)) / 86400000)
  const interest = Number(tx.value.amount) * (Number(tx.value.annual_rate) / 100) * interestDays / 365
  const commission = Number(tx.value.amount) * (Number(tx.value.commission_rate || 0) / 100)
  return { firstSettlement: firstSettlement.toISOString().slice(0, 10), expiry: expiry.toISOString().slice(0, 10), interestDays, occupiedDays, interest, tax: interest * 0.2, net: interest - commission - interest * 0.2 }
})

const txTypeOptions = computed(() => {
  if (isCashFlow.value) return [{ value: 'buy', label: '流入' }, { value: 'sell', label: '流出' }]
  if (isProvidentFund.value) return [{ value: 'buy', label: '缴存' }, { value: 'sell', label: '提取' }]
  if (selectedFund.value?.asset_type === 'treasury_bond') {
    return [
      { value: 'buy', label: '买入国债' },
      { value: 'sell', label: '卖出国债' },
      { value: 'dividend_cash', label: '利息到账' },
      { value: 'fee', label: '手续费' }
    ]
  }
  if (selectedFund.value?.asset_type === 'reverse_repo') {
    return [{ value: 'buy', label: '出借本金' }, { value: 'sell', label: '到期收回' }, { value: 'fee', label: '手续费' }]
  }
  return [
    { value: 'buy', label: '买入（申购）' },
    { value: 'sell', label: '卖出（赎回）' },
    { value: 'dividend_cash', label: '现金分红' },
    { value: 'dividend_reinvest', label: '分红再投资' },
    { value: 'fee', label: '费用调整' }
  ]
})

const amountLabel = computed(() => {
  if (isCashFlow.value) return tx.value.type === 'sell' ? '流出金额' : '流入金额'
  if (isProvidentFund.value) return tx.value.type === 'sell' ? '提取金额' : '缴存金额'
  if (selectedFund.value?.asset_type === 'reverse_repo') return tx.value.type === 'sell' ? '到期收回金额' : '出借本金'
  if (selectedFund.value?.asset_type === 'treasury_bond') return tx.value.type === 'sell' ? '卖出总额' : '买入金额'
  return tx.value.type === 'sell' ? '卖出总额' : tx.value.type === 'dividend_cash' ? '分红到账' : tx.value.type === 'fee' ? '费用金额' : '实际扣款'
})

function onFundChange() {
  tx.value.type = 'buy'
  tx.value.nav = isSimpleBalance.value || isReverseRepo.value ? 1 : ''
  tx.value.shares = ''
  lookupNav()
}

// 输入代码+日期后自动回查该日净值
async function lookupNav() {
  navHint.value = null
  quoteTime.value = ''
  fxMessage.value = ''
  if (isManualAsset.value) {
    if (selectedFund.value.asset_type === 'provident_fund') tx.value.nav = 1
    navHint.value = { nav: tx.value.nav || 1, source: '手工估值，不查询行情' }
    return
  }
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
      nav: isSimpleBalance.value ? 1 : Number(tx.value.nav) || 0,
      shares: isSimpleBalance.value ? Number(tx.value.amount) || 0 : Number(tx.value.shares) || 0,
      fee: Number(tx.value.fee) || 0,
      price: Number(tx.value.nav) || 0,
      currency: selectedFund.value?.currency || 'CNY',
      fx_rate: selectedFund.value?.currency === 'USD' ? Number(tx.value.fx_rate) || 0 : 1,
      premium_rate: tx.value.type === 'buy' && tx.value.premium_rate !== '' ? Number(tx.value.premium_rate) : null,
      nominal_days: isReverseRepo.value ? Number(tx.value.nominal_days) : null,
      annual_rate: isReverseRepo.value ? Number(tx.value.annual_rate) / 100 : isTreasuryBond.value ? Number(tx.value.annual_rate || 0) / 100 : null,
      commission_rate: isReverseRepo.value ? Number(tx.value.commission_rate || 0) / 100 : null,
      face_value: isTreasuryBond.value ? Number(tx.value.face_value) || 0 : null,
      last_interest_date: isTreasuryBond.value ? tx.value.last_interest_date || null : null,
      maturity_date: isTreasuryBond.value ? tx.value.maturity_date || null : null,
      note: tx.value.note
    })
    txMsg.value = 'ok'
    tx.value.amount = null
    tx.value.shares = ''
    tx.value.fee = ''
    tx.value.premium_rate = ''
    tx.value.annual_rate = ''
    tx.value.commission_rate = 0.001
    tx.value.face_value = ''
    tx.value.last_interest_date = ''
    tx.value.maturity_date = ''
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
        <legend>① 添加资产到记账本</legend>
        <div class="bz-form-row">
          <label v-if="newAssetType === 'fund'">基金代码</label>
          <input v-if="newAssetType === 'fund'" type="text" v-model="newCode" maxlength="20" placeholder="如 050025 或 QQQ" @keyup.enter="addFund" />
        </div>
        <div class="bz-form-row">
          <label>标的类型</label>
          <select v-model="newAssetType">
            <option v-for="(label, value) in ASSET_TYPE_CN" :key="value" :value="value">{{ label }}</option>
          </select>
        </div>
        <div class="bz-form-row">
          <label>{{ newAssetType === 'fund' ? '名称（可留空自动查询）' : '名称' }}</label>
          <input type="text" v-model="newName" class="wide" :placeholder="newAssetType === 'fund' ? '' : '如：我的公积金、204007 逆回购'" />
        </div>
        <details v-if="newAssetType === 'fund'" class="adv">
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
          <button :disabled="adding" @click="addFund">{{ newAssetType === 'fund' ? '查询并添加' : '添加资产' }}</button>
          <span v-if="adding" class="bz-hint"> 查询中…</span>
        </p>
        <div v-if="addFundMsg && addFundMsg !== 'ok'" class="bz-error">{{ addFundMsg }}</div>
        <div v-else-if="addFundMsg === 'ok'" class="bz-ok">已添加</div>
        <div v-else-if="addFundMsg === 'updated'" class="bz-ok">已更新已有基金及费率</div>
      </fieldset>

      <fieldset>
        <legend>② 录入交易</legend>
        <div class="bz-form-row">
          <label>标的</label>
          <select v-model="tx.fund_code" @change="onFundChange">
            <option value="" disabled>选择标的</option>
            <option v-for="f in store.funds" :key="f.code" :value="f.code">{{ f.asset_type === 'fund' ? `${f.code} ` : '' }}{{ f.name }}</option>
          </select>
        </div>
        <div class="bz-form-row">
          <label>类型</label>
          <select v-model="tx.type">
            <option v-for="option in txTypeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </div>
        <div class="bz-form-row">
          <label>日期</label>
          <input type="date" v-model="tx.date" @change="lookupNav" />
        </div>
        <template v-if="isReverseRepo">
          <div class="bz-form-row">
            <label>名义期限</label>
            <select v-model.number="tx.nominal_days">
              <option v-for="days in repoTerms" :key="days" :value="days">{{ days }} 天期</option>
            </select>
          </div>
          <div class="bz-form-row">
            <label>成交年化利率 %</label>
            <input type="number" v-model.number="tx.annual_rate" min="0" max="100" step="0.001" />
          </div>
          <div class="bz-form-row">
            <label>佣金费率 %</label>
            <input type="number" v-model.number="tx.commission_rate" min="0" max="10" step="0.001" />
            <span class="bz-hint">税率固定 20%</span>
          </div>
        </template>
        <template v-if="isTreasuryBond && (tx.type === 'buy' || tx.type === 'sell')">
          <div class="bz-form-row">
            <label>面值 / 本金（元）</label>
            <input type="number" v-model.number="tx.face_value" min="0" step="0.01" />
          </div>
          <div class="bz-form-row">
            <label>票面年利率 %</label>
            <input type="number" v-model.number="tx.annual_rate" min="0" max="100" step="0.001" />
          </div>
          <div class="bz-form-row">
            <label>上次付息日</label>
            <input type="date" v-model="tx.last_interest_date" />
          </div>
          <div class="bz-form-row">
            <label>到期日</label>
            <input type="date" v-model="tx.maturity_date" />
          </div>
        </template>
        <div class="bz-form-row">
          <label>{{ amountLabel }}（{{ selectedFund?.currency || 'CNY' }}）</label>
          <input type="number" v-model.number="tx.amount" min="0" />
          <span v-if="tx.type === 'buy' || tx.type === 'dividend_reinvest'" class="bz-hint">含手续费</span>
        </div>
        <div v-if="!isSimpleBalance && !isReverseRepo" class="bz-form-row">
          <label>{{ isTreasuryBond ? '成交价格（元/100元面值）' : selectedFund?.asset_type ? '成交价格（元/份）' : selectedFund?.market === 'US_ETF' ? '成交价格（USD/股）' : selectedFund?.market === 'CN_ETF' ? '成交价格（元/份）' : '成交净值' }}</label>
          <input type="number" v-model.number="tx.nav" step="0.0001" min="0" @change="lookupNav" />
          <button v-if="!isManualAsset" style="padding: 1px 6px" :disabled="looking" @click="lookupNav">回查</button>
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
        <div v-if="!isSimpleBalance" class="bz-form-row">
          <label>{{ isTreasuryBond ? '面值份额' : isReverseRepo ? '出借本金份额' : '份额（可留空自动算）' }}</label>
          <input type="number" v-model.number="tx.shares" min="0" />
        </div>
        <div v-if="!isSimpleBalance && !isReverseRepo && !isTreasuryBond" class="bz-form-row">
          <label>手续费（元）</label>
          <input type="number" v-model.number="tx.fee" min="0" step="0.01" />
          <span v-if="tx.type === 'buy' || tx.type === 'dividend_reinvest'" class="bz-hint">从实际扣款中扣除</span>
        </div>
        <div v-if="reverseRepoPreview" class="bz-note">
          首次结算 {{ reverseRepoPreview.firstSettlement }}，到期结算 {{ reverseRepoPreview.expiry }}；
          利息计息 {{ reverseRepoPreview.interestDays }} 天，资金占用 {{ reverseRepoPreview.occupiedDays }} 天；
          预估利息 {{ fmtMoney(reverseRepoPreview.interest) }} 元，税 {{ fmtMoney(reverseRepoPreview.tax) }} 元，
          税后佣金后净收益 {{ fmtMoney(reverseRepoPreview.net) }} 元
        </div>
        <div v-if="tx.type === 'buy' && !isManualAsset" class="bz-form-row">
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
          列顺序：基金代码,基金名称,日期,类型(买入/卖出/现金分红/分红再投/费用调整),金额,净值,成交价,份额,手续费,币种,汇率,买入溢价率,备注（兼容旧的 9 列格式）
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
          <tr v-for="t in store.pagedTxs" :key="t.id">
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

      <!-- 分页控件 -->
      <div class="bz-pager">
        <span class="bz-hint">
          共 {{ store.filteredTxs.length }} 条{{ store.filterFund ? '（已按标的筛选）' : '' }} · 第 {{ store.currentPage }} / {{ store.totalPages }} 页
        </span>
        <span style="margin-left: auto; display: flex; align-items: center; gap: 4px; flex-wrap: wrap">
          <button :disabled="store.currentPage <= 1" @click="store.setPage(1)">« 首页</button>
          <button :disabled="store.currentPage <= 1" @click="store.setPage(store.currentPage - 1)">‹ 上页</button>
          <template v-for="(p, i) in pageNumbers" :key="i">
            <span v-if="p === '...'" class="bz-hint" style="padding: 0 2px">…</span>
            <button v-else :class="{ active: p === store.currentPage }" @click="store.setPage(p)">{{ p }}</button>
          </template>
          <button :disabled="store.currentPage >= store.totalPages" @click="store.setPage(store.currentPage + 1)">下页 ›</button>
          <button :disabled="store.currentPage >= store.totalPages" @click="store.setPage(store.totalPages)">末页 »</button>
          <select :value="store.pageSize" @change="store.setPageSize($event.target.value)" style="font-size: 12px">
            <option :value="20">20 条/页</option>
            <option :value="50">50 条/页</option>
            <option :value="100">100 条/页</option>
            <option :value="200">200 条/页</option>
          </select>
        </span>
      </div>

      <h2 class="bz-section">记账本中的标的</h2>
      <table class="bz">
        <tr>
          <th>代码</th>
          <th>名称</th>
          <th>资产类型</th>
          <th>备注</th>
          <th></th>
        </tr>
        <tr v-for="f in store.funds" :key="f.code">
          <td>{{ f.code }}</td>
          <td>{{ f.name }}</td>
          <td>{{ assetTypeName(f.asset_type) }}</td>
          <td>{{ f.note }}</td>
          <td>
            <button class="danger" style="padding: 0 6px" @click="store.removeFund(f.code).catch((e) => alert(e.message))">删</button>
          </td>
        </tr>
      </table>
    </div>
  </div>
</template>
