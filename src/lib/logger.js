export function sanitize(value) {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value !== "string") return value;
  return value
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 1000);
}

export function jsonLog(level, event, fields = {}) {
  const safe = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, sanitize(value)]));
  console[level](JSON.stringify({ event, ...safe }));
}
