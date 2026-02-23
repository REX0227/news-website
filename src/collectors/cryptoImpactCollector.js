import dayjs from "dayjs";
import { fetchRssItems } from "../lib/rss.js";
import { cleanText, impactScoreFromText } from "../lib/utils.js";

const FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss"
];

const KEYWORDS = /(etf|sec|fomc|fed|boj|inflation|cpi|nfp|rate|tariff|liquidat|hack|exploit|regulation|stablecoin|bank|bond|treasury|whale|outflow|inflow)/i;

function classify(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  if (/etf|inflow|outflow/.test(text)) return "flow";
  if (/sec|regulation|policy|law|stablecoin/.test(text)) return "regulation";
  if (/hack|exploit|liquidat|whale/.test(text)) return "risk";
  if (/fed|fomc|boj|cpi|nfp|rate|tariff/.test(text)) return "macro";
  return "market";
}

export async function collectCryptoImpactSignals() {
  const collected = [];

  for (const feed of FEEDS) {
    try {
      const items = await fetchRssItems(feed, 30);
      collected.push(
        ...items
          .filter((item) => KEYWORDS.test(`${item.title} ${item.description}`))
          .map((item) => ({
            id: `signal-${Buffer.from(item.link).toString("base64url").slice(0, 16)}`,
            title: cleanText(item.title),
            time: item.pubDate || dayjs().toISOString(),
            category: classify(item.title, item.description),
            impact: impactScoreFromText(`${item.title} ${item.description}`),
            summary: cleanText(item.description).slice(0, 240),
            source: item.link
          }))
      );
    } catch {
      continue;
    }
  }

  const unique = new Map();
  for (const item of collected) {
    if (!unique.has(item.source)) unique.set(item.source, item);
  }

  return [...unique.values()]
    .sort((a, b) => dayjs(b.time).valueOf() - dayjs(a.time).valueOf())
    .slice(0, 30);
}
