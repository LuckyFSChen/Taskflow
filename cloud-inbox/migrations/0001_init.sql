-- TaskFlow 雲端收件匣 — 初始 schema
--
-- events：保存已驗簽的 LINE webhook 事件原始 JSON。
--   webhook_event_id 唯一，用來做去重（LINE 可能重送同一事件）。
--   acknowledged_at 為 NULL 表示尚未被本機 runner 確認；ack 後才寫入時間戳，
--   絕不自動刪除或過期未確認的資料列。
-- 套用方式（於 cloud-inbox 目錄下執行）：
--   npx wrangler d1 execute <資料庫名稱> --remote --file=./migrations/0001_init.sql
--   npx wrangler d1 execute <資料庫名稱> --local  --file=./migrations/0001_init.sql   (本機開發用)

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_event_id TEXT NOT NULL UNIQUE,
  raw_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_unacknowledged
  ON events (seq)
  WHERE acknowledged_at IS NULL;
