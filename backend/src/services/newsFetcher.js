import { XMLParser } from 'fast-xml-parser'
import './network.js'

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
const NEWS_TIMEOUT_MS = 15000

const FEEDS = {
  cn: {
    timezone: 'Asia/Shanghai',
    market: ['https://www.chinanews.com.cn/rss/finance.xml'],
    global: ['https://www.cnbc.com/id/100003114/device/rss/rss.html'],
  },
  us: {
    timezone: 'America/New_York',
    market: ['https://www.cnbc.com/id/10000664/device/rss/rss.html'],
    global: ['https://www.cnbc.com/id/100003114/device/rss/rss.html'],
  },
}

function asList(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function text(value) {
  if (value == null) return ''
  if (typeof value === 'object') return String(value['#text'] || '')
  return String(value)
}

function stripHtml(value) {
  return text(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function reportDay(value, timezone) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(parsed)
}

async function readFeed(url, date, timezone) {
  const response = await fetch(url, { signal: AbortSignal.timeout(NEWS_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`RSS HTTP ${response.status}`)
  const parsed = parser.parse(await response.text())
  const items = asList(parsed?.rss?.channel?.item)
  return items
    .map(item => ({
      title: stripHtml(item.title),
      description: stripHtml(item.description),
      source: text(item.source) || 'Google News',
      source_time: text(item.pubDate),
      url: text(item.link),
    }))
    .filter(item => item.title && item.url && reportDay(item.source_time, timezone) === date)
}

async function readFeeds(urls, date, timezone) {
  const results = await Promise.allSettled(urls.map(url => readFeed(url, date, timezone)))
  const items = results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
  const errors = results
    .filter(result => result.status === 'rejected')
    .map(result => result.reason?.message || '未知错误')
  return { items, errors }
}

function unique(items, limit) {
  const seen = new Set()
  return items.filter(item => {
    const key = item.title.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, limit)
}

function marketItem(item) {
  const fact = item.description || item.title
  return {
    title: item.title,
    source_time: `${item.source}：${item.source_time}`,
    fact: `[事实] ${fact}`,
    inference: '[推断] 市场影响需结合相关资产的实际价格反应判断，暂不将新闻直接视为因果证明。',
    url: item.url,
  }
}

function globalItem(item) {
  return {
    title: item.title,
    region: '国际市场',
    source_time: `${item.source}：${item.source_time}`,
    summary: item.description || item.title,
    importance: '需结合后续官方信息和市场反应持续核验。',
    impact: '可能影响风险偏好、利率预期或大宗商品价格；方向不作确定判断。',
    impact_score: 3,
    impact_type: '宏观/国际市场',
    url: item.url,
  }
}

export async function fetchNews(date, market = 'cn') {
  const config = FEEDS[market] || FEEDS.cn
  const warnings = []
  const [marketResult, globalResult] = await Promise.all([
    readFeeds(config.market, date, config.timezone),
    readFeeds(config.global, date, config.timezone),
  ])

  const marketItems = unique(marketResult.items, 8)
  const globalItems = unique(globalResult.items, 10)
  if (marketResult.errors.length) warnings.push(`市场新闻 RSS 抓取失败：${marketResult.errors.join('；')}`)
  if (globalResult.errors.length) warnings.push(`国际新闻 RSS 抓取失败：${globalResult.errors.join('；')}`)
  if (!marketItems.length) warnings.push('市场新闻：指定日期没有取得可核验 RSS 条目。')
  if (!globalItems.length) warnings.push('国际新闻：指定日期没有取得可核验 RSS 条目。')

  return {
    market_news: marketItems.map(marketItem),
    global_news: globalItems.map(globalItem),
    voices: [],
    warnings,
  }
}

export async function attachNews(payload, date, market = 'cn') {
  const result = await fetchNews(date, market)
  payload.market_news = result.market_news
  payload.global_news = result.global_news
  payload.voices = result.voices
  payload.data_gaps = [...(payload.data_gaps || []), ...result.warnings]
  return payload
}
