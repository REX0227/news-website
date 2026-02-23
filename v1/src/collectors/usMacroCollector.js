import { load } from "cheerio";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { cleanText } from "../lib/utils.js";

dayjs.extend(customParseFormat);

const BLS_ICS_URL = "https://www.bls.gov/schedule/news_release/bls.ics";

const BLS_TARGETS = [
  {
    keyword: /consumer price index/i,
    title: "美國 CPI 公布",
    eventType: "cpi",
    importance: "high",
    source: "https://www.bls.gov/schedule/news_release/cpi.htm"
  },
  {
    keyword: /employment situation/i,
    title: "美國非農就業（NFP）公布",
    eventType: "nfp",
    importance: "high",
    source: "https://www.bls.gov/schedule/news_release/empsit.htm"
  },
  {
    keyword: /producer price index/i,
    title: "美國 PPI 公布",
    eventType: "ppi",
    importance: "medium",
    source: "https://www.bls.gov/schedule/news_release/ppi.htm"
  }
];

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

function parseIcsDate(raw) {
  if (!raw) return null;
  const value = raw.trim();
  const dt = dayjs(value, ["YYYYMMDDTHHmmss[Z]", "YYYYMMDDTHHmmss"], true);
  return dt.isValid() ? dt.toISOString() : null;
}

function unfoldIcs(icsText) {
  return icsText.replace(/\r?\n[ \t]/g, "");
}

function parseBlsEventsFromIcs(icsText) {
  const normalized = unfoldIcs(icsText);
  const blocks = normalized.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  const events = [];

  for (const block of blocks) {
    const summary = cleanText((block.match(/SUMMARY:(.*)/)?.[1] || "").replace(/\\,/g, ","));
    const dtStartRaw = block.match(/DTSTART(?:;[^:]+)?:([0-9TZ]+)/)?.[1];
    const datetime = parseIcsDate(dtStartRaw);
    if (!summary || !datetime) continue;

    const target = BLS_TARGETS.find((item) => item.keyword.test(summary));
    if (!target) continue;

    events.push({
      id: `us-${target.eventType}-${dayjs(datetime).format("YYYYMMDD")}`,
      country: "US",
      title: target.title,
      eventType: target.eventType,
      period: dayjs(datetime).format("YYYY-MM"),
      datetime,
      timezone: "America/New_York",
      importance: target.importance,
      impactHint: "可能影響美元流動性與風險資產波動（含 BTC/ETH）。",
      source: target.source
    });
  }

  return events;
}

function parseFomcMeetings(html) {
  const text = cleanText(load(html).text());
  const year = dayjs().year();
  const sectionRegex = new RegExp(`${year} FOMC Meetings([\\s\\S]*?)(?:${year - 1} FOMC Meetings|${year + 1} FOMC Meetings|FOMC Search)`, "i");
  const sectionMatch = text.match(sectionRegex);
  const sectionText = sectionMatch?.[1] || text;

  const ranges = [...sectionText.matchAll(/(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\/[A-Za-z]+)?\s+(\d{1,2})-(\d{1,2})\*?/gi)];

  const events = ranges
    .map((match, index) => {
      const monthKey = match[1].toLowerCase().replace(/\./g, "");
      const month = MONTH_MAP[monthKey];
      const day = Number(match[3]);
      if (!month || Number.isNaN(day)) return null;

      const iso = dayjs(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} 14:00`, "YYYY-MM-DD HH:mm", true).toISOString();

      return {
        id: `us-fomc-${year}-${String(index + 1).padStart(2, "0")}`,
        country: "US",
        title: "FOMC 利率決議",
        eventType: "central-bank",
        datetime: iso,
        timezone: "America/New_York",
        importance: "high",
        impactHint: "FOMC 利率與措辭常造成加密市場瞬間波動。",
        source: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
      };
    })
    .filter(Boolean);

  return events;
}

export async function collectUsMacroEvents() {
  const out = [];

  try {
    const response = await fetch(BLS_ICS_URL, {
      headers: { "User-Agent": "crypto-macro-schedule-bot/1.0" }
    });
    if (response.ok) {
      const ics = await response.text();
      out.push(...parseBlsEventsFromIcs(ics));
    }
  } catch {
    // ignore
  }

  try {
    const fomcResponse = await fetch("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", {
      headers: { "User-Agent": "crypto-macro-schedule-bot/1.0" }
    });
    if (fomcResponse.ok) {
      const html = await fomcResponse.text();
      out.push(...parseFomcMeetings(html));
    }
  } catch {
    // ignore
  }

  const unique = new Map();
  for (const event of out) {
    const key = `${event.eventType}-${event.datetime}`;
    if (!unique.has(key)) unique.set(key, event);
  }

  return [...unique.values()];
}
