import dayjs from "dayjs";
import { fetchRssItems } from "../lib/rss.js";

const FEEDS = [
  {
    name: "WhiteHouse",
    url: "https://www.whitehouse.gov/briefing-room/feed/",
    defaultImpact: "high",
    kind: "policy"
  },
  {
    name: "US Treasury",
    url: "https://home.treasury.gov/news/press-releases/rss",
    defaultImpact: "medium",
    kind: "policy"
  },
  {
    name: "Federal Reserve",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    defaultImpact: "high",
    kind: "macro"
  },
  {
    name: "SEC",
    url: "https://www.sec.gov/news/pressreleases.rss",
    defaultImpact: "high",
    kind: "regulation"
  },
  {
    name: "CFTC",
    url: "https://www.cftc.gov/PressRoom/PressReleases/rss",
    defaultImpact: "high",
    kind: "regulation"
  }
];

function safeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stableId(prefix, link, pubDate) {
  const base = `${prefix}|${safeText(link)}|${safeText(pubDate)}`;
  return `policy_${Buffer.from(base).toString("base64").replace(/=+$/g, "")}`;
}

function inferBiasAndImpact({ title, description, sourceName, defaultImpact }) {
  const text = `${title} ${description}`.toLowerCase();

  const isEnforcement = /(charges|charged|lawsuit|litigation|enforcement|settlement|penalt|fine|sanction|criminal|fraud|seizure)/i.test(text);
  const isApproval = /(approve|approval|authoriz|granted|final rule|adopted|launch|greenlight)/i.test(text);
  const isBanOrRestriction = /(ban|banned|prohibit|restriction|restricted|shutdown|suspend)/i.test(text);
  const isTariffTrade = /(tariff|trade|export|import|sanction)/i.test(text);

  let shortTermBias = "震盪";
  if (isEnforcement || isBanOrRestriction) shortTermBias = "偏跌";
  if (isApproval && !isBanOrRestriction && !isEnforcement) shortTermBias = "偏漲";

  let impact = defaultImpact || "medium";
  if (isTariffTrade && impact === "medium") impact = "high";

  let cryptoImpact = "政策/監管訊息：可能透過風險偏好與合規預期影響幣市。";
  if (/federal reserve|fed/.test(String(sourceName || "").toLowerCase())) {
    cryptoImpact = "央行/監管聲明：可能改變利率與流動性預期，進而影響風險資產定價。";
  } else if (/sec|cftc/.test(String(sourceName || "").toLowerCase())) {
    cryptoImpact = isEnforcement
      ? "監管執法：短線通常壓抑風險偏好，並提升合規不確定性。"
      : "監管/規則：可能影響交易所/代幣的合規路徑與市場風險溢價。";
  } else if (/whitehouse|treasury/.test(String(sourceName || "").toLowerCase())) {
    cryptoImpact = isTariffTrade
      ? "政策/貿易：可能推升通膨或風險事件機率，影響美元/利率與風險資產情緒。"
      : "政策訊息：可能改變市場風險偏好與資金面預期。";
  }

  return { shortTermBias, impact, cryptoImpact };
}

export async function collectPolicySignals({ limitPerFeed = 15 } = {}) {
  const tasks = FEEDS.map(async (feed) => {
    try {
      const items = await fetchRssItems(feed.url, limitPerFeed);
      return items.map((item) => {
        const title = safeText(item.title);
        const description = safeText(item.description);
        const pub = item.pubDate || null;
        const time = pub && dayjs(pub).isValid() ? dayjs(pub).toISOString() : new Date().toISOString();

        const { shortTermBias, impact, cryptoImpact } = inferBiasAndImpact({
          title,
          description,
          sourceName: feed.name,
          defaultImpact: feed.defaultImpact
        });

        return {
          id: stableId(feed.name, item.link, pub),
          time,
          title,
          source: item.link,
          sourceName: feed.name,
          category: feed.kind === "regulation" ? "regulation" : "macro",
          impact,
          keyChange: title,
          cryptoImpact,
          shortTermBias
        };
      });
    } catch {
      return [];
    }
  });

  const batches = await Promise.all(tasks);
  const merged = batches.flat();

  // De-dupe by (title+source)
  const seen = new Set();
  const unique = [];
  for (const item of merged) {
    const k = `${item.title}|${item.source}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(item);
  }

  return unique
    .sort((a, b) => dayjs(b.time).valueOf() - dayjs(a.time).valueOf())
    .slice(0, 30);
}
