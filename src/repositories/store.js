import { parseSelectedTags, serializeSelectedTags, toggleTagIndex } from "../lib/tags.js";

export async function saveMessage(env, message, sessionId, text, fileId, mediaToken = null) {
  const now = new Date().toISOString();
  const mediaUpdatedAt = mediaToken ? now : null;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sync_sessions
      (session_id, chat_id, source_message_id, content, created_at, expires_at, media_token, media_updated_at)
      VALUES (?, ?, ?, ?, ?, datetime(?, '+1 day'), ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        content = CASE WHEN excluded.content <> '' THEN excluded.content ELSE sync_sessions.content END,
        media_token = COALESCE(excluded.media_token, sync_sessions.media_token),
        media_updated_at = COALESCE(excluded.media_updated_at, sync_sessions.media_updated_at)`)
      .bind(sessionId, String(message.chat.id), message.message_id, text, now, now, mediaToken, mediaUpdatedAt),
    ...(fileId ? [env.DB.prepare(`INSERT OR IGNORE INTO sync_media (session_id, message_id, file_id, sort_order) VALUES (?, ?, ?, ?)`)
      .bind(sessionId, message.message_id, fileId, message.message_id)] : [])
  ]);
}

export async function getSession(env, sessionId) {
  const row = await env.DB.prepare(`SELECT s.*,
    (SELECT COUNT(*) FROM sync_media m WHERE m.session_id = s.session_id) AS media_count,
    EXISTS(SELECT 1 FROM sync_jobs j WHERE j.session_id = s.session_id) AS has_job
    FROM sync_sessions s WHERE s.session_id = ?`).bind(sessionId).first();
  if (!row) return null;
  return {
    ...row,
    selectedTags: parseSelectedTags(row.selected_tags),
    mediaCount: Number(row.media_count || 0),
    hasJob: Boolean(row.has_job)
  };
}

export async function claimControlMessage(env, sessionId) {
  const result = await env.DB.prepare(
    `UPDATE sync_sessions SET control_message_id = -1 WHERE session_id = ? AND control_message_id IS NULL`
  ).bind(sessionId).run();
  return Boolean(result?.meta?.changes > 0);
}

export async function setControlMessage(env, sessionId, messageId) {
  await env.DB.prepare(
    `UPDATE sync_sessions SET control_message_id = ? WHERE session_id = ?`
  ).bind(messageId, sessionId).run();
}

export async function toggleSessionTag(env, sessionId, tagIndex, callbackId = null) {
  const session = await getSession(env, sessionId);
  if (!session) return { status: "missing", selectedTags: [], mediaCount: 0 };

  if (callbackId) {
    const dedupe = await env.DB.prepare(
      `INSERT OR IGNORE INTO processed_callbacks (callback_id, session_id) VALUES (?, ?)`
    ).bind(String(callbackId), sessionId).run();
    if (!dedupe?.meta?.changes) {
      return {
        status: "duplicate",
        selectedTags: session.selectedTags,
        mediaCount: session.mediaCount
      };
    }
  }

  const nextTags = toggleTagIndex(session.selectedTags, tagIndex);
  const serialized = serializeSelectedTags(nextTags);
  await env.DB.prepare(
    `UPDATE sync_sessions SET selected_tags = ? WHERE session_id = ?`
  ).bind(serialized, sessionId).run();

  return {
    status: nextTags.includes(tagIndex) ? "added" : "removed",
    selectedTags: nextTags,
    mediaCount: session.mediaCount
  };
}

export async function createJob(env, sessionId, visibility, chatId, resultMessageId) {
  const jobId = crypto.randomUUID();
  const insertResult = await env.DB.prepare(`INSERT OR IGNORE INTO sync_jobs
    (job_id, session_id, visibility, status, memos_status, channel_status, selected_tags, result_chat_id, result_message_id, created_at, updated_at)
    SELECT ?, session_id, ?, 'queued', 'pending', 'pending', COALESCE(selected_tags, '[]'), ?, ?, datetime('now'), datetime('now')
    FROM sync_sessions WHERE session_id = ?`)
    .bind(jobId, visibility, String(chatId), resultMessageId, sessionId).run();
  const job = await env.DB.prepare(`SELECT * FROM sync_jobs WHERE session_id = ? AND visibility = ?`)
    .bind(sessionId, visibility).first();
  if (!job) return null;
  return {
    ...job,
    created: Boolean(insertResult?.meta?.changes > 0),
    selectedTags: parseSelectedTags(job.selected_tags)
  };
}

export async function loadJob(env, jobId) {
  const job = await env.DB.prepare(
    `SELECT j.*, s.content FROM sync_jobs j JOIN sync_sessions s ON s.session_id = j.session_id WHERE j.job_id = ?`
  ).bind(jobId).first();
  if (!job) return null;
  const media = await env.DB.prepare(
    `SELECT file_id FROM sync_media WHERE session_id = ? ORDER BY sort_order ASC, message_id ASC`
  ).bind(job.session_id).all();
  return {
    ...job,
    selectedTags: parseSelectedTags(job.selected_tags),
    fileIds: media.results.map((row) => row.file_id)
  };
}

export async function setChannelMediaMessageId(env, jobId, messageId) {
  if (!messageId) return;
  await env.DB.prepare(
    `UPDATE sync_jobs SET channel_media_message_id = ?, updated_at = datetime('now') WHERE job_id = ?`
  ).bind(messageId, jobId).run();
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
