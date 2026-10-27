-- 目标配置：计划总金额 + 各类目标比例 + 类别与记账本标的的对应关系
-- 单方案模型（id=1），页面可整体编辑后覆盖保存。
CREATE TABLE IF NOT EXISTS allocation_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  total_amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS allocation_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES allocation_plans(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ratio REAL NOT NULL DEFAULT 0,
  group_name TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (plan_id, name)
);

-- 手工指定：某个记账本标的归入某个类别（优先级高于自动类型）
CREATE TABLE IF NOT EXISTS allocation_item_funds (
  item_id INTEGER NOT NULL REFERENCES allocation_items(id) ON DELETE CASCADE,
  fund_code TEXT NOT NULL REFERENCES funds(code) ON DELETE CASCADE,
  PRIMARY KEY (item_id, fund_code)
);

-- 自动类型：公积金/国债/逆回购/现金流按资产类型整类归入（新录入的自动生效）
CREATE TABLE IF NOT EXISTS allocation_item_types (
  item_id INTEGER NOT NULL REFERENCES allocation_items(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL,
  PRIMARY KEY (item_id, asset_type)
);

-- 默认方案：六大类目标配置（30/20/20/10/10/10）
-- 原油 QDII、有色 ETF、豆粕 ETF 不再单列预算，统一归入「大宗商品」大类；
-- 黄金单独作为一类保留（与商品大类区分）。
INSERT INTO allocation_plans (id, name, total_amount)
VALUES (1, '目标配置', 1000000)
ON CONFLICT(id) DO NOTHING;

INSERT INTO allocation_items (plan_id, name, ratio, group_name, sort_order) VALUES
  (1, '宽基', 0.30, '', 10),
  (1, '中长债', 0.20, '', 20),
  (1, '短债', 0.20, '', 30),
  (1, '黄金', 0.10, '', 40),
  (1, '大宗商品', 0.10, '', 50),
  (1, '现金', 0.10, '', 60)
ON CONFLICT(plan_id, name) DO NOTHING;

-- 公积金、现金流统一计入现金；国债默认归入中长债（可在页面改到短债）
INSERT INTO allocation_item_types (item_id, asset_type)
SELECT id, 'provident_fund' FROM allocation_items WHERE plan_id = 1 AND name = '现金'
ON CONFLICT DO NOTHING;

INSERT INTO allocation_item_types (item_id, asset_type)
SELECT id, 'cash_flow' FROM allocation_items WHERE plan_id = 1 AND name = '现金'
ON CONFLICT DO NOTHING;

INSERT INTO allocation_item_types (item_id, asset_type)
SELECT id, 'treasury_bond' FROM allocation_items WHERE plan_id = 1 AND name = '中长债'
ON CONFLICT DO NOTHING;
