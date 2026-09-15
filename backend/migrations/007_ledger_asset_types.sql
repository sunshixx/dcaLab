ALTER TABLE funds ADD COLUMN asset_type TEXT NOT NULL DEFAULT 'fund';

CREATE INDEX IF NOT EXISTS idx_funds_asset_type ON funds(asset_type);