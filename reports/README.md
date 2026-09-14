# 市场复盘数据目录

本目录是 `generate-us-market-daily-review` 技能产出与前端「市场复盘」tab 之间的约定接口。

## 目录结构

```
reports/
  market_review_YYYY-MM-DD.html       # 美股独立报告（技能 render 输出）
  cn_market_review_YYYY-MM-DD.html    # A股独立报告
  data/
    market_data_YYYY-MM-DD.json       # 美股审计 JSON（含全部摘要字段）
    cn_market_data_YYYY-MM-DD.json    # A股审计 JSON
    cn_report_payload_YYYY-MM-DD.json # A股 payload（渲染输入）
    sina_cn_market_YYYY-MM-DD.json    # 新浪原始行情快照
```

## 后端读取约定

后端 `backend/src/routes/review.js` 通过 `REPORTS_DIR`（默认 `<工作区>/reports`）读取：

- `GET /api/review/list`     —— 列出美股/A股所有可用报告元数据
- `GET /api/review/summary`  —— 返回某日复盘摘要（`?market=cn|us&date=YYYY-MM-DD`）
- `GET /api/review/html/:name` —— 提供独立 HTML 报告

## 生成方式（在 WSL 内运行技能脚本）

```bash
cd /mnt/c/Users/DP/.zcode/workspace/default/nas
python3 skills/generate-us-market-daily-review/scripts/resolve_cn_report_date.py
python3 skills/generate-us-market-daily-review/scripts/fetch_sina_cn_market.py \
  --date YYYY-MM-DD --output reports/data/sina_cn_market_YYYY-MM-DD.json
python3 skills/generate-us-market-daily-review/scripts/build_cn_payload_skeleton.py \
  --date YYYY-MM-DD --input reports/data/sina_cn_market_YYYY-MM-DD.json \
  --output reports/data/cn_report_payload_YYYY-MM-DD.json
# （人工/Agent 补充 overview、news、voices、next_watch 等叙事字段后）
python3 skills/generate-us-market-daily-review/scripts/render_market_review.py \
  --input reports/data/cn_report_payload_YYYY-MM-DD.json \
  --output reports/cn_market_review_YYYY-MM-DD.html \
  --audit-output reports/data/cn_market_data_YYYY-MM-DD.json
python3 skills/generate-us-market-daily-review/scripts/validate_market_review.py \
  --html reports/cn_market_review_YYYY-MM-DD.html \
  --audit reports/data/cn_market_data_YYYY-MM-DD.json
```
