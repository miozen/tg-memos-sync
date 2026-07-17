import { answerCallback, editMessage, sendKeyboard } from "../adapters/telegram.js";
import { createJob, saveMessage } from "../repositories/store.js";
import { jsonLog } from "../lib/logger.js";

function allowed(message, env) {
  if (!env.ALLOWED_USER_IDS) return true;
  const ids = env.ALLOWED_USER_IDS.split(",").map((value) => value.trim());
  return ids.includes(String(message.from?.id));
}

export async function handleMessage(message, env) {
  if (!allowed(message, env)) {
    jsonLog("warn", "user_rejected", { userId: String(message.from?.id || "unknown") });
    return;
  }
  const text = message.caption || message.text || "";
  const sessionId = message.media_group_id || `single_${message.message_id}`;
  const photos = message.photo || [];
  const fileId = photos.length ? photos[photos.length - 1].file_id : null;
  await saveMessage(env, message, sessionId, text, fileId);
  if (text || !message.media_group_id) await sendKeyboard(env, message.chat.id, sessionId);
}

export async function handleCallback(query, env) {
  try { await answerCallback(env, query.id, "任务已接收"); } catch (error) { jsonLog("warn", "callback_answer_failed", { error }); }
  const [action, visibility, sessionId] = String(query.data || "").split("|");
  if (action !== "vis" || !["PUBLIC", "PRIVATE"].includes(visibility) || !sessionId) return;
  if (!allowed(query, env)) return;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  try {
    const job = await createJob(env, sessionId, visibility, chatId, messageId);
    if (job.status === "queued") await env.SYNC_QUEUE.send({ jobId: job.job_id });
    await editMessage(env, chatId, messageId, `⏳ 已进入同步队列\n模式：${visibility}\n任务：${job.job_id.slice(0, 8)}`);
  } catch (error) {
    jsonLog("error", "job_enqueue_failed", { error, sessionId });
    await editMessage(env, chatId, messageId, `❌ 无法创建同步任务\n${error.message.slice(0, 180)}`);
  }
}
