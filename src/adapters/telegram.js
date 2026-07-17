import { ApiError, isRetryableStatus } from "../lib/errors.js";

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
  callTelegram(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });

export const sendKeyboard = (env, chatId, sessionId) =>
  callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text: "📦 资源已暂存，请选择同步模式：",
    reply_markup: { inline_keyboard: [[
      { text: "🌟 公开同步 (Public)", callback_data: `vis|PUBLIC|${sessionId}` },
      { text: "🔒 私有存档 (Private)", callback_data: `vis|PRIVATE|${sessionId}` }
    ]] }
  });

export async function getTelegramFile(env, fileId) {
  const file = await callTelegram(env, "getFile", { file_id: fileId });
  const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${file.file_path}`);
  if (!response.ok) throw new ApiError("Telegram file", response.status, `download failed`, isRetryableStatus(response.status));
  return response;
}

export async function sendToChannel(env, channelId, content, fileIds) {
  if (!fileIds.length) return callTelegram(env, "sendMessage", { chat_id: channelId, text: content || " " });
  if (fileIds.length === 1) return callTelegram(env, "sendPhoto", { chat_id: channelId, photo: fileIds[0], caption: content });
  const media = fileIds.map((fileId, index) => ({ type: "photo", media: fileId, ...(index === 0 && content ? { caption: content } : {}) }));
  return callTelegram(env, "sendMediaGroup", { chat_id: channelId, media });
}
