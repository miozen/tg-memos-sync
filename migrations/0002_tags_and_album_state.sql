ALTER TABLE sync_sessions ADD COLUMN selected_tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sync_sessions ADD COLUMN control_message_id INTEGER;
ALTER TABLE sync_sessions ADD COLUMN media_token TEXT;
ALTER TABLE sync_sessions ADD COLUMN media_updated_at TEXT;

ALTER TABLE sync_jobs ADD COLUMN selected_tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sync_jobs ADD COLUMN channel_media_message_id INTEGER;

CREATE TABLE IF NOT EXISTS processed_callbacks (
  callback_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
