import dayjs from "dayjs";

export function cleanText(text = "") {
  return text.replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
}

export function toIsoOrNull(value) {
  const parsed = dayjs(value);
  if (!parsed.isValid()) return null;
  return parsed.toISOString();
}

export function eventStatus(isoDate, now = dayjs()) {
  const date = dayjs(isoDate);
  if (!date.isValid()) return "unknown";
  if (date.isAfter(now)) return "upcoming";
  return "recent";
}

export function impactScoreFromText(text) {
  const t = (text || "").toLowerCase();
  if (/fomc|interest rate|cpi|inflation|nfp|employment|boj|policy/.test(t)) return "high";
  if (/ppi|minutes|outlook|etf|regulation|tariff/.test(t)) return "medium";
  return "low";
}

export function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
