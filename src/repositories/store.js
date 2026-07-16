export async function saveMessage(env, message, sessionId, text, fileId) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sync_sessions (session_id, chat_id, source_message_id, content, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, datetime(?, '+1 day'))
      ON CONFLICT(session_id) DO UPDATE SET content = CASE WHEN excluded.content <> '' THEN excluded.content ELSE sync_sessions.content END`)
      .bind(sessionId, String(message.chat.id), message.message_id, text, now, now),
    ...(fileId ? [env.DB.prepare(`INSERT OR IGNORE INTO sync_media (session_id, message_id, file_id, sort_order) VALUES (?, ?, ?, ?)`)
      .bind(sessionId, message.message_id, fileId, message.message_id)] : [])
  ]);
}

export async function createJob(env, sessionId, visibility, chatId, resultMessageId) {
  const jobId = crypto.randomUUID();
  await env.DB.prepare(`INSERT OR IGNORE INTO sync_jobs
    (job_id, session_id, visibility, status, memos_status, channel_status, result_chat_id, result_message_id, created_at, updated_at)
    VALUES (?, ?, ?, 'queued', 'pending', 'pending', ?, ?, datetime('now'), datetime('now'))`)
    .bind(jobId, sessionId, visibility, String(chatId), resultMessageId).run();
  return env.DB.prepare(`SELECT * FROM sync_jobs WHERE session_id = ? AND visibility = ?`).bind(sessionId, visibility).first();
}

export async function loadJob(env, jobId) {
  const job = await env.DB.prepare(`SELECT j.*, s.content FROM sync_jobs j JOIN sync_sessions s ON s.session_id = j.session_id WHERE j.job_id = ?`).bind(jobId).first();
  if (!job) return null;
  const media = await env.DB.prepare(`SELECT file_id FROM sync_media WHERE session_id = ? ORDER BY sort_order`).bind(job.session_id).all();
  return { ...job, fileIds: media.results.map((row) => row.file_id) };
}

export async function updateTarget(env, jobId, target, status, error = null) {
  const allowed = target === "memos" ? "memos" : "channel";
  await env.DB.prepare(`UPDATE sync_jobs SET ${allowed}_status = ?, ${allowed}_error = ?, ${allowed}_attempts = ${allowed}_attempts + 1, updated_at = datetime('now') WHERE job_id = ?`)
    .bind(status, error, jobId).run();
}

export async function finishJob(env, jobId, status) {
  await env.DB.prepare(`UPDATE sync_jobs SET status = ?, updated_at = datetime('now'), completed_at = CASE WHEN ? IN ('success','partial','failed') THEN datetime('now') ELSE completed_at END WHERE job_id = ?`)
    .bind(status, status, jobId).run();
}
