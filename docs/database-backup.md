# 数据库备份

> 由 `backend/scripts/export-db-markdown.mjs` 自动生成于 2026/9/15 19:07:46（Asia/Shanghai）
> 来源：`backend/data/app.db`

> **本文件包含真实个人记账数据（持仓、交易金额与日期）。**

## 概览

| 表名 | 列数 | 行数 |
|---|---:|---:|
| `funds` | 12 | 11 |
| `plans` | 4 | 0 |
| `reports` | 10 | 5 |
| `schema_migrations` | 2 | 8 |
| `transactions` | 27 | 9 |

## 迁移历史

| 版本 | 应用时间 |
|---|---|
| 001 | 2026-09-14 17:24:24 |
| 002 | 2026-09-14 17:24:24 |
| 003 | 2026-09-14 17:27:13 |
| 004 | 2026-09-14 18:55:58 |
| 005 | 2026-09-14 19:00:17 |
| 006 | 2026-09-14 19:07:24 |
| 007 | 2026-09-15 16:12:22 |
| 008 | 2026-09-15 16:40:46 |

## 表结构

### `funds`

| 列名 | 类型 | 非空 | 默认值 | 主键 |
|---|---|:--:|---|---|
| `code` | TEXT |  | — | ✓ |
| `name` | TEXT | ✓ | — |  |
| `type` | TEXT |  | '' |  |
| `note` | TEXT |  | '' |  |
| `created_at` | TEXT | ✓ | datetime('now', 'localtime') |  |
| `market` | TEXT | ✓ | 'CN_FUND' |  |
| `currency` | TEXT | ✓ | 'CNY' |  |
| `management_fee` | REAL | ✓ | 0 |  |
| `custody_fee` | REAL | ✓ | 0 |  |
| `subscription_fee` | REAL | ✓ | 0 |  |
| `redemption_fee_tiers` | TEXT | ✓ | '[]' |  |
| `asset_type` | TEXT | ✓ | 'fund' |  |

索引：

- `idx_funds_asset_type`

### `plans`

| 列名 | 类型 | 非空 | 默认值 | 主键 |
|---|---|:--:|---|---|
| `id` | INTEGER |  | — | ✓ |
| `name` | TEXT | ✓ | — |  |
| `created_at` | TEXT | ✓ | datetime('now', 'localtime') |  |
| `params` | TEXT | ✓ | — |  |

### `reports`

| 列名 | 类型 | 非空 | 默认值 | 主键 |
|---|---|:--:|---|---|
| `id` | INTEGER |  | — | ✓ |
| `market` | TEXT | ✓ | — |  |
| `report_date` | TEXT | ✓ | — |  |
| `generated_at` | TEXT |  | — |  |
| `expires_at` | TEXT |  | — |  |
| `audit_json` | TEXT | ✓ | — |  |
| `payload_json` | TEXT |  | — |  |
| `html_path` | TEXT |  | — |  |
| `updated_at` | TEXT | ✓ | datetime('now', 'localtime') |  |
| `html_content` | TEXT |  | — |  |

索引：

- `idx_reports_market_date`

### `schema_migrations`

| 列名 | 类型 | 非空 | 默认值 | 主键 |
|---|---|:--:|---|---|
| `version` | TEXT |  | — | ✓ |
| `applied_at` | TEXT | ✓ | datetime('now', 'localtime') |  |

### `transactions`

| 列名 | 类型 | 非空 | 默认值 | 主键 |
|---|---|:--:|---|---|
| `id` | INTEGER |  | — | ✓ |
| `fund_code` | TEXT | ✓ | — |  |
| `date` | TEXT | ✓ | — |  |
| `type` | TEXT | ✓ | — |  |
| `amount` | REAL | ✓ | 0 |  |
| `nav` | REAL | ✓ | 0 |  |
| `shares` | REAL | ✓ | 0 |  |
| `fee` | REAL | ✓ | 0 |  |
| `note` | TEXT |  | '' |  |
| `created_at` | TEXT | ✓ | datetime('now', 'localtime') |  |
| `price` | REAL | ✓ | 0 |  |
| `currency` | TEXT | ✓ | 'CNY' |  |
| `fx_rate` | REAL | ✓ | 1 |  |
| `premium_rate` | REAL |  | — |  |
| `nominal_days` | INTEGER |  | — |  |
| `annual_rate` | REAL |  | — |  |
| `commission_rate` | REAL |  | — |  |
| `tax_rate` | REAL |  | — |  |
| `face_value` | REAL |  | — |  |
| `last_interest_date` | TEXT |  | — |  |
| `maturity_date` | TEXT |  | — |  |
| `first_settlement_date` | TEXT |  | — |  |
| `expiry_date` | TEXT |  | — |  |
| `interest_days` | INTEGER |  | — |  |
| `occupied_days` | INTEGER |  | — |  |
| `expected_interest` | REAL |  | — |  |
| `expected_net_income` | REAL |  | — |  |

索引：

- `idx_tx_fund_date`

外键：

- `fund_code` → `funds.code`（ON DELETE CASCADE）

## 数据

### `funds`（11 行）

| code | name | type | note | created_at | market | currency | management_fee | custody_fee | subscription_fee | redemption_fee_tiers | asset_type |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 007721 | 天弘标普500发起(QDII-FOF)A | QDII-FOF |  | 2026-09-14 13:38:28 | CN_FUND | CNY | 0.006 | 0.002 | 0 | [{"max_days":7,"rate":0.015},{"max_days":365,"rate":0.005},{"max_days":730,"rate":0},{"max_days":null,"rate":0}] | fund |
| 160213 | 国泰纳斯达克100指数 | 指数型-海外股票 |  | 2026-09-14 13:38:52 | CN_FUND | CNY | 0.008 | 0.002 | 0 | [{"max_days":7,"rate":0.015},{"max_days":365,"rate":0.005},{"max_days":730,"rate":0.0025},{"max_days":null,"rate":0}] | fund |
| 017641 | 摩根标普500指数(QDII)人民币A | 指数型-海外股票 |  | 2026-09-14 13:39:06 | CN_FUND | CNY | 0.005 | 0.0015 | 0 | [{"max_days":7,"rate":0.015},{"max_days":365,"rate":0.005},{"max_days":730,"rate":0.0025},{"max_days":null,"rate":0}] | fund |
| QQQ | Invesco QQQ Trust | US ETF |  | 2026-09-14 19:40:23 | US_ETF | USD | 0 | 0 | 0 | [{"max_days":7,"rate":0},{"max_days":365,"rate":0},{"max_days":730,"rate":0},{"max_days":null,"rate":0}] | fund |
| MMU2ERZ5Y | 公积金 |  |  | 2026-09-15 16:27:12 | MANUAL | CNY | 0 | 0 | 0 | [{"max_days":7,"rate":0},{"max_days":365,"rate":0},{"max_days":730,"rate":0},{"max_days":null,"rate":0}] | provident_fund |
| MMU2ES7IY | 国债 |  |  | 2026-09-15 16:27:23 | MANUAL | CNY | 0 | 0 | 0 | [{"max_days":7,"rate":0},{"max_days":365,"rate":0},{"max_days":730,"rate":0},{"max_days":null,"rate":0}] | treasury_bond |
| MMU2ESE5O | 逆回购 |  |  | 2026-09-15 16:27:31 | MANUAL | CNY | 0 | 0 | 0 | [{"max_days":7,"rate":0},{"max_days":365,"rate":0},{"max_days":730,"rate":0},{"max_days":null,"rate":0}] | reverse_repo |
| MMU2ESJ7V | 现金流 |  |  | 2026-09-15 16:27:38 | MANUAL | CNY | 0 | 0 | 0 | [{"max_days":7,"rate":0},{"max_days":365,"rate":0},{"max_days":730,"rate":0},{"max_days":null,"rate":0}] | cash_flow |
| 004400 | 金信民兴债券A | 债券型-长债 |  | 2026-09-15 17:25:33 | CN_FUND | CNY | 0.003 | 0.001 | 0 | [{"max_days":7,"rate":0.015},{"max_days":365,"rate":0.001},{"max_days":730,"rate":0.0005},{"max_days":null,"rate":0}] | fund |
| 007194 | 长城短债A | 债券型-中短债 |  | 2026-09-15 17:27:56 | CN_FUND | CNY | 0.0025 | 0.0005 | 0 | [{"max_days":7,"rate":0.015},{"max_days":365,"rate":0},{"max_days":730,"rate":0},{"max_days":null,"rate":0}] | fund |
| 006431 | 汇安鼎利纯债A | 债券型-长债 |  | 2026-09-15 17:28:42 | CN_FUND | CNY | 0.003 | 0.001 | 0 | [{"max_days":7,"rate":0.015},{"max_days":365,"rate":0},{"max_days":730,"rate":0},{"max_days":null,"rate":0}] | fund |

### `plans`（0 行）

_（无数据）_

### `reports`（5 行）

| id | market | report_date | generated_at | expires_at | audit_json | payload_json | html_path | updated_at | html_content |
|---|---|---|---|---|---|---|---|---|---|
| 1 | cn | 2026-09-11 | 2026-09-14 16:21:31 CST | 2026-09-12T01:00:00.000Z | {"market":"cn","report_date":"2026-09-11","report_type":"full_cn","generated_at":"2026-09-14 16:21:31 CST","overview_lead":"三大指数走势分化，板块轮动明显。","overview":"本报告由自动化管线生成，日线数据来自公开行情接口。叙事字段因未接入实时新闻源，以数据驱动概述… | {<br>  "market": "cn",<br>  "report_date": "2026-09-11",<br>  "report_type": "full_cn",<br>  "generated_at": "2026-09-14 16:21:31 CST",<br>  "overview_lead": "三大指数走势分化，板块轮动明显。",<br>  "overview": "本报告由… | C:\Users\DP\.zcode\workspace\default\nas\reports\cn_market_review_2026-09-11.html | 2026-09-15 19:06:13 | <!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A股每日盘后回顾 — 2026年9月11日（星期五）</title><style>:root {<br>  --ink: #17… |
| 2 | cn | 2026-09-14 | 2026-09-14 17:05:41 CST | 2026-09-15T01:00:00.000Z | {"market":"cn","report_date":"2026-09-14","report_type":"full_cn","generated_at":"2026-09-14 17:05:41 CST","overview_lead":"上证综指 -0.07%，创业板指 -1.10%，科创50 -1.62%。领涨：医药生物(+2.49%)、汽车(+1.17%)；领跌：通信(-1.53%)… | {<br>  "market": "cn",<br>  "report_date": "2026-09-14",<br>  "report_type": "full_cn",<br>  "generated_at": "2026-09-14 17:05:41 CST",<br>  "overview_lead": "上证综指 -0.07%，创业板指 -1.10%，科创50 -1.62%。领涨：医药… | C:\Users\DP\.zcode\workspace\default\nas\reports\cn_market_review_2026-09-14.html | 2026-09-15 19:06:13 | <!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A股每日盘后回顾 — 2026年9月14日（星期一）</title><style>:root {<br>  --ink: #17… |
| 3 | us | 2026-09-11 | 2026-09-14 08:22:01 CST | 2026-09-12T13:30:00.000Z | {"market":"us","report_date":"2026-09-11","report_type":"full_rth","generated_at":"2026-09-14 08:22:01 CST","overview_lead":"标普500收报7656.98点（+0.86%），纳斯达克100收报26333点（+0.96%）；科技股多数收涨，市场风险偏好回暖。","overvie… | {<br>  "market": "us",<br>  "report_date": "2026-09-11",<br>  "report_type": "full_rth",<br>  "generated_at": "2026-09-14 08:22:01 CST",<br>  "overview_lead": "标普500收报7656.98点（+0.86%），纳斯达克100收报26333点（… | C:\Users\DP\.zcode\workspace\default\nas\reports\market_review_2026-09-11.html | 2026-09-15 19:06:13 | <!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>美股每日盘后回顾 — 2026年9月11日（星期五）</title><style>:root {<br>  --ink: #17… |
| 4 | us | 2026-09-14 | 2026-09-14 09:05:58 CST | 2026-09-15T13:30:00.000Z | {"market":"us","report_date":"2026-09-14","report_type":"full_rth","generated_at":"2026-09-14 09:05:58 CST","overview_lead":"标普500收报7656.98点（+0.86%），纳斯达克100收报26333点（+0.96%）；科技股多数收涨，市场风险偏好回暖。","overvie… | {<br>  "market": "us",<br>  "report_date": "2026-09-14",<br>  "report_type": "full_rth",<br>  "generated_at": "2026-09-14 09:05:58 CST",<br>  "overview_lead": "标普500收报7656.98点（+0.86%），纳斯达克100收报26333点（… | C:\Users\DP\.zcode\workspace\default\nas\reports\market_review_2026-09-14.html | 2026-09-15 19:06:13 | <!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>美股每日盘后回顾 — 2026年9月14日（星期一）</title><style>:root {<br>  --ink: #17… |
| 472 | cn | 2026-09-15 | 2026-09-15 09:52:53 CST | 2026-09-16T01:00:00.000Z | {"market":"cn","report_date":"2026-09-15","report_type":"full_cn","generated_at":"2026-09-15 09:52:53 CST","overview_lead":"上证综指 -0.10%，创业板指 -0.35%，科创50 +0.67%。板块快照暂无可用数据，以上为指数实际涨跌。","overview":"2026-… | {<br>  "market": "cn",<br>  "report_date": "2026-09-15",<br>  "report_type": "full_cn",<br>  "generated_at": "2026-09-15 09:52:53 CST",<br>  "overview_lead": "上证综指 -0.10%，创业板指 -0.35%，科创50 +0.67%。板块快照暂… | C:\Users\DP\.zcode\workspace\default\nas\reports\cn_market_review_2026-09-15.html | 2026-09-15 19:06:13 | <!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A股每日盘后回顾 — 2026年9月15日（星期二）</title><style>:root {<br>  --ink: #17… |

### `schema_migrations`（8 行）

| version | applied_at |
|---|---|
| 001 | 2026-09-14 17:24:24 |
| 002 | 2026-09-14 17:24:24 |
| 003 | 2026-09-14 17:27:13 |
| 004 | 2026-09-14 18:55:58 |
| 005 | 2026-09-14 19:00:17 |
| 006 | 2026-09-14 19:07:24 |
| 007 | 2026-09-15 16:12:22 |
| 008 | 2026-09-15 16:40:46 |

### `transactions`（9 行）

| id | fund_code | date | type | amount | nav | shares | fee | note | created_at | price | currency | fx_rate | premium_rate | nominal_days | annual_rate | commission_rate | tax_rate | face_value | last_interest_date | maturity_date | first_settlement_date | expiry_date | interest_days | occupied_days | expected_interest | expected_net_income |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5 | 007721 | 2026-09-10 | buy | 50 | 2.2345 | 22.37637055269635 | 0.05 |  | 2026-09-14 13:41:13 | 0 | CNY | 1 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 6 | 017641 | 2026-09-10 | buy | 10 | 1.6882 | 5.923468783319512 | 0.01 |  | 2026-09-14 13:42:00 | 0 | CNY | 1 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 7 | 160213 | 2026-09-10 | buy | 50 | 4.419 | 11.314777098891152 | 0.07 |  | 2026-09-14 13:42:43 | 0 | CNY | 1 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 8 | 017641 | 2026-09-11 | buy | 10 | 1.7012 | 5.8723254173524575 | 0.01 |  | 2026-09-14 20:33:36 | 1.7012 | CNY | 1 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 10 | 007721 | 2026-09-11 | buy | 100 | 2.2511 | 44.37830394029586 | 0.1 |  | 2026-09-14 20:34:32 | 2.2511 | CNY | 1 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 11 | 160213 | 2026-09-11 | buy | 50 | 4.457 | 11.202602647520754 | 0.07 |  | 2026-09-14 20:34:59 | 4.457 | CNY | 1 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 12 | MMU2ERZ5Y | 2026-09-15 | buy | 1250 | 1 | 1250 | 0 |  | 2026-09-15 16:28:00 | 1 | CNY | 1 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 13 | MMU2ESJ7V | 2026-09-15 | buy | 2000 | 1 | 2000 | 0 |  | 2026-09-15 16:28:21 | 1 | CNY | 1 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 16 | MMU2ESJ7V | 2026-09-15 | sell | 1010 | 1 | 1010 | 0 |  | 2026-09-15 17:29:42 | 1 | CNY | 1 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
