import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import worker from "../src/index.js";
import { handleCallback, handleMessage } from "../src/handlers/webhook.js";
import { processQueueBatch } from "../src/handlers/queue.js";
import { BUILTIN_TAGS } from "../src/lib/tags.js";
import { applyMigrations, createSqliteD1 } from "./helpers/d1-mock.js";

function createHarness(t, options = {}) {
  const db = options.db || createSqliteD1(":memory:");
  if (!options.keepDbOpen) {
    t.after(() => db.close());
  }

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const tgCalls = [];
  const memosCalls = [];
  const queueMessages = [];
  let nextTgMessageId = 1000;

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    const body = init.body ? JSON.parse(init.body) : null;

    if (target.startsWith("https://api.telegram.org/bot")) {
      const method = target.split("/").pop();
      tgCalls.push({ method, body });
      if (options.onFetch) {
        const custom = await options.onFetch(target, body, init);
        if (custom) return custom;
      }

      if (method === "getFile") {
        return Response.json({ ok: true, result: { file_path: `photos/${body.file_id}.jpg` } });
      }
      if (method === "sendMediaGroup") {
        const items = body.media.map(() => ({ message_id: nextTgMessageId++ }));
        return Response.json({ ok: true, result: items });
      }
      return Response.json({ ok: true, result: { message_id: nextTgMessageId++ } });
    }

    if (target.startsWith("https://api.telegram.org/file/bot")) {
      if (options.onFetch) {
        const custom = await options.onFetch(target, body, init);
        if (custom) return custom;
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" }
      });
    }

    if (target.startsWith("https://memos.example.com/api/v1/attachments")) {
      memosCalls.push({ endpoint: "attachments", body });
      if (options.onFetch) {
        const custom = await options.onFetch(target, body, init);
        if (custom) return custom;
      }
      return Response.json({
        name: `attachments/${memosCalls.length}`,
        filename: body.filename,
        type: body.type
      });
    }

    if (target.startsWith("https://memos.example.com/api/v1/memos")) {
      memosCalls.push({ endpoint: "memos", body });
      if (options.onFetch) {
        const custom = await options.onFetch(target, body, init);
        if (custom) return custom;
      }
      return Response.json({ name: `memos/${memosCalls.length}` });
    }

    throw new Error(`Unexpected fetch URL: ${target}`);
  };

  const env = {
    DB: db,
    SYNC_QUEUE: {
      async send(msg) {
        queueMessages.push(msg);
      }
    },
    TELEGRAM_TOKEN: "test-tg-token",
    MEMOS_TOKEN: "test-memos-token",
    MEMOS_BASE_URL: "https://memos.example.com",
    CHANNEL_ID_PUBLIC: "-1001111111",
    CHANNEL_ID_PRIVATE: "-1002222222",
    SECRET_PATH: "hook",
    MEDIA_GROUP_SETTLE_MS: String(options.settleMs ?? 0),
    ...options.envOverrides
  };

  return { env, db, tgCalls, memosCalls, queueMessages };
}

async function runQueueOnce(env, queueMessages, attempts = 1) {
  const pending = queueMessages.splice(0, queueMessages.length);
  const outcomes = [];
  const batch = {
    messages: pending.map((body) => {
      const record = { body, acked: false, retried: false, retryDelay: null };
      outcomes.push(record);
      return {
        body,
        attempts,
        ack() { record.acked = true; },
        retry(opts) {
          record.retried = true;
          record.retryDelay = opts?.delaySeconds ?? null;
          queueMessages.push(body);
        }
      };
    })
  };
  await processQueueBatch(batch, env);
  return outcomes;
}

test("end-to-end single tag, multi tag, cancel tag, and unified content in Memos and Channel", async (t) => {
  const { env, tgCalls, memosCalls, queueMessages } = createHarness(t);

  await handleMessage({
    message_id: 10,
    chat: { id: 42 },
    from: { id: 99 },
    text: "今天研究了一下 Memos 的部署。"
  }, env);

  const kbMsg = tgCalls.find((c) => c.method === "sendMessage");
  assert.ok(kbMsg);
  const controlMsgId = 1000;

  // Select 技术 (4), 项目 (5), 工作 (6), then cancel 工作 (6)
  await handleCallback({
    id: "cb-1",
    from: { id: 99 },
    data: "t|4|single_10",
    message: { chat: { id: 42 }, message_id: controlMsgId }
  }, env);
  await handleCallback({
    id: "cb-2",
    from: { id: 99 },
    data: "t|5|single_10",
    message: { chat: { id: 42 }, message_id: controlMsgId }
  }, env);
  await handleCallback({
    id: "cb-3",
    from: { id: 99 },
    data: "t|6|single_10",
    message: { chat: { id: 42 }, message_id: controlMsgId }
  }, env);
  await handleCallback({
    id: "cb-4",
    from: { id: 99 },
    data: "t|6|single_10",
    message: { chat: { id: 42 }, message_id: controlMsgId }
  }, env);

  const lastEdit = tgCalls.filter((c) => c.method === "editMessageText").at(-1);
  assert.match(lastEdit.body.text, /已选标签：#技术 #项目/);
  assert.doesNotMatch(lastEdit.body.text, /#工作/);

  // Trigger PUBLIC sync
  await handleCallback({
    id: "cb-pub",
    from: { id: 99 },
    data: "v|PUB|single_10",
    message: { chat: { id: 42 }, message_id: controlMsgId }
  }, env);

  assert.equal(queueMessages.length, 1);
  const outcomes = await runQueueOnce(env, queueMessages, 1);
  assert.equal(outcomes[0].acked, true);

  const expectedContent = "今天研究了一下 Memos 的部署。\n\n#技术 #项目";
  const memoPost = memosCalls.find((c) => c.endpoint === "memos");
  const channelPost = tgCalls.find((c) => c.method === "sendMessage" && c.body.chat_id === env.CHANNEL_ID_PUBLIC);

  assert.equal(memoPost.body.content, expectedContent);
  assert.equal(memoPost.body.visibility, "PUBLIC");
  assert.equal(channelPost.body.text, expectedContent);
});

test("syncs normally without selecting any tags and preserves custom hashtags without duplicating existing ones", async (t) => {
  const { env, tgCalls, memosCalls, queueMessages } = createHarness(t);

  // Case A: Skip tags altogether
  await handleMessage({
    message_id: 20,
    chat: { id: 42 },
    from: { id: 99 },
    text: "纯文本无标签同步"
  }, env);
  await handleCallback({
    id: "cb-skip-prv",
    from: { id: 99 },
    data: "v|PRV|single_20",
    message: { chat: { id: 42 }, message_id: 1000 }
  }, env);

  // Case B: Existing #技术 + custom #个人笔记, select 技术(4) & 灵感(1)
  await handleMessage({
    message_id: 21,
    chat: { id: 42 },
    from: { id: 99 },
    text: "记录 #技术 和 #个人笔记"
  }, env);
  await handleCallback({
    id: "cb-b-1",
    from: { id: 99 },
    data: "t|4|single_21",
    message: { chat: { id: 42 }, message_id: 1001 }
  }, env);
  await handleCallback({
    id: "cb-b-2",
    from: { id: 99 },
    data: "t|1|single_21",
    message: { chat: { id: 42 }, message_id: 1001 }
  }, env);
  await handleCallback({
    id: "cb-b-pub",
    from: { id: 99 },
    data: "v|PUB|single_21",
    message: { chat: { id: 42 }, message_id: 1001 }
  }, env);

  await runQueueOnce(env, queueMessages, 1);

  const memoCalls = memosCalls.filter((c) => c.endpoint === "memos");
  const privateChannel = tgCalls.find((c) => c.method === "sendMessage" && c.body.chat_id === env.CHANNEL_ID_PRIVATE);
  const publicChannel = tgCalls.find((c) => c.method === "sendMessage" && c.body.chat_id === env.CHANNEL_ID_PUBLIC);

  assert.equal(memoCalls[0].body.content, "纯文本无标签同步");
  assert.equal(memoCalls[0].body.visibility, "PRIVATE");
  assert.equal(privateChannel.body.text, "纯文本无标签同步");

  assert.equal(memoCalls[1].body.content, "记录 #技术 和 #个人笔记\n\n#灵感");
  assert.equal(memoCalls[1].body.visibility, "PUBLIC");
  assert.equal(publicChannel.body.text, "记录 #技术 和 #个人笔记\n\n#灵感");
});

test("persists selected tags across Worker restarts and freezes job tags against duplicate callbacks and post-job mutations", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-memos-sync-"));
  const dbPath = path.join(tmpDir, "state.sqlite");
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Worker lifecycle 1: receive message + select tag 4 + duplicate callback
  const db1 = createSqliteD1(dbPath);
  const h1 = createHarness(t, { db: db1, keepDbOpen: true });

  await handleMessage({
    message_id: 30,
    chat: { id: 42 },
    from: { id: 99 },
    text: "持久化测试"
  }, h1.env);

  const dupQuery = {
    id: "cb-dup-1",
    from: { id: 99 },
    data: "t|4|single_30",
    message: { chat: { id: 42 }, message_id: 1000 }
  };
  await handleCallback(dupQuery, h1.env);
  // Duplicate delivery of the exact same callback_query must NOT toggle off or duplicate tag
  await handleCallback(dupQuery, h1.env);
  db1.close();

  // Worker lifecycle 2 (simulated cold restart with new DB connection, no migrations re-run)
  const db2 = createSqliteD1(dbPath, { migrate: false });
  const h2 = createHarness(t, { db: db2, keepDbOpen: true });

  await handleCallback({
    id: "cb-add-5",
    from: { id: 99 },
    data: "t|5|single_30",
    message: { chat: { id: 42 }, message_id: 1000 }
  }, h2.env);

  // Create job -> snapshots [4, 5]
  await handleCallback({
    id: "cb-go-pub",
    from: { id: 99 },
    data: "v|PUB|single_30",
    message: { chat: { id: 42 }, message_id: 1000 }
  }, h2.env);

  // Mutate session tags AFTER job creation -> must NOT affect created job!
  await handleCallback({
    id: "cb-late-mut",
    from: { id: 99 },
    data: "t|0|single_30",
    message: { chat: { id: 42 }, message_id: 1000 }
  }, h2.env);
  await handleCallback({
    id: "cb-late-remove",
    from: { id: 99 },
    data: "t|4|single_30",
    message: { chat: { id: 42 }, message_id: 1000 }
  }, h2.env);
  db2.close();

  // Worker lifecycle 3: execute queue
  const db3 = createSqliteD1(dbPath, { migrate: false });
  const h3 = createHarness(t, { db: db3 });
  h3.queueMessages.push(...h2.queueMessages);

  await runQueueOnce(h3.env, h3.queueMessages, 1);

  const memoPost = h3.memosCalls.find((c) => c.endpoint === "memos");
  const channelPost = h3.tgCalls.find((c) => c.method === "sendMessage" && c.body.chat_id === h3.env.CHANNEL_ID_PUBLIC);

  assert.equal(memoPost.body.content, "持久化测试\n\n#技术 #项目");
  assert.equal(channelPost.body.text, "持久化测试\n\n#技术 #项目");
});

test("collects pure-image album completely in visual order despite out-of-order concurrent arrival and syncs once", async (t) => {
  const { env, tgCalls, memosCalls, queueMessages } = createHarness(t, { settleMs: 30 });

  // Out-of-order concurrent delivery (103, 101, 102) with NO caption
  await Promise.all([
    handleMessage({
      message_id: 103,
      media_group_id: "13999888777",
      chat: { id: 42 },
      from: { id: 99 },
      photo: [{ file_id: "small_3" }, { file_id: "photo_3" }]
    }, env),
    handleMessage({
      message_id: 101,
      media_group_id: "13999888777",
      chat: { id: 42 },
      from: { id: 99 },
      photo: [{ file_id: "small_1" }, { file_id: "photo_1" }]
    }, env),
    handleMessage({
      message_id: 102,
      media_group_id: "13999888777",
      chat: { id: 42 },
      from: { id: 99 },
      photo: [{ file_id: "small_2" }, { file_id: "photo_2" }]
    }, env)
  ]);

  // Exactly ONE keyboard sent after album settled, showing 3 photos
  const keyboards = tgCalls.filter((c) => c.method === "sendMessage");
  assert.equal(keyboards.length, 1);
  assert.match(keyboards[0].body.text, /已收集 3 张图片/);

  // Select tag 11 (旅行) and sync PUBLIC
  await handleCallback({
    id: "cb-alb-tag",
    from: { id: 99 },
    data: "t|11|13999888777",
    message: { chat: { id: 42 }, message_id: 1000 }
  }, env);
  await handleCallback({
    id: "cb-alb-pub",
    from: { id: 99 },
    data: "v|PUB|13999888777",
    message: { chat: { id: 42 }, message_id: 1000 }
  }, env);

  await runQueueOnce(env, queueMessages, 1);

  // Memos: 1 memo, 3 attachments uploaded in 101 -> 102 -> 103 order, tag appended once
  const getFiles = tgCalls.filter((c) => c.method === "getFile").map((c) => c.body.file_id);
  assert.deepEqual(getFiles, ["photo_1", "photo_2", "photo_3"]);

  const memoCalls = memosCalls.filter((c) => c.endpoint === "memos");
  assert.equal(memoCalls.length, 1);
  assert.equal(memoCalls[0].body.content, "#旅行");
  assert.equal(memoCalls[0].body.attachments.length, 3);

  // Telegram channel: 1 sendMediaGroup in exact order, caption only on first item
  const mediaGroups = tgCalls.filter((c) => c.method === "sendMediaGroup");
  assert.equal(mediaGroups.length, 1);
  assert.deepEqual(mediaGroups[0].body.media, [
    { type: "photo", media: "photo_1", caption: "#旅行" },
    { type: "photo", media: "photo_2" },
    { type: "photo", media: "photo_3" }
  ]);
});

test("waits for late album parts before confirming sync if clicked early", async (t) => {
  const { env, tgCalls, memosCalls, queueMessages } = createHarness(t, { settleMs: 60 });

  // First photo arrives and triggers keyboard after 60ms
  await handleMessage({
    message_id: 201,
    media_group_id: "album_early_click",
    chat: { id: 42 },
    from: { id: 99 },
    caption: "分批相册",
    photo: [{ file_id: "p1" }]
  }, env);

  // Second photo arrives just before user clicks sync
  const secondPhotoPromise = handleMessage({
    message_id: 202,
    media_group_id: "album_early_click",
    chat: { id: 42 },
    from: { id: 99 },
    photo: [{ file_id: "p2" }]
  }, env);

  // Give second photo a tick to hit DB, then user clicks sync immediately before settleMs elapses
  await new Promise((r) => setTimeout(r, 10));
  await handleCallback({
    id: "cb-early-click",
    from: { id: 99 },
    data: "v|PUB|album_early_click",
    message: { chat: { id: 42 }, message_id: 1000 }
  }, env);
  await secondPhotoPromise;

  await runQueueOnce(env, queueMessages, 1);

  const mediaGroup = tgCalls.find((c) => c.method === "sendMediaGroup");
  assert.deepEqual(mediaGroup.body.media.map((m) => m.media), ["p1", "p2"]);
  const memoPost = memosCalls.find((c) => c.endpoint === "memos");
  assert.equal(memoPost.body.attachments.length, 2);
});

test("handles oversized media group caption (>1024 chars) without dropping body or tags and avoids duplicating media on retry", async (t) => {
  const longBody = "这是一段很长的笔记正文。".repeat(120); // > 1300 chars
  let failFollowupOnce = true;

  const { env, tgCalls, memosCalls, queueMessages } = createHarness(t, {
    onFetch(url, body) {
      if (url.endsWith("/sendMessage") && body.chat_id === "-1001111111" && failFollowupOnce) {
        failFollowupOnce = false;
        return Response.json({ ok: false, error_code: 503, description: "Service Unavailable" }, { status: 503 });
      }
      return null;
    }
  });

  await handleMessage({
    message_id: 301,
    media_group_id: "album_long_cap",
    chat: { id: 42 },
    from: { id: 99 },
    caption: longBody,
    photo: [{ file_id: "lp1" }]
  }, env);
  await handleMessage({
    message_id: 302,
    media_group_id: "album_long_cap",
    chat: { id: 42 },
    from: { id: 99 },
    photo: [{ file_id: "lp2" }]
  }, env);

  await handleCallback({
    id: "cb-long-tag",
    from: { id: 99 },
    data: "t|4|album_long_cap",
    message: { chat: { id: 42 }, message_id: 1000 }
  }, env);
  await handleCallback({
    id: "cb-long-pub",
    from: { id: 99 },
    data: "v|PUB|album_long_cap",
    message: { chat: { id: 42 }, message_id: 1000 }
  }, env);

  // Attempt 1: Memos succeeds, sendMediaGroup succeeds (msg 1001), follow-up sendMessage fails 503
  const attempt1 = await runQueueOnce(env, queueMessages, 1);
  assert.equal(attempt1[0].retried, true);
  assert.equal(memosCalls.filter((c) => c.endpoint === "memos").length, 1);
  assert.equal(tgCalls.filter((c) => c.method === "sendMediaGroup").length, 1);

  // Attempt 2: Memos skipped, sendMediaGroup skipped (uses saved channel_media_message_id), follow-up sendMessage succeeds
  const attempt2 = await runQueueOnce(env, queueMessages, 2);
  assert.equal(attempt2[0].acked, true);

  assert.equal(memosCalls.filter((c) => c.endpoint === "memos").length, 1);
  const mediaGroups = tgCalls.filter((c) => c.method === "sendMediaGroup");
  assert.equal(mediaGroups.length, 1);
  assert.equal("caption" in mediaGroups[0].body.media[0], false);

  const channelMessages = tgCalls.filter((c) => c.method === "sendMessage" && c.body.chat_id === env.CHANNEL_ID_PUBLIC);
  assert.equal(channelMessages.length, 2); // 1 failed + 1 succeeded
  const succeededChannelMsg = channelMessages[1].body;
  const expectedFullText = `${longBody}\n\n#技术`;

  assert.equal(succeededChannelMsg.text, expectedFullText);
  assert.ok(Number.isInteger(succeededChannelMsg.reply_to_message_id) && succeededChannelMsg.reply_to_message_id > 1000);
  assert.equal(memosCalls.find((c) => c.endpoint === "memos").body.content, expectedFullText);
});

test("splits >4096 char media group follow-up text without losing any body or tags", async (t) => {
  const { env, tgCalls, memosCalls, queueMessages } = createHarness(t);
  const veryLongBody = "超长段落测试内容。".repeat(520); // 4680 chars (>4096)

  await handleMessage({
    message_id: 351,
    media_group_id: "album_ultra_long",
    chat: { id: 42 },
    from: { id: 99 },
    caption: veryLongBody,
    photo: [{ file_id: "ulp1" }]
  }, env);
  await handleMessage({
    message_id: 352,
    media_group_id: "album_ultra_long",
    chat: { id: 42 },
    from: { id: 99 },
    photo: [{ file_id: "ulp2" }]
  }, env);

  await handleCallback({
    id: "cb-ultra-tag",
    from: { id: 99 },
    data: "t|4|album_ultra_long",
    message: { chat: { id: 42 }, message_id: 1000 }
  }, env);
  await handleCallback({
    id: "cb-ultra-pub",
    from: { id: 99 },
    data: "v|PUB|album_ultra_long",
    message: { chat: { id: 42 }, message_id: 1000 }
  }, env);

  await runQueueOnce(env, queueMessages, 1);

  const channelMsgs = tgCalls.filter((c) => c.method === "sendMessage" && c.body.chat_id === env.CHANNEL_ID_PUBLIC);
  assert.ok(channelMsgs.length >= 2);
  for (const msg of channelMsgs) {
    assert.ok(msg.body.text.length <= 4096);
  }
  const reconstructed = channelMsgs.map((m) => m.body.text).join("");
  assert.equal(reconstructed, `${veryLongBody}\n\n#技术`);
  assert.equal(
    memosCalls.find((c) => c.endpoint === "memos").body.content,
    `${veryLongBody}\n\n#技术`
  );
});

test("preserves independent target retry when Memos fails transiently and Channel succeeds, keeping frozen tags", async (t) => {
  let failMemosOnce = true;

  const { env, tgCalls, memosCalls, queueMessages } = createHarness(t, {
    onFetch(url) {
      if (url.endsWith("/api/v1/memos") && failMemosOnce) {
        failMemosOnce = false;
        return new Response("upstream timeout", { status: 503 });
      }
      return null;
    }
  });

  await handleMessage({
    message_id: 401,
    chat: { id: 42 },
    from: { id: 99 },
    text: "独立重试测试"
  }, env);
  await handleCallback({
    id: "cb-retry-t1",
    from: { id: 99 },
    data: "t|2|single_401",
    message: { chat: { id: 42 }, message_id: 1000 }
  }, env);
  await handleCallback({
    id: "cb-retry-prv",
    from: { id: 99 },
    data: "v|PRV|single_401",
    message: { chat: { id: 42 }, message_id: 1000 }
  }, env);

  const attempt1 = await runQueueOnce(env, queueMessages, 1);
  assert.equal(attempt1[0].retried, true);
  assert.equal(tgCalls.filter((c) => c.method === "sendMessage" && c.body.chat_id === env.CHANNEL_ID_PRIVATE).length, 1);

  const attempt2 = await runQueueOnce(env, queueMessages, 2);
  assert.equal(attempt2[0].acked, true);

  // Channel was NOT called a second time
  const privatePosts = tgCalls.filter((c) => c.method === "sendMessage" && c.body.chat_id === env.CHANNEL_ID_PRIVATE);
  assert.equal(privatePosts.length, 1);
  assert.equal(privatePosts[0].body.text, "独立重试测试\n\n#待办");

  // Memos retry succeeded with identical tags and PRIVATE visibility
  const memoPosts = memosCalls.filter((c) => c.endpoint === "memos");
  assert.equal(memoPosts.length, 2);
  assert.equal(memoPosts[1].body.content, "独立重试测试\n\n#待办");
  assert.equal(memoPosts[1].body.visibility, "PRIVATE");
});

test("supports non-blocking partial failure and minimal additive migration over historical D1 rows", async (t) => {
  const db = createSqliteD1(":memory:", { migrate: false });
  applyMigrations(db.sqlite, "0001_initial.sql");

  // Insert historical v1/v2 session & job rows prior to 0002 migration
  db.sqlite.exec(`
    INSERT INTO sync_sessions (session_id, chat_id, source_message_id, content, created_at, expires_at)
    VALUES ('single_old', '42', 1, '历史记录内容', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
    INSERT INTO sync_jobs (job_id, session_id, visibility, status, memos_status, channel_status, result_chat_id, result_message_id, created_at, updated_at)
    VALUES ('job-old', 'single_old', 'PUBLIC', 'success', 'success', 'success', '42', 2, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  `);

  // Apply 0002 additive migration
  applyMigrations(db.sqlite);

  const oldJob = await db.prepare("SELECT * FROM sync_jobs WHERE job_id = ?").bind("job-old").first();
  assert.equal(oldJob.status, "success");
  assert.equal(oldJob.selected_tags, "[]");

  const { env, tgCalls, memosCalls, queueMessages } = createHarness(t, {
    db,
    onFetch(url) {
      if (url.endsWith("/api/v1/memos")) {
        return new Response("unauthorized", { status: 401 });
      }
      return null;
    }
  });

  // Historical session can still be triggered via legacy vis|PRIVATE|... callback without blocking Channel on Memos 401
  await handleCallback({
    id: "cb-legacy-vis",
    from: { id: 99 },
    data: "vis|PRIVATE|single_old",
    message: { chat: { id: 42 }, message_id: 90 }
  }, env);

  const outcomes = await runQueueOnce(env, queueMessages, 1);
  assert.equal(outcomes[0].acked, true);
  assert.equal(memosCalls.filter((c) => c.endpoint === "memos").length, 1);
  const privateChannel = tgCalls.find((c) => c.method === "sendMessage" && c.body.chat_id === env.CHANNEL_ID_PRIVATE);
  assert.equal(privateChannel.body.text, "历史记录内容");

  const newJob = await db.prepare("SELECT * FROM sync_jobs WHERE session_id = ? AND visibility = ?").bind("single_old", "PRIVATE").first();
  assert.equal(newJob.status, "partial");
  assert.equal(newJob.memos_status, "failed");
  assert.equal(newJob.channel_status, "success");

  // Sanity: all 12 built-in tags can be toggled via webhook HTTP route
  const req = new Request("https://worker.example/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        message_id: 500,
        chat: { id: 42 },
        from: { id: 99 },
        text: "Webhook 全量标签测试"
      }
    })
  });
  const pending = [];
  const res = await worker.fetch(req, env, { waitUntil(p) { pending.push(p); } });
  assert.equal(res.status, 200);
  await Promise.all(pending);

  for (const tag of BUILTIN_TAGS) {
    await handleCallback({
      id: `cb-all-${tag.index}`,
      from: { id: 99 },
      data: `t|${tag.index}|single_500`,
      message: { chat: { id: 42 }, message_id: 1002 }
    }, env);
  }
  const session500 = await db.prepare("SELECT selected_tags FROM sync_sessions WHERE session_id = ?").bind("single_500").first();
  assert.deepEqual(JSON.parse(session500.selected_tags), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});
