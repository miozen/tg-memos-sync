import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, formatPublicError, isRetryableStatus } from "../src/lib/errors.js";
import { sanitize } from "../src/lib/logger.js";

test("classifies retryable statuses", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(401), false);
});

test("formats API errors without unbounded response text", () => {
  const value = formatPublicError(new ApiError("Memos", 401, "unauthorized", false));
  assert.match(value, /HTTP 401/);
});

test("redacts bot tokens and bearer tokens", () => {
  const value = sanitize("https://api.telegram.org/bot123:ABC_def/getMe Bearer secret");
  assert.doesNotMatch(value, /ABC_def|Bearer secret/);
});
