# DCA-Lab — 定投成本实验室

长期定投策略的**收益与成本对比**模拟器 + **基金记账本**。Web 应用（Vue 3 前端 + Node.js/Express 后端 + SQLite）。

![tech](https://img.shields.io/badge/frontend-Vue3%20%2B%20ECharts-blue) ![tech](https://img.shields.io/badge/backend-Node%2024%20%2B%20Express-green) ![db](https://img.shields.io/badge/db-SQLite%20(node%3Asqlite)-lightgrey)

## 功能

**① 模拟器**（左侧参数面板 / 右侧结果区）

- 月定投金额、年限、多标的（标普500 / 纳指100 / 红利低波 / 沪深300-A500）按权重拆分
- 每标的可展开高级参数：预期收益率、管理+托管费、现金拖累（场外联接）、股息率与预扣税、资本利得税、买入溢价率与持续月数、卖出溢价、申购费/佣金、赎回费阶梯
- 全局：CNY/USD 汇率与**年化漂移**、**通胀**（输出实际购买力）、**动态切换**（溢价超阈值时当月资金自动转入 A 股“溢出桶”）
- 结果：逐年表、增长曲线、费用堆叠图、**费用分解双口径**（名义 vs 终值·含复利机会成本）、**三情景 ±2pp 敏感性**
- 方案保存/加载/删除（SQLite），跨方案对比页

**② 记账本**（一等公民）

- 输入 6 位基金代码自动带出名称/类型（东方财富公开接口）
- 交易录入**按日期自动回查成交净值**（正确处理 QDII T+1/T+2 净值滞后；查不到可手填）
- 类型：买入 / 卖出 / 现金分红 / 分红再投资 / 费用调整；卖出做份额校验
- 成本口径：**移动加权平均**；已实现/未实现盈亏分列
- **组合 XIRR**（金额加权年化，牛顿迭代+二分）与简单收益率并列
- CSV 导入/导出（UTF-8 BOM，Excel 友好）

**③ 持仓概览**：市值（盘中单位净值估算 → 降级最近已公布净值）、配置饼图、投入 vs 市值月度走势（历史净值回溯）

**④ 方案对比**：多套参数（如“纯场内 vs 纯场外 vs 动态切换”）并排重算对比

## 快速开始

要求：Node.js ≥ 23.4，推荐 24.x。项目使用 Node 内置 `node:sqlite`。

### 1. 首次初始化

```bash
git clone <仓库地址>
cd nas
npm run init
```

`npm run init` 会安装根目录、backend、frontend 依赖，创建 `.env.local`，并配置默认规则代理 `http://127.0.0.1:7897`。代理端口不可用时只会提示警告，不会阻止安装。
```bash
### 2. 启动开发环境

先确认 VPN 软件已开启 HTTP/Mixed 代理端口 `7897`，然后：
把生成的 `my-backup.db` 通过 U 盘、网盘或局域网复制到新电脑项目根目录后执行：

```bash
npm run dev
```

打开 <http://localhost:5173>。前端是 `5173`，后端是 `3001`。

进入“市场复盘”Tab 后，页面会先显示数据库中的缓存报告；缓存过期时，后台才调用行情接口、RSS 和 Skill 生成新报告。

### 3. 验证环境

```bash
npm test
npm run db:migrate
```

数据库启动时会自动执行 migration；`db:migrate` 可以手动重复执行，已执行的版本不会重复运行。

## 数据与迁移

### 数据存储

所有业务数据都在 `backend/data/app.db`：

```text
plans              定投方案
funds              基金信息
transactions       交易流水
reports            报告摘要、新闻、行情审计、payload、HTML 和缓存失效时间
schema_migrations  已执行的 SQL migration 版本
```

报告生成过程中仍会在 `reports/` 写入 Skill 所需的中间 JSON 和 HTML 文件；接口读取报告时优先从 SQLite 返回，文件用于生成过程和兼容备份。

### 换电脑迁移数据

旧电脑先停止后端，再备份：

```bash
npm run db:backup my-backup.db
```

新电脑执行：

```bash
npm run init
npm run db:restore my-backup.db
npm run db:migrate
npm run dev
```

方案、基金、交易流水、持仓计算数据，以及报告摘要、新闻和缓存都会随 `app.db` 一起迁移。恢复数据库前必须停止后端服务。

可用命令：

```bash
npm run db:migrate       # 执行未运行的 SQL migration
npm run db:backup out.db
npm run db:restore in.db
```

## 网络代理

本地 Windows/macOS：

- VPN 开启 HTTP/Mixed 代理端口 `7897`；
- Node、Python Skill 和新闻抓取自动使用 `http://127.0.0.1:7897`；
- 如端口不同，设置 `MARKET_PROXY_URL` 覆盖默认值。

Docker：

- VPN 开启 `Allow LAN`/“允许局域网连接”；
- Compose 默认使用 `http://host.docker.internal:7897`；
- 启动命令：

```bash
docker compose up --build
```

容器模式下，如果 VPN 只监听 `127.0.0.1` 且未开启 Allow LAN，容器无法访问宿主机代理。

## 项目技能与复盘

技能完整目录位于：

```text
skills/generate-us-market-daily-review/
```

项目级技能随仓库同步，不需要每台电脑重新下载。若还要安装 RedSkill 全局商店，在 WSL/Linux 中执行：

```bash
curl -fsSL https://redskill.xiaohongshu.net/install.sh | bash
redskill install generate-us-market-daily-review
```

Windows PowerShell 请在 WSL 中执行上述命令。

复盘缓存规则：

- A 股：报告日期次日北京时间 `09:00` 失效；
- 美股：报告日期次日美东时间 `09:30` 失效，夏令时自动处理；
- 缓存有效时只读 SQLite，不重复抓取或运行 Skill。

## Docker（可选）

```bash
docker compose up --build
```

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/calculate` | 定投模拟（含三情景），请求/响应见下方示例 |
| GET/POST/DELETE | `/api/plans[/:id]` | 方案保存/加载/删除 |
| GET/POST/DELETE | `/api/ledger/funds[/:code]` | 记账本基金（POST 留空 name 自动查询） |
| GET/POST/DELETE | `/api/ledger/transactions[/:id]` | 交易流水（卖出做份额校验） |
| GET | `/api/ledger/holdings` | 持仓 + 最新估值 |
| GET | `/api/ledger/stats` | 投入/市值/盈亏/组合 XIRR |
| GET | `/api/ledger/series` | 投入 vs 市值月度走势 |
| GET/POST | `/api/ledger/export.csv` `/api/ledger/import.csv` | CSV 导出/导入 |
| GET | `/api/market/fund/:code` | 基金快照（信息+估值来源） |
| GET | `/api/market/fund/:code/navs?limit=30&page=1` | 历史净值 |

`POST /api/calculate` 请求示例（比率均为小数）：

```json
{
  "monthly_amount": 3000, "years": 20,
  "assets": [
    { "name": "标普500", "currency": "USD", "expected_return": 0.08,
      "management_fee": 0.0075, "cash_drag": 0.005,
      "dividend_yield": 0.013, "dividend_tax_rate": 0.10,
      "capital_gains_tax_rate": 0.0, "buy_premium": 0.08, "premium_months": 1,
      "sell_premium": 0.0, "subscription_fee": 0.0012,
      "redemption_fee_tiers": [{"max_days":7,"rate":0.015},{"max_days":null,"rate":0}],
      "weight": 1 }
  ],
  "global": { "exchange_rate": 7.0, "fx_drift": 0, "inflation": 0.025,
              "enable_dynamic_switch": false, "premium_threshold": 0.06 }
}
```

## 核心公式与口径（出处）

1. **逐月迭代而非闭式公式**：定投是逐月现金流，引擎按“月初买入 → 当月计息 → 股息计提再投资”逐月推演，第 t 月投入复利 `N−t+1` 个月。零费用情形与年金终值 `FV = C(1+i)((1+i)^N−1)/i` 逐分一致（单测用例 1；Bodie/Kane/Marcus《投资学》）。
2. **买入溢价（几何口径）**：以溢价 p 成交换得的公平市值为 `1/(1+p)`，故真实损失率 = `p/(1+p)`（8% 溢价 → 实损 8/108 ≈ 7.41%）。仅 `premium_months` 内的月份受影响；`premium_months=0` 且 p>0 视为仅首月。
3. **卖出溢价**：卖出款 = 期末公平市值 × `(1+sell_premium)`。⚠️ 与常见推导 `(1+sell)/(1+avg_buy_premium)` 的差异：买入溢价已在买入端按 `1/(1+p)` 扣减份额，卖出端再除一次会**重复计提**，故本引擎不除分母；`avg_buy_premium` 仅作信息输出。
4. **股息**：每月 `市值 × dividend_yield/12`，预扣 `dividend_tax_rate`，税后净额自动再投资（形成新批次，不收申购费）。
5. **现金拖累**：场外联接基金现金头寸的年化损耗，按月从增长率中扣减（`r_net = expected_return − management_fee − cash_drag`）。
6. **费用的复利机会成本（真实成本）**：第 t 月费用 `c` 的终值口径 = `c × (1+r_net_m)^(N−t)`。20 年期下通常是名义值的 1.5~2 倍——这才是费率差长期拉开差距的数学本质。
7. **赎回费/资本利得税按批次（lot）**：每笔买入/再投资独立记批次（成本基差=实付现金，含溢价与申购费），持有天数=月数×30.4375 对阶梯取档；应税收益=`max(0, 净卖出款−批次基差)`，溢价买入批次天然不产生应税所得。
8. **汇率**：`fx(m) = fx0 × (1+fx_drift)^(m/12)`，USD 标的按当月汇率折算投入、期末汇率折回。
9. **实际购买力**：`final / (1+inflation)^years`。
10. **XIRR**：解 `Σ CF_i/(1+x)^(d_i/365) = 0`（Excel XIRR 同定义），牛顿迭代，失败退化为二分。
11. **动态切换**：开启后，当月若标的处于溢价窗口且 `buy_premium > premium_threshold`，该月资金全额转入溢出桶（默认沪深300 参数），按其自身收益率复利。

## 目录结构

```
backend/
  src/routes/        calculate / plans / ledger / market
  src/services/      simulator（模拟引擎） bookkeeping（成本/XIRR/CSV） marketData（行情）
  src/models/        schemas（zod 校验） db（node:sqlite，全参数绑定）
  test/              14 个已知结果用例
frontend/
  src/views/         Simulator / Ledger / Portfolio / Compare
  src/stores/        calcStore / ledgerStore（Pinia）
  src/components/    ChartBox（ECharts 复古主题）
  src/assets/        bugzilla.css（复古样式）
```

## 已知限制（诚实的边界）

- 确定性模型，不含波动/回撤路径（蒙特卡洛留作 V2）；收益率是假设，不是预测。
- 盘中单位净值估算依赖东方财富公开接口，可能有反爬或延迟；失败时自动降级为最近已公布净值并在页面标注。场内交易价不作为基金持仓的单位净值估值。
- 记账买入金额按账户实际扣款记录，手续费包含在内；自动计算份额时按（实际扣款 − 手续费）÷ 确认净值计算，成本按实际扣款计入。
- 管理费按月近似（真实基金按日计提）；赎回费持有天数按 30.4375 天/月近似。
- 本工具用于教育目的，不构成投资建议。
