import { answerCallback, editMessage, sendKeyboard, updateKeyboard } from "../adapters/telegram.js";
import { jsonLog } from "../lib/logger.js";
import { formatSelectedTags, getTagByIndex, isValidTagIndex } from "../lib/tags.js";
import {
  claimControlMessage,
  createJob,
  getSession,
  saveMessage,
  setControlMessage,
  toggleSessionTag
} from "../repositories/store.js";

const DEFAULT_MEDIA_GROUP_SETTLE_MS = 1200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSettleDelayMs(env) {
  if (env.MEDIA_GROUP_SETTLE_MS === undefined || env.MEDIA_GROUP_SETTLE_MS === null || env.MEDIA_GROUP_SETTLE_MS === "") {
    return DEFAULT_MEDIA_GROUP_SETTLE_MS;
  }
  const parsed = Number(env.MEDIA_GROUP_SETTLE_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MEDIA_GROUP_SETTLE_MS;
}

function allowed(message, env) {
  if (!env.ALLOWED_USER_IDS) return true;
  const ids = env.ALLOWED_USER_IDS.split(",").map((value) => value.trim()).filter(Boolean);
  return ids.includes(String(message.from?.id));
}

async function safeAnswerCallback(env, callbackQueryId, text) {
  if (!callbackQueryId) return;
  try {
    await answerCallback(env, callbackQueryId, text);
  } catch (error) {
    jsonLog("warn", "callback_answer_failed", { error });
  }
}

async function ensureOrRefreshControlKeyboard(env, chatId, session) {
  if (session.control_message_id === null || session.control_message_id === undefined) {
    const claimed = await claimControlMessage(env, session.session_id);
    if (!claimed) return;
    try {
      const sent = await sendKeyboard(env, chatId, session.session_id, session.selectedTags, session.mediaCount);
      await setControlMessage(env, session.session_id, sent?.message_id ?? 0);
    } catch (error) {
      await setControlMessage(env, session.session_id, null);
      throw error;
    }
    return;
  }

  if (session.control_message_id > 0) {
    await updateKeyboard(env, chatId, session.control_message_id, session.session_id, session.selectedTags, session.mediaCount);
  }
}

async function waitForMediaGroupSettle(env, sessionId) {
  const settleMs = getSettleDelayMs(env);
  let session = await getSession(env, sessionId);
  if (settleMs <= 0) return session;

  for (let attempt = 0; attempt < 5 && session?.media_updated_at; attempt++) {
    const updatedAt = Date.parse(session.media_updated_at);
    if (!Number.isFinite(updatedAt)) break;
    const remaining = settleMs - (Date.now() - updatedAt);
    if (remaining <= 0) break;
    await sleep(remaining);
    session = await getSession(env, sessionId);
  }
  return session;
}

function parseCallbackData(raw) {
  const parts = String(raw || "").split("|");
  if (parts[0] === "t" && parts.length >= 3) {
    const tagIndex = Number(parts[1]);
    const sessionId = parts.slice(2).join("|");
    if (isValidTagIndex(tagIndex) && sessionId) {
      return { type: "tag", tagIndex, sessionId };
    }
  }
  if (parts[0] === "v" && (parts[1] === "PUB" || parts[1] === "PRV") && parts.length >= 3) {
    const sessionId = parts.slice(2).join("|");
    if (sessionId) {
      return { type: "vis", visibility: parts[1] === "PUB" ? "PUBLIC" : "PRIVATE", sessionId };
    }
  }
  if (parts[0] === "vis" && (parts[1] === "PUBLIC" || parts[1] === "PRIVATE") && parts.length >= 3) {
    const sessionId = parts.slice(2).join("|");
    if (sessionId) {
      return { type: "vis", visibility: parts[1], sessionId };
    }
  }
  return null;
}

export async function handleMessage(message, env) {
  if (!allowed(message, env)) {
    jsonLog("warn", "user_rejected", { userId: String(message.from?.id || "unknown") });
    return;
  }

  const text = message.caption || message.text || "";
  const photos = message.photo || [];
  const fileId = photos.length ? photos[photos.length - 1].file_id : null;
  if (!text && !fileId) return;

  const isMediaGroup = Boolean(message.media_group_id);
  const sessionId = message.media_group_id || `single_${message.message_id}`;
  const mediaToken = isMediaGroup ? crypto.randomUUID() : null;

  await saveMessage(env, message, sessionId, text, fileId, mediaToken);

  if (isMediaGroup) {
    const settleMs = getSettleDelayMs(env);
    if (settleMs > 0) await sleep(settleMs);
  }

  const session = await getSession(env, sessionId);
  if (!session || session.hasJob) return;
  if (isMediaGroup && session.media_token !== mediaToken) return;

  await ensureOrRefreshControlKeyboard(env, message.chat.id, session);
}

export async function handleCallback(query, env) {
  const parsed = parseCallbackData(query.data);
  if (!parsed) {
    await safeAnswerCallback(env, query.id, "无效操作");
    return;
  }
  if (!allowed(query, env)) {
    await safeAnswerCallback(env, query.id, "无权限操作");
    return;
  }

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  if (parsed.type === "tag") {
    const result = await toggleSessionTag(env, parsed.sessionId, parsed.tagIndex, query.id);
    if (result.status === "missing") {
      await safeAnswerCallback(env, query.id, "会话不存在或已过期");
      return;
    }
    if (result.status === "duplicate") {
      await safeAnswerCallback(env, query.id, "操作已处理");
      return;
    }

    const tag = getTagByIndex(parsed.tagIndex);
    const notice = result.status === "added" ? `已选择 ${tag.hashtag}` : `已取消 ${tag.hashtag}`;
    await safeAnswerCallback(env, query.id, notice);
    await updateKeyboard(env, chatId, messageId, parsed.sessionId, result.selectedTags, result.mediaCount);
    return;
  }

  await safeAnswerCallback(env, query.id, "任务已接收");

  try {
    const session = await waitForMediaGroupSettle(env, parsed.sessionId);
    if (!session) {
      await editMessage(env, chatId, messageId, "❌ 无法创建同步任务\n会话不存在或已过期");
      return;
    }

    const job = await createJob(env, parsed.sessionId, parsed.visibility, chatId, messageId);
    if (!job) {
      await editMessage(env, chatId, messageId, "❌ 无法创建同步任务\n会话不存在或已过期");
      return;
    }

    if (job.created) {
      await env.SYNC_QUEUE.send({ jobId: job.job_id });
    }

    const tagsText = job.selectedTags.length ? formatSelectedTags(job.selectedTags) : "无";
    await editMessage(
      env,
      chatId,
      messageId,
      `⏳ 已进入同步队列\n模式：${parsed.visibility}\n标签：${tagsText}\n任务：${job.job_id.slice(0, 8)}`
    );
  } catch (error) {
    jsonLog("error", "job_enqueue_failed", { error, sessionId: parsed.sessionId });
    await editMessage(env, chatId, messageId, `❌ 无法创建同步任务\n${error.message.slice(0, 180)}`);
  }
}
