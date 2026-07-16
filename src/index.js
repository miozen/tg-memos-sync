import { handleMessage, handleCallback } from "./handlers/webhook.js";
import { processQueueBatch } from "./handlers/queue.js";
import { jsonLog } from "./lib/logger.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === `/health/${env.ADMIN_HEALTH_SECRET || "disabled"}`) {
      return health(env);
    }

    if (request.method !== "POST" || url.pathname !== `/${env.SECRET_PATH}`) {
      return new Response("Unauthorized or Invalid Request", { status: 403 });
    }

    if (env.TELEGRAM_WEBHOOK_SECRET &&
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const update = await request.json();
      if (update.callback_query) {
        ctx.waitUntil(handleCallback(update.callback_query, env));
      } else if (update.message) {
        ctx.waitUntil(handleMessage(update.message, env));
      }
      return new Response("OK");
    } catch (error) {
      jsonLog("error", "webhook_failed", { error });
      return new Response("Error", { status: 500 });
    }
  },

  async queue(batch, env) {
    await processQueueBatch(batch, env);
  }
};

async function health(env) {
  if (!env.ADMIN_HEALTH_SECRET) return new Response("Not Found", { status: 404 });
  const required = ["TELEGRAM_TOKEN", "MEMOS_TOKEN", "MEMOS_BASE_URL", "CHANNEL_ID_PUBLIC", "CHANNEL_ID_PRIVATE", "SECRET_PATH"];
  const missing = required.filter((key) => !env[key]);
  let database = "ok";
  try { await env.DB.prepare("SELECT 1").first(); } catch { database = "error"; }
  return Response.json({
    ok: missing.length === 0 && database === "ok" && Boolean(env.SYNC_QUEUE),
    version: env.DEPLOY_VERSION || "development",
    database,
    queue: env.SYNC_QUEUE ? "ok" : "missing",
    missing
  });
}
