// 黄金行情解析：新浪 hq.sinajs.cn 的上金所快照（GBK 文本，字段位置固定）
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseGoldQuote, GOLD_CODES } from '../src/services/marketData.js'

// 2026-10-29 00:00 的实测返回（Au99.99）
const AU9999_LINE =
  'var hq_str_gds_AU9999="870.00,0,868.50,870.00,871.90,868.00,00:00:28,868.99,869.30,3546,1.00,114.00,2026-10-29,沪金99";'
const AUTD_LINE =
  'var hq_str_gds_AUTD="867.00,0,866.24,867.28,871.98,866.84,00:10:09,866.91,868.00,2086,1.00,1.00,2026-10-29,黄金延期";'

test('Au99.99：价格/昨收/开高低与时间字段解析正确', () => {
  const q = parseGoldQuote(AU9999_LINE)
  assert.equal(q.code, 'AU9999')
  assert.equal(q.instrument, '上金所 Au99.99')
  assert.equal(q.unit, '元/克')
  assert.equal(q.price, 870)
  assert.equal(q.prev_close, 868.99)
  assert.equal(q.open, 869.3)
  assert.equal(q.high, 871.9)
  assert.equal(q.low, 868)
  assert.equal(q.change, 1.01)
  assert.equal(q.change_pct, 0.001162)
  assert.equal(q.quote_date, '2026-10-29')
  assert.equal(q.as_of, '2026-10-29 00:00:28')
})

test('Au(T+D)：用同一个解析器也能取到', () => {
  const q = parseGoldQuote(AUTD_LINE, 'AUTD')
  assert.equal(q.code, 'AUTD')
  assert.equal(q.price, 867)
  assert.equal(q.prev_close, 866.91)
  assert.equal(q.change, 0.09)
})

test('无报价时不能返回 0 价：空引号→无有效价格，格式错乱→格式异常', () => {
  assert.throws(() => parseGoldQuote('var hq_str_gds_AU9999="";'), /暂无有效价格/)
  assert.throws(() => parseGoldQuote(''), /格式异常/)
  assert.throws(() => parseGoldQuote('<html>502 Bad Gateway</html>'), /格式异常/)
})

test('价格为 0 视为无有效行情，避免把持仓估成 0', () => {
  assert.throws(() => parseGoldQuote('var hq_str_gds_AU9999="0,0,0,0,0,0,00:00:00,0,0,0";'), /暂无有效价格/)
})

test('未知品种直接拒绝', () => {
  assert.throws(() => parseGoldQuote(AU9999_LINE, 'AU8888'), /不支持的黄金品种/)
  assert.deepEqual(GOLD_CODES, ['AU9999', 'AUTD'])
})
