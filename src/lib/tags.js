export const BUILTIN_TAGS = Object.freeze([
  Object.freeze({ index: 0, name: "日常", hashtag: "#日常" }),
  Object.freeze({ index: 1, name: "灵感", hashtag: "#灵感" }),
  Object.freeze({ index: 2, name: "待办", hashtag: "#待办" }),
  Object.freeze({ index: 3, name: "资料", hashtag: "#资料" }),
  Object.freeze({ index: 4, name: "技术", hashtag: "#技术" }),
  Object.freeze({ index: 5, name: "项目", hashtag: "#项目" }),
  Object.freeze({ index: 6, name: "工作", hashtag: "#工作" }),
  Object.freeze({ index: 7, name: "财务", hashtag: "#财务" }),
  Object.freeze({ index: 8, name: "家族", hashtag: "#家族" }),
  Object.freeze({ index: 9, name: "家庭", hashtag: "#家庭" }),
  Object.freeze({ index: 10, name: "健康", hashtag: "#健康" }),
  Object.freeze({ index: 11, name: "旅行", hashtag: "#旅行" })
]);

export function isValidTagIndex(index) {
  return Number.isInteger(index) && index >= 0 && index < BUILTIN_TAGS.length;
}

export function getTagByIndex(index) {
  return isValidTagIndex(index) ? BUILTIN_TAGS[index] : null;
}

export function normalizeTagIndices(indices) {
  if (!Array.isArray(indices)) return [];
  const unique = new Set();
  for (const raw of indices) {
    const num = Number(raw);
    if (isValidTagIndex(num)) unique.add(num);
  }
  return [...unique].sort((a, b) => a - b);
}

export function parseSelectedTags(raw) {
  if (Array.isArray(raw)) return normalizeTagIndices(raw);
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    return normalizeTagIndices(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function serializeSelectedTags(indices) {
  return JSON.stringify(normalizeTagIndices(indices));
}

export function toggleTagIndex(currentIndices, tagIndex) {
  if (!isValidTagIndex(tagIndex)) return normalizeTagIndices(currentIndices);
  const next = new Set(normalizeTagIndices(currentIndices));
  if (next.has(tagIndex)) next.delete(tagIndex);
  else next.add(tagIndex);
  return [...next].sort((a, b) => a - b);
}

export function formatSelectedTags(indices) {
  return normalizeTagIndices(indices)
    .map((index) => BUILTIN_TAGS[index].hashtag)
    .join(" ");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasHashtag(text, tagName) {
  if (!text || !tagName) return false;
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_/:])#${escapeRegExp(tagName)}(?![\\p{L}\\p{N}_-])`,
    "u"
  );
  return pattern.test(text);
}

export function composeContent(rawContent, selectedIndices) {
  const base = String(rawContent || "").trim();
  const tagsToAppend = normalizeTagIndices(selectedIndices)
    .map((index) => BUILTIN_TAGS[index])
    .filter((tag) => !hasHashtag(base, tag.name))
    .map((tag) => tag.hashtag);

  if (!tagsToAppend.length) return base;
  if (!base) return tagsToAppend.join(" ");
  return `${base}\n\n${tagsToAppend.join(" ")}`;
}
