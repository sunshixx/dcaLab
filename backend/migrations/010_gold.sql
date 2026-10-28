-- 黄金（积存金）：银行积存金没有公开报价接口，成交价基本是上金所 Au99.99 ± 点差。
-- price_offset 即「点差/溢价」，单位 元/克，用于把基准价对齐到账户实际报价。
ALTER TABLE funds ADD COLUMN price_offset REAL NOT NULL DEFAULT 0;
