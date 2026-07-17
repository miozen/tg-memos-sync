CREATE TABLE IF NOT EXISTS sync_sessions (
  session_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  source_message_id INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_media (
  session_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (session_id, message_id),
  FOREIGN KEY (session_id) REFERENCES sync_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  job_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
  status TEXT NOT NULL,
  memos_status TEXT NOT NULL DEFAULT 'pending',
  channel_status TEXT NOT NULL DEFAULT 'pending',
  memos_attempts INTEGER NOT NULL DEFAULT 0,
  channel_attempts INTEGER NOT NULL DEFAULT 0,
  memos_error TEXT,
  channel_error TEXT,
  result_chat_id TEXT NOT NULL,
  result_message_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (session_id, visibility),
  FOREIGN KEY (session_id) REFERENCES sync_sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON sync_jobs(status, updated_at);
