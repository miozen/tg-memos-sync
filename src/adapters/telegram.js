import { ApiError, isRetryableStatus } from "../lib/errors.js";
import { BUILTIN_TAGS, formatSelectedTags, normalizeTagIndices } from "../lib/tags.js";

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;
const TAG_COLUMNS = 3;

async function callTelegram(env, method, payload) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    throw new ApiError("Telegram", 0, error.message, true);
  }
  let data;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok || !data?.ok) {
    const status = data?.error_code || response.status;
    throw new ApiError("Telegram", status, data?.description || `HTTP ${response.status}`, isRetryableStatus(status));
  }
  return data.result;
}

export const answerCallback = (env, callbackQueryId, text) =>
  callTelegram(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });

export const editMessage = (env, chatId, messageId, text, replyMarkup) =>
  callTelegram(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });

export function buildControlPayload(sessionId, selectedTags = [], mediaCount = 0) {
  const normalized = normalizeTagIndices(selectedTags);
  const selectedSet = new Set(normalized);
  const tagRows = [];

  for (let offset = 0; offset < BUILTIN_TAGS.length; offset += TAG_COLUMNS) {
    tagRows.push(
      BUILTIN_TAGS.slice(offset, offset + TAG_COLUMNS).map((tag) => ({
        text: selectedSet.has(tag.index) ? `✅ ${tag.name}` : `⬜ ${tag.name}`,
        callback_data: `t|${tag.index}|${sessionId}`
      }))
    );
  }

  const inline_keyboard = [
    ...tagRows,
    [
      { text: "🌟 公开同步 (Public)", callback_data: `v|PUB|${sessionId}` },
      { text: "🔒 私有存档 (Private)", callback_data: `v|PRV|${sessionId}` }
    ]
  ];

  const mediaLabel = mediaCount > 0 ? `（已收集 ${mediaCount} 张图片）` : "";
  const tagsLabel = normalized.length ? formatSelectedTags(normalized) : "无";
  const text = `📦 资源已暂存${mediaLabel}\n已选标签：${tagsLabel}\n\n点击下方标签可多选或取消，选好后直接点击同步模式：`;

  return { text, reply_markup: { inline_keyboard } };
}

export const sendKeyboard = (env, chatId, sessionId, selectedTags = [], mediaCount = 0) => {
  const payload = buildControlPayload(sessionId, selectedTags, mediaCount);
  return callTelegram(env, "sendMessage", { chat_id: chatId, ...payload });
};

export async function updateKeyboard(env, chatId, messageId, sessionId, selectedTags = [], mediaCount = 0) {
  const payload = buildControlPayload(sessionId, selectedTags, mediaCount);
  try {
    return await editMessage(env, chatId, messageId, payload.text, payload.reply_markup);
  } catch (error) {
    if (error instanceof ApiError && error.status === 400 && /message is not modified/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

export async function getTelegramFile(env, fileId) {
  const file = await callTelegram(env, "getFile", { file_id: fileId });
  const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${file.file_path}`);
  if (!response.ok) throw new ApiError("Telegram file", response.status, `download failed`, isRetryableStatus(response.status));
  return response;
}

export function splitTelegramText(text, maxLength = TELEGRAM_TEXT_LIMIT) {
  const source = String(text || "");
  if (source.length <= maxLength) return [source];

  const chunks = [];
  let remaining = source;
  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    let splitAt = slice.lastIndexOf("\n");
    if (splitAt < Math.floor(maxLength * 0.5)) {
      const spaceAt = slice.lastIndexOf(" ");
      if (spaceAt >= Math.floor(maxLength * 0.5)) splitAt = spaceAt;
      else splitAt = maxLength;
    }
    const chunk = remaining.slice(0, splitAt).trimEnd();
    chunks.push(chunk || remaining.slice(0, maxLength));
    remaining = remaining.slice(chunk ? splitAt : maxLength).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function sendToChannel(env, channelId, content, fileIds = [], options = {}) {
  const text = String(content || "");

  if (!fileIds.length) {
    if (text.length <= TELEGRAM_TEXT_LIMIT) {
      return callTelegram(env, "sendMessage", { chat_id: channelId, text: text || " " });
    }
    let lastResult = null;
    for (const chunk of splitTelegramText(text, TELEGRAM_TEXT_LIMIT)) {
      lastResult = await callTelegram(env, "sendMessage", { chat_id: channelId, text: chunk });
    }
    return lastResult;
  }

  if (text.length <= TELEGRAM_CAPTION_LIMIT) {
    if (fileIds.length === 1) {
      return callTelegram(env, "sendPhoto", { chat_id: channelId, photo: fileIds[0], caption: text });
    }
    const media = fileIds.map((fileId, index) => ({
      type: "photo",
      media: fileId,
      ...(index === 0 && text ? { caption: text } : {})
    }));
    return callTelegram(env, "sendMediaGroup", { chat_id: channelId, media });
  }

  let replyToMessageId = options.channelMediaMessageId || null;
  if (!replyToMessageId) {
    if (fileIds.length === 1) {
      const photoResult = await callTelegram(env, "sendPhoto", { chat_id: channelId, photo: fileIds[0] });
      replyToMessageId = photoResult?.message_id || null;
    } else {
      const media = fileIds.map((fileId) => ({ type: "photo", media: fileId }));
      const groupResult = await callTelegram(env, "sendMediaGroup", { chat_id: channelId, media });
      replyToMessageId = Array.isArray(groupResult)
        ? groupResult[0]?.message_id || null
        : groupResult?.message_id || null;
    }
    if (replyToMessageId && options.onMediaSent) {
      await options.onMediaSent(replyToMessageId);
    }
  }

  let lastTextResult = null;
  for (const chunk of splitTelegramText(text, TELEGRAM_TEXT_LIMIT)) {
    lastTextResult = await callTelegram(env, "sendMessage", {
      chat_id: channelId,
      text: chunk,
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
    });
    if (lastTextResult?.message_id) {
      replyToMessageId = lastTextResult.message_id;
    }
  }
  return lastTextResult;
}
