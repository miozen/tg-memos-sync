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

async function uploadResource(env, fileId) {
  const imageResponse = await getTelegramFile(env, fileId);
  const blob = await imageResponse.blob();
  const form = new FormData();
  form.append("file", blob, "tg_image.jpg");
  const resource = await memosRequest(env, "/api/v1/resources", {
    method: "POST", headers: { Authorization: `Bearer ${env.MEMOS_TOKEN}` }, body: form
  });
  if (!resource?.name) throw new ApiError("Memos", 200, "资源响应缺少 name", false);
  return resource.name;
}

export async function createMemo(env, content, visibility, fileIds) {
  const resourceNames = [];
  for (const fileId of fileIds) resourceNames.push(await uploadResource(env, fileId));
  const imageMarkdown = resourceNames.map((name) => `![image](${env.MEMOS_BASE_URL.replace(/\/$/, "")}/file/${name}/image.jpg)`).join("\n");
  return memosRequest(env, "/api/v1/memos", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.MEMOS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      content: [content, imageMarkdown].filter(Boolean).join("\n\n").trim(),
      visibility,
      resources: resourceNames.map((name) => ({ name }))
    })
  });
}
