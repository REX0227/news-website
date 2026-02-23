import dayjs from "dayjs";
import { createHash } from "node:crypto";
import { fetchRssItems } from "../lib/rss.js";

const RISK_FEEDS = [
  "https://news.google.com/rss/search?q=(trump%20tariff%20policy%20crypto)%20OR%20(geopolitical%20war%20crypto)&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=(fed%20rate%20policy%20crypto)%20OR%20(boj%20policy%20crypto)&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=(trump%20tariff%2010%25%20OR%2015%25)%20(market%20OR%20crypto)&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=(middle%20east%20war%20oil%20price)%20(crypto%20OR%20risk%20asset)&hl=en-US&gl=US&ceid=US:en"
];

const MAX_RISK_AGE_DAYS = Number(process.env.MAX_RISK_AGE_DAYS || 14);
const MAX_SAME_RISK_CHANGE = Number(process.env.MAX_SAME_RISK_CHANGE || 3);

const RISK_KEYWORDS = /(trump|tariff|war|geopolitic|conflict|sanction|fed|fomc|boj|rate|inflation|oil|middle east|china|russia|ukraine)/i;

function extractRiskChange(title = "", description = "") {
  const raw = `${title} ${description}`;
  const text = raw.toLowerCase();
  const percent = raw.match(/(\d+(?:\.\d+)?\s*%)/);

  if (/supreme court/.test(text) && /trump/.test(text) && /tariff/.test(text)) {
    return "美國最高法院對川普關稅措施出現法律變數，關稅政策不確定性升高";
  }
  if (/tariff|trade/.test(text)) {
    return `關稅/貿易政策調整${percent ? `（幅度 ${percent[1]}）` : ""}`;
  }
  if (/war|conflict|missile|ukraine|russia|middle east/.test(text)) {
    return "地緣政治衝突訊號升溫，風險資產情緒受壓";
  }
  if (/sanction/.test(text)) {
    return "制裁政策或執法訊號變化，跨境資金風險升高";
  }
  if (/fomc|fed|boj|rate|inflation/.test(text)) {
    if (/rate cut|cuts|easing|dovish/.test(text)) return "降息預期升溫，市場風險偏好可能回升";
    if (/delay|higher for longer|hawkish|rate hike|tightening/.test(text)) return "降息預期延後或偏鷹，風險資產短線承壓";
    if (/hold|on hold|pause/.test(text)) return "利率按兵不動，市場等待下一次政策訊號";
    return "貨幣政策預期出現變化，市場波動可能放大";
  }
  if (/oil|energy/.test(text)) {
    return "能源價格波動升高，可能推動通膨與風險再定價";
  }

  return "外部宏觀風險訊號更新（細節見原文）";
}

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

function normalizeClusterText(text = "") {
  return String(text)
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\d+(?:\.\d+)?\s*%/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function clusterSignature(signal) {
  const base = normalizeClusterText(signal.keyChange || "");
  const raw = `${signal.keyChange || ""} ${signal.summary || ""}`.toLowerCase();

  let actor = "other";
  if (/trump|川普/.test(raw)) actor = "trump";
  else if (/fed|fomc|聯準會/.test(raw)) actor = "fed";
  else if (/boj|日本央行/.test(raw)) actor = "boj";
  else if (/war|conflict|ukraine|middle east|russia/.test(raw)) actor = "war";

  if (/tariff|關稅|trade/.test(raw) && actor === "trump") return "risk|trump_tariff";
  if (/tariff|關稅|trade/.test(raw)) return "risk|global_tariff";
  if (/fed|fomc|聯準會/.test(raw)) return "risk|fed_policy";
  if (/war|conflict|ukraine|middle east|russia/.test(raw)) return "risk|geo_conflict";

  return `${base}|${actor}|${signal.shortTermBias || "na"}`;
}

function summarizeMergedRiskChange(clusterKey, signals) {
  const allText = signals.map((s) => `${s.keyChange || ""} ${s.summary || ""}`).join(" ");
  const percents = [...new Set((allText.match(/\d+(?:\.\d+)?\s*%/g) || []).map((v) => Number(String(v).replace("%", "").trim())).filter((v) => Number.isFinite(v)))].sort((a, b) => a - b);
  const latest = signals
    .map((s) => dayjs(s.time))
    .filter((d) => d.isValid())
    .sort((a, b) => b.valueOf() - a.valueOf())[0];

  if (clusterKey === "risk|trump_tariff") {
    if (percents.length >= 2) return `川普關稅政策調升（近期區間 ${percents[0]}%~${percents[percents.length - 1]}%，最近更新 ${latest ? latest.format("MM/DD HH:mm") : "未知"}）`;
    if (percents.length === 1) return `川普關稅政策調升（幅度 ${percents[0]}%，最近更新 ${latest ? latest.format("MM/DD HH:mm") : "未知"}）`;
    return "川普關稅政策訊號更新";
  }

  if (clusterKey === "risk|global_tariff") {
    if (percents.length >= 2) return `主要經濟體關稅政策變動（近期區間 ${percents[0]}%~${percents[percents.length - 1]}%）`;
    if (percents.length === 1) return `主要經濟體關稅政策變動（幅度 ${percents[0]}%）`;
    return "主要經濟體關稅政策訊號更新";
  }

  if (clusterKey === "risk|fed_policy") return "聯準會政策預期變化（利率路徑不確定性上升）";
  if (clusterKey === "risk|geo_conflict") return "地緣政治衝突訊號升溫（戰爭/制裁風險上升）";

  return signals[0]?.keyChange || "外部宏觀風險訊號更新";
}

function aggregateSimilarRisks(sortedSignals) {
  const groups = new Map();

  for (const signal of sortedSignals) {
    const sig = clusterSignature(signal);
    if (!groups.has(sig)) {
      groups.set(sig, {
        ...signal,
        clusterKey: sig,
        mergedCount: 1,
        mergedSources: [signal.source],
        mergedItems: [signal],
        latestTime: signal.time
      });
      continue;
    }

    const current = groups.get(sig);
    current.mergedCount += 1;
    current.mergedSources.push(signal.source);
    current.mergedItems.push(signal);
    if (dayjs(signal.time).valueOf() > dayjs(current.latestTime).valueOf()) {
      current.latestTime = signal.time;
    }
  }

  return [...groups.values()]
    .map((item) => ({
      ...item,
      keyChange: summarizeMergedRiskChange(item.clusterKey, item.mergedItems || [item]),
      mergedSources: [...new Set(item.mergedSources)].slice(0, 5),
      time: item.latestTime,
      mergedItems: undefined
    }))
    .sort((a, b) => {
      if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
      return dayjs(b.time).valueOf() - dayjs(a.time).valueOf();
    });
}

function hoursAgo(isoTime) {
  const parsed = dayjs(isoTime);
  if (!parsed.isValid()) return 9999;
  return Math.max(0, dayjs().diff(parsed, "hour"));
}

function riskPriorityScore({ keyChange, summary, cryptoImpact, shortTermBias, time }) {
  const text = `${keyChange} ${summary} ${cryptoImpact}`.toLowerCase();
  let score = 0;

  if (/trump|tariff|trade/.test(text)) score += 50;
  if (/war|conflict|missile|sanction|middle east|ukraine|russia/.test(text)) score += 48;
  if (/fed|fomc|boj|rate|inflation/.test(text)) score += 42;
  if (/oil|energy/.test(text)) score += 30;

  if (/\d+(?:\.\d+)?\s*%/.test(text)) score += 8;
  if (shortTermBias === "偏跌") score += 14;
  if (shortTermBias === "偏漲") score += 10;

  const ageHours = hoursAgo(time);
  if (ageHours <= 12) score += 20;
  else if (ageHours <= 24) score += 14;
  else if (ageHours <= 72) score += 9;
  else if (ageHours <= 168) score += 5;

  return score;
}

export async function collectGlobalRiskSignals() {
  const collected = [];
  const now = dayjs();

  for (const feed of RISK_FEEDS) {
    try {
      const items = await fetchRssItems(feed, 50);
      for (const item of items) {
        if (item.pubDate) {
          const published = dayjs(item.pubDate);
          if (published.isValid() && now.diff(published, "day") > MAX_RISK_AGE_DAYS) continue;
        }

        const text = `${item.title} ${item.description}`.toLowerCase();
        if (!RISK_KEYWORDS.test(text)) continue;

        const riskType = detectRiskType(text);
        const { cryptoImpact, shortTermBias } = impactAndBias(text);

        collected.push({
          id: `risk-${createHash("sha1").update(item.link).digest("hex").slice(0, 16)}`,
          title: `【外部風險】${riskType}訊號變化`,
          keyChange: extractRiskChange(item.title, item.description),
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

  const ranked = [...unique.values()]
    .map((signal) => ({
      ...signal,
      priorityScore: riskPriorityScore(signal)
    }))
    .sort((a, b) => {
      if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
      return dayjs(b.time).valueOf() - dayjs(a.time).valueOf();
    });

  const kept = [];
  const changeCount = new Map();
  for (const signal of ranked) {
    const key = String(signal.keyChange || "").trim();
    const count = changeCount.get(key) || 0;
    if (count >= MAX_SAME_RISK_CHANGE) continue;
    changeCount.set(key, count + 1);
    kept.push(signal);
    if (kept.length >= 20) break;
  }

  const aggregated = aggregateSimilarRisks(kept);
  return aggregated.slice(0, 20);
}
