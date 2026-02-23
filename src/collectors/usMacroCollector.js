import { load } from "cheerio";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { cleanText, impactScoreFromText } from "../lib/utils.js";

dayjs.extend(customParseFormat);

const BLS_RELEASES = [
  {
    title: "US CPI Release",
    url: "https://www.bls.gov/schedule/news_release/cpi.htm",
    eventType: "inflation"
  },
  {
    title: "US Nonfarm Payrolls (Employment Situation)",
    url: "https://www.bls.gov/schedule/news_release/empsit.htm",
    eventType: "employment"
  },
  {
    title: "US PPI Release",
    url: "https://www.bls.gov/schedule/news_release/ppi.htm",
    eventType: "inflation"
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

function parseDate(dateText, timeText = "08:30 AM") {
  const normalizedDate = cleanText(dateText)
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedTime = cleanText(timeText || "08:30 AM");
  const dt = dayjs(
    `${normalizedDate} ${normalizedTime}`,
    [
      "MMM D YYYY h:mm A",
      "MMMM D YYYY h:mm A",
      "MMM D, YYYY h:mm A",
      "MMMM D, YYYY h:mm A"
    ],
    true
  );

  return dt.isValid() ? dt.toISOString() : null;
}

function parseBlsTable(html, release) {
  const $ = load(html);
  const items = [];

  $("table tr").each((_, row) => {
    const cells = $(row)
      .find("th,td")
      .toArray()
      .map((cell) => cleanText($(cell).text()));

    if (cells.length < 3) return;

    const period = cells[0];
    const dateText = cells[1];
    const timeText = cells[2];
    if (!dateText || /date/i.test(dateText)) return;

    const iso = parseDate(dateText, timeText);
    if (!iso) return;

    items.push({
      id: `us-${release.eventType}-${dayjs(iso).format("YYYYMMDD")}`,
      country: "US",
      title: release.title,
      eventType: release.eventType,
      period,
      datetime: iso,
      timezone: "America/New_York",
      importance: impactScoreFromText(release.title),
      impactHint: "可能影響美元流動性與風險資產波動（含 BTC/ETH）。",
      source: release.url
    });
  });

  return items;
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
        title: "FOMC Policy Decision",
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

  for (const release of BLS_RELEASES) {
    try {
      const response = await fetch(release.url, {
        headers: { "User-Agent": "crypto-macro-schedule-bot/1.0" }
      });
      if (!response.ok) continue;
      const html = await response.text();
      out.push(...parseBlsTable(html, release));
    } catch {
      continue;
    }
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

  return out;
}
