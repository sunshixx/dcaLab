# 数据库结构说明

> 由 `backend/scripts/export-db-markdown.mjs` 自动生成于 2026/9/15 19:05:43（Asia/Shanghai）
> 来源：`backend/data/app.db`

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
