import { ApiError, isRetryableStatus } from "../lib/errors.js";
import { getTelegramFile } from "./telegram.js";

async function memosRequest(env, path, options) {
  let response;
  try { response = await fetch(`${env.MEMOS_BASE_URL.replace(/\/$/, "")}${path}`, options); }
  catch (error) { throw new ApiError("Memos", 0, error.message, true); }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new ApiError("Memos", response.status, body || response.statusText, isRetryableStatus(response.status));
  }
  try { return await response.json(); }
  catch { throw new ApiError("Memos", response.status, "响应不是有效 JSON", false); }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function uploadAttachment(env, fileId) {
  const imageResponse = await getTelegramFile(env, fileId);
  const responseType = imageResponse.headers.get("Content-Type") || "";
  const imageType = responseType.toLowerCase().startsWith("image/") ? responseType : "image/jpeg";
  const content = arrayBufferToBase64(await imageResponse.arrayBuffer());
  const attachment = await memosRequest(env, "/api/v1/attachments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MEMOS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      filename: "tg_image.jpg",
      type: imageType,
      content
    })
  });
  if (!attachment?.name) throw new ApiError("Memos", 200, "附件响应缺少 name", false);
  return attachment;
}

export async function createMemo(env, content, visibility, fileIds) {
  const attachments = [];
  for (const fileId of fileIds) attachments.push(await uploadAttachment(env, fileId));
  return memosRequest(env, "/api/v1/memos", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.MEMOS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      content: content.trim(),
      visibility,
      attachments
    })
  });
}
