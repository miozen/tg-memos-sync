import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_TAGS,
  composeContent,
  formatSelectedTags,
  hasHashtag,
  parseSelectedTags,
  toggleTagIndex
} from "../src/lib/tags.js";
import { buildControlPayload } from "../src/adapters/telegram.js";

test("defines all 12 built-in tags with stable indices and #hashtag format", () => {
  const expected = ["日常", "灵感", "待办", "资料", "技术", "项目", "工作", "财务", "家族", "家庭", "健康", "旅行"];
  assert.equal(BUILTIN_TAGS.length, 12);
  assert.deepEqual(BUILTIN_TAGS.map((tag) => tag.name), expected);
  assert.deepEqual(BUILTIN_TAGS.map((tag) => tag.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(BUILTIN_TAGS.map((tag) => tag.hashtag), expected.map((name) => `#${name}`));
});

test("builds inline keyboard with 12 tags, selection states, <=64-byte callback_data, and no confirm/skip button", () => {
  const payload = buildControlPayload("13894561234567890", [4, 5], 3);
  const buttons = payload.reply_markup.inline_keyboard.flat();

  assert.equal(buttons.length, 14);
  const tagButtons = buttons.slice(0, 12);
  const actionButtons = buttons.slice(12);

  assert.equal(tagButtons[4].text, "✅ 技术");
  assert.equal(tagButtons[5].text, "✅ 项目");
  assert.equal(tagButtons[0].text, "⬜ 日常");

  assert.equal(actionButtons[0].callback_data, "v|PUB|13894561234567890");
  assert.equal(actionButtons[1].callback_data, "v|PRV|13894561234567890");
  assert.equal(buttons.some((btn) => /确认|跳过/.test(btn.text)), false);

  for (const btn of buttons) {
    assert.ok(Buffer.byteLength(btn.callback_data, "utf8") <= 64, `callback_data too long: ${btn.callback_data}`);
  }
});

test("supports toggling single, multiple, and cancelling tags deterministically", () => {
  let selected = [];
  selected = toggleTagIndex(selected, 4);
  assert.deepEqual(selected, [4]);

  selected = toggleTagIndex(selected, 5);
  assert.deepEqual(selected, [4, 5]);
  assert.equal(formatSelectedTags(selected), "#技术 #项目");

  selected = toggleTagIndex(selected, 4);
  assert.deepEqual(selected, [5]);
  assert.equal(formatSelectedTags(selected), "#项目");

  assert.deepEqual(parseSelectedTags("[5, 4, 5, 99, -1]"), [4, 5]);
});

test("composes final content according to spec without duplicating existing tags and preserves custom hashtags", () => {
  assert.equal(
    composeContent("今天研究了一下 Memos 的部署。", [4, 5]),
    "今天研究了一下 Memos 的部署。\n\n#技术 #项目"
  );

  // Skipped tags -> raw text preserved
  assert.equal(
    composeContent("今天研究了一下 Memos 的部署。", []),
    "今天研究了一下 Memos 的部署。"
  );

  // Already contains #技术 -> only #项目 appended; custom hashtag preserved
  assert.equal(
    composeContent("今天研究 #技术 和 #自定义标签 的部署。", [4, 5]),
    "今天研究 #技术 和 #自定义标签 的部署。\n\n#项目"
  );

  // Similar prefix custom hashtag #技术栈 must NOT suppress #技术
  assert.equal(hasHashtag("聊聊 #技术栈", "技术"), false);
  assert.equal(hasHashtag("聊聊 #技术", "技术"), true);
  assert.equal(
    composeContent("聊聊 #技术栈", [4]),
    "聊聊 #技术栈\n\n#技术"
  );

  // Pure media (empty text) with selected tags
  assert.equal(composeContent("", [4, 5]), "#技术 #项目");
  assert.equal(composeContent("", []), "");
});
