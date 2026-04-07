import { load } from "cheerio";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { cleanText } from "../lib/utils.js";

dayjs.extend(customParseFormat);

const BOJ_URL = "https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm";

const MONTH_MAP = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
};

function parseBojMeetingCell(text, year) {
  const cleaned = cleanText(text).replace(/\./g, "");
  const first = cleaned.match(/(Jan|January|Feb|February|Mar|March|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December)\s*(\d{1,2})/i);
  if (!first) return null;

  const monthKey = first[1].toLowerCase();
  const firstMonth = MONTH_MAP[monthKey];
  if (!firstMonth) return null;

  const dayMatches = [...cleaned.matchAll(/(\d{1,2})\s*\(/g)].map((m) => Number(m[1]));
  if (dayMatches.length === 0) return null;

  const decisionDay = dayMatches[dayMatches.length - 1];
  const iso = dayjs(`${year}-${String(firstMonth).padStart(2, "0")}-${String(decisionDay).padStart(2, "0")} 12:00`, "YYYY-MM-DD HH:mm", true);

  return iso.isValid() ? iso.toISOString() : null;
}

export async function collectJapanMacroEvents() {
  const response = await fetch(BOJ_URL, {
    headers: { "User-Agent": "crypto-macro-schedule-bot/1.0" },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) return [];

  const html = await response.text();
  const $ = load(html);
  const currentYear = String(dayjs().year());
  const out = [];

  let inCurrentYear = false;

  $("h2, h3, table tr").each((_, node) => {
    const tag = node.tagName?.toLowerCase();
    const text = cleanText($(node).text());

    if (tag === "h2" || tag === "h3") {
      if (text === currentYear) {
        inCurrentYear = true;
      } else if (/^\d{4}$/.test(text) && text !== currentYear) {
        inCurrentYear = false;
      }
      return;
    }

    if (!inCurrentYear || tag !== "tr") return;

    const cells = $(node)
      .find("td")
      .toArray()
      .map((cell) => cleanText($(cell).text()));

    if (cells.length === 0) return;

    const decisionDate = parseBojMeetingCell(cells[0], Number(currentYear));
    if (!decisionDate) return;

    const id = `jp-boj-${dayjs(decisionDate).format("YYYYMMDD")}`;
    out.push({
      id,
      country: "JP",
      title: "日本央行（BOJ）政策會議",
      eventType: "central-bank",
      datetime: decisionDate,
      timezone: "Asia/Tokyo",
      importance: "high",
      impactHint: "日圓與利差預期改變，常透過美元指數與風險偏好影響加密市場。",
      source: BOJ_URL
    });
  });

  return out;
}
