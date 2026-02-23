import dayjs from "dayjs";
import { createHash } from "node:crypto";
import { fetchRssItems } from "../lib/rss.js";

const RISK_FEEDS = [
  "https://news.google.com/rss/search?q=(trump%20tariff%20policy%20crypto)%20OR%20(geopolitical%20war%20crypto)&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=(fed%20rate%20policy%20crypto)%20OR%20(boj%20policy%20crypto)&hl=en-US&gl=US&ceid=US:en"
];

const RISK_KEYWORDS = /(trump|tariff|war|geopolitic|conflict|sanction|fed|fomc|boj|rate|inflation|oil|middle east|china|russia|ukraine)/i;

function detectRiskType(text) {
  if (/trump|tariff|sanction|trade/.test(text)) return "政策/貿易";
  if (/war|conflict|missile|middle east|ukraine|russia/.test(text)) return "地緣政治";
  if (/fed|fomc|boj|rate|inflation/.test(text)) return "貨幣政策";
  if (/oil|energy/.test(text)) return "能源價格";
  return "宏觀風險";
}

function impactAndBias(text) {
  const bearish = /tariff|war|conflict|sanction|oil surge|inflation rise|rate hike/.test(text);
  const bullish = /ceasefire|rate cut|easing|deal/.test(text);

  if (bearish && !bullish) return { cryptoImpact: "偏空壓力上升", shortTermBias: "偏跌" };
  if (bullish && !bearish) return { cryptoImpact: "風險偏好回升", shortTermBias: "偏漲" };
  return { cryptoImpact: "不確定性上升", shortTermBias: "震盪" };
}

export async function collectGlobalRiskSignals() {
  const collected = [];

  for (const feed of RISK_FEEDS) {
    try {
      const items = await fetchRssItems(feed, 20);
      for (const item of items) {
        const text = `${item.title} ${item.description}`.toLowerCase();
        if (!RISK_KEYWORDS.test(text)) continue;

        const riskType = detectRiskType(text);
        const { cryptoImpact, shortTermBias } = impactAndBias(text);

        collected.push({
          id: `risk-${createHash("sha1").update(item.link).digest("hex").slice(0, 16)}`,
          title: `【外部風險】${riskType}訊號變化`,
          keyChange: item.title,
          summary: `${riskType}事件可能影響美元流動性與風險偏好，進而傳導至 BTC/ETH。`,
          cryptoImpact,
          shortTermBias,
          time: item.pubDate || dayjs().toISOString(),
          source: item.link
        });
      }
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
    .slice(0, 20);
}
