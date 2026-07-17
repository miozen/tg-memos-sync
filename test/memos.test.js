import test from "node:test";
import assert from "node:assert/strict";
import { createMemo } from "../src/adapters/memos.js";

test("uploads Telegram images through the Memos attachments API", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/getFile")) {
      return Response.json({ ok: true, result: { file_path: "photos/image.jpg" } });
    }
    if (String(url).includes("/file/bot")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" }
      });
    }
    if (String(url).endsWith("/api/v1/attachments")) {
      return Response.json({
        name: "attachments/abc",
        filename: "tg_image.jpg",
        type: "image/jpeg",
        size: "3"
      });
    }
    if (String(url).endsWith("/api/v1/memos")) {
      return Response.json({ name: "memos/abc" });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const env = {
    TELEGRAM_TOKEN: "test-token",
    MEMOS_BASE_URL: "https://memos.example.com",
    MEMOS_TOKEN: "test-memos-token"
  };

  await createMemo(env, "image note", "PUBLIC", ["file-1"]);

  const attachmentCall = calls.find((call) => call.url.endsWith("/api/v1/attachments"));
  const attachmentBody = JSON.parse(attachmentCall.options.body);
  assert.equal(attachmentBody.content, "AQID");
  assert.equal(attachmentBody.type, "image/jpeg");

  const memoCall = calls.find((call) => call.url.endsWith("/api/v1/memos"));
  const memoBody = JSON.parse(memoCall.options.body);
  assert.equal(
    memoBody.content,
    "image note\n\n![image](https://memos.example.com/file/attachments/abc/tg_image.jpg)"
  );
  assert.equal(memoBody.attachments[0].name, "attachments/abc");
  assert.equal("resources" in memoBody, false);
});

test("preserves a valid image MIME type returned by Telegram", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/getFile")) {
      return Response.json({ ok: true, result: { file_path: "photos/image.webp" } });
    }
    if (String(url).includes("/file/bot")) {
      return new Response(new Uint8Array([1]), {
        headers: { "Content-Type": "image/webp" }
      });
    }
    if (String(url).endsWith("/api/v1/attachments")) {
      return Response.json({
        name: "attachments/webp",
        filename: "tg_image.jpg",
        type: "image/webp"
      });
    }
    if (String(url).endsWith("/api/v1/memos")) {
      return Response.json({ name: "memos/webp" });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await createMemo({
    TELEGRAM_TOKEN: "test-token",
    MEMOS_BASE_URL: "https://memos.example.com/",
    MEMOS_TOKEN: "test-memos-token"
  }, "", "PRIVATE", ["file-webp"]);

  const attachmentCall = calls.find((call) => call.url.endsWith("/api/v1/attachments"));
  assert.equal(JSON.parse(attachmentCall.options.body).type, "image/webp");

  const memoCall = calls.find((call) => call.url.endsWith("/api/v1/memos"));
  assert.equal(
    JSON.parse(memoCall.options.body).content,
    "![image](https://memos.example.com/file/attachments/webp/tg_image.jpg)"
  );
});
