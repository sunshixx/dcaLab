CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market TEXT NOT NULL CHECK (market IN ('cn', 'us')),
  report_date TEXT NOT NULL,
  generated_at TEXT,
  expires_at TEXT,
  audit_json TEXT NOT NULL,
  payload_json TEXT,
  html_path TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (market, report_date)
);

CREATE INDEX IF NOT EXISTS idx_reports_market_date ON reports(market, report_date DESC);