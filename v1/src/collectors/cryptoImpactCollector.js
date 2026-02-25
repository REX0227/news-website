import dayjs from "dayjs";
import { createHash } from "node:crypto";
import { fetchRssItems } from "../lib/rss.js";
import { cleanText, impactScoreFromText } from "../lib/utils.js";

const FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://news.google.com/rss/search?q=(bitcoin%20OR%20crypto)%20(trump%20OR%20tariff%20war%20sanctions%20geopolitical%20conflict%20fed%20boj%20rate)%20after:2026-02-01&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=(trump%20tariff%2010%25%20OR%2015%25)%20(crypto%20OR%20bitcoin)%20after:2026-02-01&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=(fomc%20rate%20cut%20probability)%20(crypto%20OR%20bitcoin)%20after:2026-02-01&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=(bitcoin%20OR%20crypto)%20(liquidation%20OR%20liquidations%20OR%20liquidated)%20after:2026-02-01&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=(S%26P%20500%20OR%20Nasdaq%20OR%20Dow%20Jones%20OR%20US%20Stock%20Market)%20after:2026-02-01&hl=en-US&gl=US&ceid=US:en"
];

const MAX_SIGNAL_AGE_DAYS = Number(process.env.MAX_SIGNAL_AGE_DAYS || 30);
const MAX_SAME_KEYCHANGE = Number(process.env.MAX_SAME_KEYCHANGE || 1);
const MAX_TOTAL_SIGNALS = Number(process.env.MAX_TOTAL_SIGNALS || 30);
const METRICS_WINDOW_DAYS = Number(process.env.SIGNAL_METRICS_WINDOW_DAYS || 7);
const SIGNAL_DIVERSITY_WINDOW_HOURS = Number(process.env.SIGNAL_DIVERSITY_WINDOW_HOURS || 96);
const MMR_LAMBDA = Number(process.env.SIGNAL_MMR_LAMBDA || 0.65);
const SEMANTIC_CLUSTER_THRESHOLD = Number(process.env.SEMANTIC_CLUSTER_THRESHOLD || 0.07);
const TOPIC_SIGNATURE_TERMS = Number(process.env.TOPIC_SIGNATURE_TERMS || 2);
const MAX_PER_TOPIC_SIGNATURE = Number(process.env.MAX_PER_TOPIC_SIGNATURE || 1);
const FINAL_NEAR_DUP_THRESHOLD = Number(process.env.FINAL_NEAR_DUP_THRESHOLD || 0.07);

const GENERIC_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "after", "amid", "into", "over", "under", "today",
  "says", "said", "news", "live", "update", "updates", "market", "markets", "price", "prices", "crypto"
]);
const CATEGORY_QUOTAS = {
  flow: Number(process.env.QUOTA_FLOW || 20),
  regulation: Number(process.env.QUOTA_REGULATION || 20),
  risk: Number(process.env.QUOTA_RISK || 20),
  macro: Number(process.env.QUOTA_MACRO || 20),
  market: Number(process.env.QUOTA_MARKET || 20)
};

function parseUsdAmount(text = "") {
  const raw = String(text);

  // $288M / $1.2B / $300,000,000
  const m = raw.match(/\$\s*([\d,.]+)\s*([kKmMbB])?/);
  if (m) {
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (!Number.isFinite(n)) return null;
    const unit = String(m[2] || "").toUpperCase();
    if (unit === "K") return n * 1e3;
    if (unit === "M") return n * 1e6;
    if (unit === "B") return n * 1e9;
    return n;
  }

  // 3.2 億 / 5000 萬
  const zh = raw.match(/([\d.]+)\s*(億|萬)/);
  if (zh) {
    const n = Number(zh[1]);
    if (!Number.isFinite(n)) return null;
    const unit = zh[2];
    if (unit === "億") return n * 1e8;
    if (unit === "萬") return n * 1e4;
  }

  return null;
}

function parseEtfNetFlowUsd(text = "") {
  const raw = String(text);
  // Require direction keywords; otherwise skip as ambiguous.
  const isOut = /net\s+outflow|淨流出|outflow/i.test(raw);
  const isIn = /net\s+inflow|淨流入|inflow/i.test(raw);
  if (isOut === isIn) return null;

  const amount = parseUsdAmount(raw);
  if (amount === null) return null;

  // Ignore tiny amounts (usually noise, and helps avoid $65K-style prices).
  if (amount < 5e6) return null;
  return (isOut ? -1 : 1) * amount;
}

function parseLiquidationUsd(text = "") {
  const raw = String(text);
  if (/liquidating\s+(?:its|their)\s+treasury|treasury\s+liquidation|asset\s+liquidation|corporate\s+liquidation|bankruptcy|chapter\s+11|wind\s*down/i.test(raw)) {
    return null;
  }
  // Only accept patterns where liquidation appears BEFORE the $ amount.
  const m = raw.match(/(?:liquidat(?:ion|ed|es)?|清算|wipe|wiped|wipeout)[^$]{0,60}\$\s*([\d,.]+)\s*([mMbB]|million|billion)?/i)
    || raw.match(/\$\s*([\d,.]+)\s*([mMbB]|million|billion)\b[^.]{0,60}(?:liquidat(?:ion|ed|es)?|清算|wipe|wiped|wipeout)/i);
  if (!m) return null;

  // Exclude non-liquidation contexts (market cap/value or spot price moves).
  const matched = String(m[0] || "").toLowerCase();
  if (/market\s*cap|market\s*value|valuation|price\s*drop|price\s*fall|below\s*\$|above\s*\$/i.test(matched)) {
    return null;
  }

  const n = Number(String(m[1]).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = String(m[2] || "").toLowerCase();
  const amount = unit.startsWith("b") ? n * 1e9 : unit.startsWith("m") ? n * 1e6 : n;

  // Liquidation 규모用：低於 1M 幾乎不具意義，且可有效排除價格/雜訊。
  if (amount < 5e6) return null;
  // Extreme outlier guard: most true liquidation reports are well below $10B.
  if (amount > 1e10) return null;
  return amount;
}

function parseLiquidationUsdFallback(text = "") {
  const raw = String(text);
  if (!/liquidat|清算|wipe|wiped|wipeout/i.test(raw)) return null;

  const amountMatch = raw.match(/\$\s*([\d,.]+)\s*([mMbB]|million|billion)\b/i);
  if (!amountMatch) return null;

  const n = Number(String(amountMatch[1]).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;

  const unit = String(amountMatch[2] || "").toLowerCase();
  const amount = unit.startsWith("b") ? n * 1e9 : n * 1e6;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (amount > 1e10) return null;

  const lower = raw.toLowerCase();
  const liqIndex = lower.search(/liquidat|清算|wipe|wiped|wipeout/);
  const usdIndex = lower.indexOf("$");
  if (liqIndex === -1 || usdIndex === -1) return null;
  if (Math.abs(liqIndex - usdIndex) > 120) return null;

  if (/below\s*\$|above\s*\$|trading\s*at\s*\$|price\s*(?:at|to|near)\s*\$|btc\s*below\s*\$|liquidating\s+(?:its|their)\s+treasury|treasury\s+liquidation|asset\s+liquidation|corporate\s+liquidation/i.test(lower)) {
    return null;
  }

  return amount;
}

const KEYWORDS = /(etf|sec|fomc|fed|boj|inflation|cpi|nfp|rate|tariff|liquidat|hack|exploit|regulation|stablecoin|bank|bond|treasury|whale|outflow|inflow|trump|war|sanction|conflict|ceasefire|missile|oil)/i;

function stripHtml(text = "") {
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function classify(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  if (/etf|inflow|outflow/.test(text)) return "flow";
  if (/sec|regulation|policy|law|stablecoin/.test(text)) return "regulation";
  if (/hack|exploit|liquidat|whale/.test(text)) return "risk";
  if (/fed|fomc|boj|cpi|nfp|rate|tariff|trump|war|sanction|conflict|ceasefire|oil/.test(text)) return "macro";
  return "market";
}

function inferShortTermBias(title, description, category) {
  const text = `${title} ${description}`.toLowerCase();
  const bearish = /outflow|liquidat|hack|exploit|lawsuit|ban|tariff|war|conflict|sanction|sell-off|crash/.test(text);
  const bullish = /inflow|approval|adoption|buy|treasury buy|easing|ceasefire|rate cut/.test(text);

  if (bearish && !bullish) return "偏跌";
  if (bullish && !bearish) return "偏漲";
  if (category === "risk") return "偏跌";
  return "震盪";
}

function normalizeForSimilarity(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForSimilarity(text = "") {
  const normalized = normalizeForSimilarity(text);
  if (!normalized) return new Set();
  return new Set(normalized.split(" ").filter((token) => token.length >= 3));
}

function buildShingleSet(text = "", size = 3) {
  const compact = normalizeForSimilarity(text).replace(/\s+/g, "");
  const set = new Set();
  if (compact.length < size) {
    if (compact) set.add(compact);
    return set;
  }
  for (let index = 0; index <= compact.length - size; index += 1) {
    set.add(compact.slice(index, index + size));
  }
  return set;
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size && !setB.size) return 1;
  if (!setA.size || !setB.size) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function signalSimilarity(left, right) {
  const leftTitle = left.title || "";
  const rightTitle = right.title || "";
  const leftBody = `${left.title || ""} ${left.summary || ""}`;
  const rightBody = `${right.title || ""} ${right.summary || ""}`;

  const titleTokenScore = jaccardSimilarity(tokenizeForSimilarity(leftTitle), tokenizeForSimilarity(rightTitle));
  const bodyTokenScore = jaccardSimilarity(tokenizeForSimilarity(leftBody), tokenizeForSimilarity(rightBody));
  const titleShingleScore = jaccardSimilarity(buildShingleSet(leftTitle), buildShingleSet(rightTitle));

  return titleTokenScore * 0.45 + bodyTokenScore * 0.35 + titleShingleScore * 0.2;
}

function bodyShingleSimilarity(left, right) {
  const leftBody = `${left.title || ""} ${left.summary || ""}`;
  const rightBody = `${right.title || ""} ${right.summary || ""}`;
  return jaccardSimilarity(buildShingleSet(leftBody), buildShingleSet(rightBody));
}

function buildSignalTokens(signal) {
  return tokenizeForSimilarity(`${signal.title || ""} ${signal.summary || ""} ${signal.keyChange || ""}`);
}

function buildIdfModel(signals) {
  const docCount = Math.max(1, signals.length);
  const df = new Map();

  for (const signal of signals) {
    const tokens = buildSignalTokens(signal);
    for (const token of tokens) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }

  const idf = new Map();
  for (const [token, count] of df.entries()) {
    idf.set(token, Math.log((1 + docCount) / (1 + count)) + 1);
  }
  return idf;
}

function buildTfidfVector(signal, idfModel) {
  const text = normalizeForSimilarity(`${signal.title || ""} ${signal.summary || ""} ${signal.keyChange || ""}`);
  const words = text.split(" ").filter((word) => word.length >= 3);
  if (!words.length) return new Map();

  const tf = new Map();
  for (const word of words) {
    tf.set(word, (tf.get(word) || 0) + 1);
  }

  const vector = new Map();
  const total = words.length;
  for (const [word, count] of tf.entries()) {
    const idf = idfModel.get(word) || 1;
    vector.set(word, (count / total) * idf);
  }
  return vector;
}

function buildTopicSignature(signal, idfModel) {
  const text = normalizeForSimilarity(`${signal.title || ""} ${signal.summary || ""}`);
  const words = text
    .split(" ")
    .filter((word) => word.length >= 4 && !GENERIC_STOPWORDS.has(word));

  if (!words.length) return cleanText(signal.title || "topic").toLowerCase().slice(0, 30);

  const tf = new Map();
  for (const word of words) tf.set(word, (tf.get(word) || 0) + 1);

  const ranked = [...tf.entries()]
    .map(([word, count]) => [word, count * (idfModel.get(word) || 1)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, TOPIC_SIGNATURE_TERMS))
    .map(([word]) => word);

  return ranked.join("|");
}

function cosineSimilarity(vectorA, vectorB) {
  if (!vectorA.size || !vectorB.size) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const value of vectorA.values()) normA += value * value;
  for (const value of vectorB.values()) normB += value * value;

  if (normA <= 0 || normB <= 0) return 0;

  const [smaller, larger] = vectorA.size <= vectorB.size ? [vectorA, vectorB] : [vectorB, vectorA];
  for (const [token, value] of smaller.entries()) {
    const other = larger.get(token);
    if (other) dot += value * other;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function selectSignalsByMMR(signals, maxCount) {
  if (!signals.length) return [];
  const cappedMax = Math.max(0, maxCount);
  if (cappedMax === 0) return [];

  const idfModel = buildIdfModel(signals);
  const enriched = signals.map((signal, index) => {
    const timeValue = dayjs(signal.time).valueOf();
    const recency = Number.isFinite(timeValue) ? timeValue : 0;
    return {
      signal,
      index,
      vector: buildTfidfVector(signal, idfModel),
      relevance: (signal.priorityScore || 0) + recency / 1e13
    };
  });

  const selected = [];
  const picked = new Set();
  const lambda = Math.min(0.95, Math.max(0.35, MMR_LAMBDA));

  while (selected.length < cappedMax && picked.size < enriched.length) {
    let best = null;
    let bestScore = -Infinity;

    for (const candidate of enriched) {
      if (picked.has(candidate.index)) continue;

      const candidateTime = dayjs(candidate.signal.time);
      let similarityPenalty = 0;
      for (const chosen of selected) {
        const chosenTime = dayjs(chosen.signal.time);
        const hourGap = Math.abs(candidateTime.diff(chosenTime, "hour", true));
        if (Number.isFinite(hourGap) && hourGap > SIGNAL_DIVERSITY_WINDOW_HOURS) continue;
        similarityPenalty = Math.max(similarityPenalty, cosineSimilarity(candidate.vector, chosen.vector));
      }

      const score = lambda * candidate.relevance - (1 - lambda) * similarityPenalty * 100;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (!best) break;
    picked.add(best.index);
    selected.push(best);
  }

  return selected.map((entry) => entry.signal);
}

function clusterSignalsBySemantics(signals) {
  if (!signals.length) return [];
  const idfModel = buildIdfModel(signals);

  const enriched = signals
    .map((signal, index) => {
      const timeValue = dayjs(signal.time).valueOf();
      const recency = Number.isFinite(timeValue) ? timeValue : 0;
      return {
        signal,
        index,
        vector: buildTfidfVector(signal, idfModel),
        relevance: (signal.priorityScore || 0) + recency / 1e13
      };
    })
    .sort((a, b) => b.relevance - a.relevance);

  const clusters = [];

  for (const candidate of enriched) {
    const candidateTime = dayjs(candidate.signal.time);
    let bestCluster = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      const representative = cluster.items[0];
      const repTime = dayjs(representative.signal.time);
      const hourGap = Math.abs(candidateTime.diff(repTime, "hour", true));
      if (Number.isFinite(hourGap) && hourGap > SIGNAL_DIVERSITY_WINDOW_HOURS) continue;

      const cosine = cosineSimilarity(candidate.vector, representative.vector);
      const shingle = bodyShingleSimilarity(candidate.signal, representative.signal);
      const combined = cosine * 0.75 + shingle * 0.25;

      if (combined > bestScore) {
        bestScore = combined;
        bestCluster = cluster;
      }
    }

    if (!bestCluster || bestScore < SEMANTIC_CLUSTER_THRESHOLD) {
      clusters.push({ items: [candidate] });
      continue;
    }

    bestCluster.items.push(candidate);
    bestCluster.items.sort((a, b) => b.relevance - a.relevance);
  }

  return clusters;
}

function pickClusterRepresentatives(signals, maxCount) {
  if (!signals.length) return [];
  const clusters = clusterSignalsBySemantics(signals);
  const idfModel = buildIdfModel(signals);

  const representatives = clusters
    .map((cluster) => cluster.items[0])
    .sort((a, b) => b.relevance - a.relevance)
    .map((entry) => entry.signal);

  const selected = [];
  const topicCount = new Map();
  const maxTopic = Math.max(1, MAX_PER_TOPIC_SIGNATURE);

  for (const signal of representatives) {
    const signature = buildTopicSignature(signal, idfModel);
    const used = topicCount.get(signature) || 0;
    if (used >= maxTopic) continue;

    topicCount.set(signature, used + 1);
    selected.push(signal);
    if (selected.length >= Math.max(0, maxCount)) break;
  }

  return selected;
}

function suppressNearDuplicateSignals(signals, maxCount) {
  if (!signals.length) return [];

  const ordered = [...signals].sort((a, b) => {
    const bp = b.priorityScore || 0;
    const ap = a.priorityScore || 0;
    if (bp !== ap) return bp - ap;
    return dayjs(b.time).valueOf() - dayjs(a.time).valueOf();
  });

  const idfModel = buildIdfModel(ordered);
  const kept = [];
  const keptVectors = [];

  for (const signal of ordered) {
    const candidateVector = buildTfidfVector(signal, idfModel);
    let duplicated = false;

    for (let index = 0; index < kept.length; index += 1) {
      const existing = kept[index];
      const hourGap = Math.abs(dayjs(signal.time).diff(dayjs(existing.time), "hour", true));
      if (Number.isFinite(hourGap) && hourGap > SIGNAL_DIVERSITY_WINDOW_HOURS) continue;

      const sim = cosineSimilarity(candidateVector, keptVectors[index]);
      if (sim >= FINAL_NEAR_DUP_THRESHOLD) {
        duplicated = true;
        break;
      }
    }

    if (duplicated) continue;
    kept.push(signal);
    keptVectors.push(candidateVector);
    if (kept.length >= Math.max(0, maxCount)) break;
  }

  return kept.sort((a, b) => dayjs(b.time).valueOf() - dayjs(a.time).valueOf());
}

function summarizeMergedChange(signals) {
  if (!signals.length) return "市場訊號更新";
  if (signals.length === 1) return signals[0]?.keyChange || cleanText(signals[0]?.title || "市場訊號更新").slice(0, 90);

  const byKeyChange = new Map();
  for (const signal of signals) {
    const key = String(signal.keyChange || "").trim() || cleanText(signal.title || "").slice(0, 90);
    byKeyChange.set(key, (byKeyChange.get(key) || 0) + 1);
  }

  const winner = [...byKeyChange.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0] || "市場訊號更新";

  return `${winner}（同主題 ${signals.length} 則）`;
}

function aggregateSimilarSignals(inputSignals) {
  const sortedSignals = [...inputSignals].sort((a, b) => dayjs(b.time).valueOf() - dayjs(a.time).valueOf());
  const clusters = [];

  for (const signal of sortedSignals) {
    let bestIndex = -1;
    let bestScore = 0;
    const signalTime = dayjs(signal.time);

    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[index];
      if (cluster.category !== signal.category) continue;

      const clusterTime = dayjs(cluster.latestTime);
      const hourGap = Math.abs(signalTime.diff(clusterTime, "hour", true));
      if (Number.isFinite(hourGap) && hourGap > 96) continue;

      const similarity = signalSimilarity(signal, cluster.representative);
      if (similarity > bestScore) {
        bestScore = similarity;
        bestIndex = index;
      }
    }

    if (bestIndex === -1 || bestScore < 0.66) {
      clusters.push({
        category: signal.category,
        representative: signal,
        mergedItems: [signal],
        mergedSources: [signal.source],
        latestTime: signal.time
      });
      continue;
    }

    const target = clusters[bestIndex];
    target.mergedItems.push(signal);
    target.mergedSources.push(signal.source);

    if ((signal.priorityScore || 0) > (target.representative.priorityScore || 0)) {
      target.representative = signal;
    }
    if (dayjs(signal.time).valueOf() > dayjs(target.latestTime).valueOf()) {
      target.latestTime = signal.time;
    }
  }

  return clusters
    .map((cluster) => {
      const representative = cluster.representative;
      const dayKey = dayjs(cluster.latestTime).isValid() ? dayjs(cluster.latestTime).format("YYYY-MM-DD") : "na";
      const hashSource = cleanText(representative.title || representative.keyChange || "cluster").slice(0, 120);
      const clusterKey = `${cluster.category}|${createHash("sha1").update(`${dayKey}|${hashSource}`).digest("hex").slice(0, 10)}`;

      return {
        ...representative,
        clusterKey,
        mergedCount: cluster.mergedItems.length,
        mergedSources: [...new Set(cluster.mergedSources)].slice(0, 5),
        keyChange: summarizeMergedChange(cluster.mergedItems),
        time: cluster.latestTime
      };
    })
    .sort((a, b) => {
      const bt = dayjs(b.time).valueOf();
      const at = dayjs(a.time).valueOf();
      if (bt !== at) return bt - at;
      return (b.priorityScore || 0) - (a.priorityScore || 0);
    });
}

function hoursAgo(isoTime) {
  const parsed = dayjs(isoTime);
  if (!parsed.isValid()) return 9999;
  return Math.max(0, dayjs().diff(parsed, "hour"));
}

function majorEventScore({ title, description, category, impact, time, keyChange }) {
  const text = `${title} ${description} ${keyChange}`.toLowerCase();
  let score = 0;

  if (/trump|tariff|trade war|10\s*%|15\s*%/.test(text)) score += 55;
  if (/fomc|fed|boj|rate|cpi|nfp|inflation/.test(text)) score += 45;
  if (/war|conflict|sanction|middle east|ukraine|russia|china/.test(text)) score += 45;
  if (/liquidat|hack|exploit|etf\s+net\s+outflow|etf\s+net\s+inflow/.test(text)) score += 35;
  if (/whale|large holder|big holder|exchange inflow|exchange outflow/.test(text)) score += 28;

  if (impact === "high") score += 30;
  if (impact === "medium") score += 18;

  if (category === "macro") score += 14;
  if (category === "risk") score += 12;
  if (category === "flow") score += 10;

  if (/\$\s?\d+(?:\.\d+)?\s?(?:billion|million|bn|m|b)/i.test(text)) score += 10;

  const ageHours = hoursAgo(time);
  if (ageHours <= 12) score += 22;
  else if (ageHours <= 24) score += 16;
  else if (ageHours <= 72) score += 10;
  else if (ageHours <= 168) score += 6;

  return score;
}

function extractConcreteChange(title, description) {
  const raw = `${title} ${description}`;
  const text = raw.toLowerCase();
  const usd = raw.match(/\$\s?\d+(?:\.\d+)?\s?(?:billion|million|bn|m|b)/i);
  const shortTitle = cleanText(title).slice(0, 90);

  if (/etf/.test(text) && /outflow/.test(text)) {
    return `ETF 淨流出擴大${usd ? `（約 ${usd[0]}）` : ""}`;
  }
  if (/etf/.test(text) && /inflow/.test(text)) {
    return `ETF 淨流入增加${usd ? `（約 ${usd[0]}）` : ""}`;
  }
  if (/liquidat/.test(text)) {
    if (usd) return `市場出現大量清算（規模 ${usd[0]}）`;
    return "槓桿風險升溫（未見可量化清算規模）";
  }
  return shortTitle;
}

  function inferWhaleHint(title, description) {
    const text = `${title} ${description}`.toLowerCase();
    if (/whale|large holder|big holder|liquidat|exchange inflow|exchange outflow|machi big brother|smart money|institution/.test(text)) {
      if (/sell|outflow|liquidat|inflow to exchange|dump|lose|lost|loses|wipe/.test(text)) return "偏空";
      if (/buy|accumulat|inflow to etf|withdraw from exchange|scoop|add/.test(text)) return "偏多";
      return "中性";
    }
    return null;
  }

  function inferWhaleActor(title, description) {
    const text = `${title} ${description}`;
    if (/BlackRock/i.test(text)) return "BlackRock";
    if (/Fidelity/i.test(text)) return "Fidelity";
    if (/MicroStrategy|Strategy/i.test(text)) return "Strategy";
    if (/Binance/i.test(text)) return "Binance";
    if (/Coinbase/i.test(text)) return "Coinbase";
  return null;
}

function inferTopic(text) {
  const lower = text.toLowerCase();
  if (/etf|inflow|outflow/.test(lower)) return "資金流向";
  if (/sec|regulation|policy|law|stablecoin/.test(lower)) return "監管政策";
  if (/hack|exploit/.test(lower)) return "資安風險";
  if (/liquidat|whale/.test(lower)) return "槓桿/大戶風險";
  if (/fomc|fed|boj|cpi|nfp|rate|inflation|tariff/.test(lower)) return "宏觀變數";
  return "市場情緒";
}

function buildChineseHeadline(item, category) {
  const topic = inferTopic(`${item.title} ${item.description}`);
  const concrete = extractConcreteChange(item.title, item.description);
  return `【${topic}】${concrete}`;
}

function buildChineseSummary(item, category) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  const hasBitcoin = /bitcoin|btc/.test(text);
  const hasEthereum = /ethereum|eth/.test(text);
  const hasEtf = /etf|inflow|outflow/.test(text);
  const hasReg = /sec|regulation|policy|law|stablecoin/.test(text);
  const hasRisk = /hack|exploit|liquidat|whale/.test(text);

  const assetHint = hasBitcoin && hasEthereum ? "BTC 與 ETH" : hasBitcoin ? "BTC" : hasEthereum ? "ETH" : "主流幣";

  if (category === "flow") {
    if (hasEtf) return `觀察到 ETF 或資金流向變化，${assetHint} 短線趨勢可能受資金面主導，建議搭配成交量確認。`;
    return `觀察到資金進出相關訊號，${assetHint} 可能出現波段延續或反轉，建議留意量能是否同步放大。`;
  }
  if (category === "regulation") {
    if (hasReg) return `出現監管或政策面消息，市場通常先反映風險偏好，之後才反映中期估值；${assetHint} 波動可能先擴大。`;
    return "政策環境訊號轉變，短線可能造成價格快速重定價，建議降低追價並等待方向確認。";
  }
  if (category === "risk") {
    if (hasRisk) return `出現風險事件（如爆倉/資安/大戶行為）訊號，${assetHint} 容易產生連鎖波動，宜優先控管風險。`;
    return "出現異常風險訊號，市場可能進入高波動區，建議先縮小槓桿再評估進場。";
  }
  if (category === "macro") {
    return `宏觀因素正在影響加密市場，建議同步追蹤美元、利率預期與美債殖利率，${assetHint} 對此類消息通常較敏感。`;
  }

  return "市場訊息更新中，建議配合成交量、波動率與資金費率判讀，避免在雜訊行情中過度交易。";
}

function buildCryptoImpact(category, impact) {
  if (category === "risk") {
    return {
      cryptoImpact: impact === "high" ? "高風險：恐引發連續止損與短線急跌" : "中短線風險升高：波動率可能擴大",
      cryptoAnalysis: "建議降低槓桿與倉位集中度，優先確認市場流動性與主要交易所未平倉量變化。"
    };
  }

  if (category === "regulation") {
    return {
      cryptoImpact: "政策定價期：市場可能先震盪再選方向",
      cryptoAnalysis: "監管訊息通常先影響情緒與估值折價，若後續細則偏友善，主流幣有機會修復。"
    };
  }

  if (category === "flow") {
    return {
      cryptoImpact: "資金面驅動：短線趨勢延續機率上升",
      cryptoAnalysis: "可搭配 ETF/交易所淨流量與成交量觀察；若價量同向，趨勢可信度較高。"
    };
  }

  if (category === "macro") {
    return {
      cryptoImpact: "宏觀敏感期：BTC/ETH 對利率預期更敏感",
      cryptoAnalysis: "重點關注美元指數與美債殖利率，若同向走強，風險資產通常承壓。"
    };
  }

  return {
    cryptoImpact: "市場事件影響中",
    cryptoAnalysis: "建議搭配波動率、成交量與資金費率做確認，再決定進出場節奏。"
  };
}

export async function collectCryptoImpactSignals() {
  const collected = [];
  const now = dayjs();

  for (const feed of FEEDS) {
    try {
      const items = await fetchRssItems(feed, 200);
      const filteredByDate = items.filter((item) => {
        if (!item.pubDate) return true;
        const published = dayjs(item.pubDate);
        if (!published.isValid()) return true;
        return now.diff(published, "day") <= MAX_SIGNAL_AGE_DAYS;
      });
      const filteredByKeyword = filteredByDate.filter((item) => KEYWORDS.test(`${item.title} ${item.description}`));
      collected.push(
        ...filteredByKeyword
          .map((item) => {
            const category = classify(item.title, item.description);
            const impact = impactScoreFromText(`${item.title} ${item.description}`);
            const shortTermBias = inferShortTermBias(item.title, item.description, category);
            const keyChange = extractConcreteChange(item.title, item.description);
            const whaleHint = inferWhaleHint(item.title, item.description);
            const whaleActor = whaleHint ? inferWhaleActor(item.title, item.description) : null;

            return {
              id: `signal-${createHash("sha1").update(item.link).digest("hex").slice(0, 16)}`,
              category,
              impact,
              shortTermBias,
              keyChange,
              whaleHint,
              whaleActor,
              zhTitle: buildChineseHeadline(item, category),
              zhSummary: buildChineseSummary(item, category),
              ...buildCryptoImpact(category, impact),
              title: cleanText(item.title),
              time: item.pubDate || dayjs().toISOString(),
              summary: stripHtml(item.description).slice(0, 240),
              source: item.link
            };
          })
      );
    } catch {
      continue;
    }
  }

  const unique = new Map();
  for (const item of collected) {
    if (!unique.has(item.source)) unique.set(item.source, item);
  }

  const deduped = [...unique.values()].map((signal) => ({
    ...signal,
    priorityScore: majorEventScore(signal)
  }));

  const allAggregated = aggregateSimilarSignals(deduped);

  // Build 7D metrics from the clustered set to avoid summing duplicates.
  const metrics7d = {
    windowDays: METRICS_WINDOW_DAYS,
    etfNetFlowUsd: 0,
    etfCountWithAmount: 0,
    liquidationTotalUsd: 0,
    liquidationCountWithAmount: 0
  };

  for (const signal of allAggregated) {
    const t = dayjs(signal.time);
    if (!t.isValid()) continue;
    if (now.diff(t, "day", true) > METRICS_WINDOW_DAYS) continue;

    const blob = `${signal.title || ""} ${signal.summary || ""} ${signal.keyChange || ""} ${signal.zhTitle || ""}`;

    if (/\bETF\b/i.test(blob) || /ETF/.test(blob)) {
      const net = parseEtfNetFlowUsd(blob);
      if (Number.isFinite(net)) {
        metrics7d.etfNetFlowUsd += net;
        metrics7d.etfCountWithAmount += 1;
      }
    }

    if (/清算|liquidat|wipe|wiped|wipeout/i.test(blob)) {
      const liq = parseLiquidationUsd(blob);
      if (Number.isFinite(liq)) {
        metrics7d.liquidationTotalUsd += Math.abs(liq);
        metrics7d.liquidationCountWithAmount += 1;
      }
    }
  }

  const latestQuantifiedEtfSignal = [...allAggregated]
    .filter((signal) => {
      const blob = `${signal.title || ""} ${signal.summary || ""} ${signal.keyChange || ""} ${signal.zhTitle || ""}`;
      return (/\bETF\b/i.test(blob) || /ETF/.test(blob)) && Number.isFinite(parseEtfNetFlowUsd(blob));
    })
    .sort((a, b) => dayjs(b.time).valueOf() - dayjs(a.time).valueOf())[0] || null;

  if (latestQuantifiedEtfSignal) {
    const blob = `${latestQuantifiedEtfSignal.title || ""} ${latestQuantifiedEtfSignal.summary || ""} ${latestQuantifiedEtfSignal.keyChange || ""} ${latestQuantifiedEtfSignal.zhTitle || ""}`;
    const latestEtfNet = parseEtfNetFlowUsd(blob);
    if (Number.isFinite(latestEtfNet)) {
      metrics7d.etfNetFlowUsd = Math.round(latestEtfNet);
      metrics7d.etfCountWithAmount = 1;
      metrics7d.latestNewsEtfFlow = {
        usd: Math.round(latestEtfNet),
        time: latestQuantifiedEtfSignal.time,
        title: latestQuantifiedEtfSignal.title,
        source: latestQuantifiedEtfSignal.source,
        note: "新聞 ETF 僅採最近一筆可量化值，不做多篇加總。"
      };
    }
  }

  const latestQuantifiedLiquidationSignal = [...allAggregated]
    .filter((signal) => {
      const blob = `${signal.title || ""} ${signal.summary || ""} ${signal.keyChange || ""} ${signal.zhTitle || ""}`;
      return Number.isFinite(parseLiquidationUsd(blob)) || Number.isFinite(parseLiquidationUsdFallback(blob));
    })
    .sort((a, b) => dayjs(b.time).valueOf() - dayjs(a.time).valueOf())[0] || null;

  if (latestQuantifiedLiquidationSignal) {
    const blob = `${latestQuantifiedLiquidationSignal.title || ""} ${latestQuantifiedLiquidationSignal.summary || ""} ${latestQuantifiedLiquidationSignal.keyChange || ""} ${latestQuantifiedLiquidationSignal.zhTitle || ""}`;
    const latestAmount = parseLiquidationUsd(blob) ?? parseLiquidationUsdFallback(blob);
    if (Number.isFinite(latestAmount)) {
      metrics7d.latestNewsLiquidation = {
        usd: Math.round(Math.abs(latestAmount)),
        time: latestQuantifiedLiquidationSignal.time,
        title: latestQuantifiedLiquidationSignal.title,
        source: latestQuantifiedLiquidationSignal.source
      };
    }
  }

  if (metrics7d.liquidationCountWithAmount === 0) {
    const latestLiquidationSignal = [...allAggregated]
      .filter((signal) => {
        const blob = `${signal.title || ""} ${signal.summary || ""} ${signal.keyChange || ""} ${signal.zhTitle || ""}`;
        return /清算|liquidat|wipe|wiped|wipeout/i.test(blob);
      })
      .sort((a, b) => dayjs(b.time).valueOf() - dayjs(a.time).valueOf())[0] || null;

    if (latestLiquidationSignal) {
      const blob = `${latestLiquidationSignal.title || ""} ${latestLiquidationSignal.summary || ""} ${latestLiquidationSignal.keyChange || ""} ${latestLiquidationSignal.zhTitle || ""}`;
      const fallbackLiq = parseLiquidationUsdFallback(blob);
      if (Number.isFinite(fallbackLiq)) {
        metrics7d.liquidationTotalUsd = Math.round(Math.abs(fallbackLiq));
        metrics7d.liquidationCountWithAmount = 1;
        metrics7d.liquidationFallback = {
          mode: "latest_news_signal",
          time: latestLiquidationSignal.time,
          title: latestLiquidationSignal.title,
          source: latestLiquidationSignal.source,
          note: "7D 無可量化清算時，使用最近一筆新聞清算金額作為暫代。"
        };
      }
    }
  }

  metrics7d.etfNetFlowUsd = Math.round(metrics7d.etfNetFlowUsd);
  metrics7d.liquidationTotalUsd = Math.round(metrics7d.liquidationTotalUsd);

  const categories = Object.keys(CATEGORY_QUOTAS);
  const byCategory = new Map(categories.map((c) => [c, []]));
  for (const signal of allAggregated) {
    const category = byCategory.has(signal.category) ? signal.category : "market";
    byCategory.get(category).push(signal);
  }

  const selected = [];

  for (const category of categories) {
    const quota = Math.max(0, Number(CATEGORY_QUOTAS[category] || 0));
    if (quota === 0) continue;

    const kept = [];
    const keyChangeCount = new Map();

    for (const signal of byCategory.get(category) || []) {
      const key = String(signal.keyChange || "").trim();
      const count = keyChangeCount.get(key) || 0;
      if (count >= MAX_SAME_KEYCHANGE) continue;
      keyChangeCount.set(key, count + 1);
      kept.push(signal);
      if (kept.length >= quota) break;
    }

    selected.push(...kept);
  }

  const rankedSignals = selected
    .sort((a, b) => dayjs(b.time).valueOf() - dayjs(a.time).valueOf())
    .slice(0, MAX_TOTAL_SIGNALS * 2);

  const mmrSignals = selectSignalsByMMR(rankedSignals, MAX_TOTAL_SIGNALS * 2);
  const representativeSignals = pickClusterRepresentatives(mmrSignals, MAX_TOTAL_SIGNALS * 2);
  const signals = suppressNearDuplicateSignals(representativeSignals, MAX_TOTAL_SIGNALS);

  return { signals, metrics7d };
}
