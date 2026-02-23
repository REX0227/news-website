import dayjs from "dayjs";
import { createHash } from "node:crypto";
import { fetchRssItems } from "../lib/rss.js";
import { cleanText, impactScoreFromText } from "../lib/utils.js";

const FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://news.google.com/rss/search?q=(bitcoin%20OR%20crypto)%20(trump%20OR%20tariff%20war%20sanctions%20geopolitical%20conflict%20fed%20boj%20rate)&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=(trump%20tariff%2010%25%20OR%2015%25)%20(crypto%20OR%20bitcoin)&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=(fomc%20rate%20cut%20probability)%20(crypto%20OR%20bitcoin)&hl=en-US&gl=US&ceid=US:en"
];

const MAX_SIGNAL_AGE_DAYS = Number(process.env.MAX_SIGNAL_AGE_DAYS || 10);
const MAX_SAME_KEYCHANGE = Number(process.env.MAX_SAME_KEYCHANGE || 3);

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

function normalizeClusterText(text = "") {
  return String(text)
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\d+(?:\.\d+)?\s*%/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function clusterSignature(signal) {
  const base = normalizeClusterText(signal.keyChange || signal.zhTitle || "");
  const raw = `${signal.title || ""} ${signal.summary || ""} ${signal.keyChange || ""}`.toLowerCase();

  let actor = "other";
  if (/trump|川普/.test(raw)) actor = "trump";
  else if (/fed|fomc|聯準會/.test(raw)) actor = "fed";
  else if (/boj|日本央行/.test(raw)) actor = "boj";
  else if (/etf/.test(raw)) actor = "etf";

  if (/tariff|關稅|trade/.test(raw) && actor === "trump") {
    return "macro|trump_tariff";
  }
  if (/tariff|關稅|trade/.test(raw)) {
    return "macro|global_tariff";
  }
  if (/fed|fomc|聯準會/.test(raw)) {
    return "macro|fed_policy";
  }

  return `${signal.category}|${base}|${actor}`;
}

function summarizeMergedChange(clusterKey, signals) {
  const allText = signals.map((s) => `${s.title || ""} ${s.summary || ""} ${s.keyChange || ""}`).join(" ");
  const percents = [...new Set((allText.match(/\d+(?:\.\d+)?\s*%/g) || []).map((v) => Number(String(v).replace("%", "").trim())).filter((v) => Number.isFinite(v)))].sort((a, b) => a - b);
  const latest = signals
    .map((s) => dayjs(s.time))
    .filter((d) => d.isValid())
    .sort((a, b) => b.valueOf() - a.valueOf())[0];

  if (clusterKey === "macro|trump_tariff") {
    if (percents.length >= 2) {
      return `川普關稅政策調升（近期區間 ${percents[0]}%~${percents[percents.length - 1]}%，最近更新 ${latest ? latest.format("MM/DD HH:mm") : "未知"}）`;
    }
    if (percents.length === 1) {
      return `川普關稅政策調升（目前重點 ${percents[0]}%，最近更新 ${latest ? latest.format("MM/DD HH:mm") : "未知"}）`;
    }
    return `川普關稅政策訊號更新（最近更新 ${latest ? latest.format("MM/DD HH:mm") : "未知"}）`;
  }

  if (clusterKey === "macro|global_tariff") {
    if (percents.length >= 2) {
      return `主要經濟體關稅政策變動（近期區間 ${percents[0]}%~${percents[percents.length - 1]}%）`;
    }
    if (percents.length === 1) {
      return `主要經濟體關稅政策變動（幅度 ${percents[0]}%）`;
    }
    return "主要經濟體關稅政策訊號更新";
  }

  if (clusterKey === "macro|fed_policy") {
    return "聯準會政策預期更新（請留意降息/維持利率路徑變化）";
  }

  return signals[0]?.keyChange || "重大市場訊號更新（重點請見原文連結）";
}

function aggregateSimilarSignals(sortedSignals) {
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
      keyChange: summarizeMergedChange(item.clusterKey, item.mergedItems || [item]),
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

function majorEventScore({ title, description, category, impact, time, keyChange }) {
  const text = `${title} ${description} ${keyChange}`.toLowerCase();
  let score = 0;

  if (/trump|tariff|trade war|10\s*%|15\s*%/.test(text)) score += 55;
  if (/fomc|fed|boj|rate|cpi|nfp|inflation/.test(text)) score += 45;
  if (/war|conflict|sanction|middle east|ukraine|russia|china/.test(text)) score += 45;
  if (/liquidat|hack|exploit|etf\s+net\s+outflow|etf\s+net\s+inflow/.test(text)) score += 35;

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
  const percent = raw.match(/(\d+(?:\.\d+)?\s*%)/);
  const usd = raw.match(/\$\s?\d+(?:\.\d+)?\s?(?:billion|million|bn|m|b)/i);
  const shortTitle = cleanText(title).slice(0, 90);

  if (/etf/.test(text) && /outflow/.test(text)) {
    return `ETF 淨流出擴大${usd ? `（約 ${usd[0]}）` : ""}`;
  }
  if (/etf/.test(text) && /inflow/.test(text)) {
    return `ETF 淨流入增加${usd ? `（約 ${usd[0]}）` : ""}`;
  }
  if (/tariff/.test(text)) {
    if (/trump/i.test(raw)) {
      return `川普關稅政策調整${percent ? `（幅度 ${percent[1]}）` : "（影響全球風險資產）"}`;
    }
    return `主要經濟體關稅政策調整${percent ? `（幅度 ${percent[1]}）` : ""}`;
  }
  if (/rate|fomc|fed|boj/.test(text)) {
    const actor = /fomc|fed|federal reserve/i.test(raw)
      ? "聯準會"
      : /boj|bank of japan/i.test(raw)
        ? "日本央行"
        : "主要央行";

    if (/delay in rate cuts|cuts delayed|higher for longer|hawkish/i.test(raw)) {
      return `${actor}偏鷹訊號：降息預期延後`;
    }
    if (/rate cut|cuts|easing|dovish/i.test(raw)) {
      return `${actor}偏鴿訊號：降息預期升溫`;
    }
    if (/rate hike|hikes|hiking|tightening/i.test(raw)) {
      return `${actor}升息預期升溫${percent ? `（幅度 ${percent[1]}）` : ""}`;
    }
    if (/hold rates|keeps rates on hold|rates on hold|pause/i.test(raw)) {
      return `${actor}維持利率不變，市場等待下次政策訊號`;
    }
    return `${actor}政策路徑重定價${percent ? `（幅度 ${percent[1]}）` : ""}`;
  }
  if (/liquidat/.test(text)) {
    return `市場出現大量清算${usd ? `（規模 ${usd[0]}）` : ""}`;
  }
  if (/whale/.test(text)) {
    return "大戶資金調倉訊號增加";
  }
  if (/hack|exploit/.test(text)) {
    return `安全事件風險上升${usd ? `（可能涉及 ${usd[0]}）` : ""}`;
  }
  if (/regulation|sec|policy|law|sanction/.test(text)) {
    return "監管框架或執法訊號出現變化";
  }

  return "重大市場訊號更新（重點請見原文連結）";
}

function inferWhaleHint(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  if (/whale|large holder|big holder|liquidat|exchange inflow/.test(text)) {
    if (/sell|outflow|liquidat|inflow to exchange/.test(text)) return "偏空";
    if (/buy|accumulat|inflow to etf/.test(text)) return "偏多";
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
  if (/HTX/i.test(text)) return "HTX";
  if (/Bitdeer/i.test(text)) return "Bitdeer";
  if (/Saylor/i.test(text)) return "Michael Saylor";
  if (/whale/i.test(text)) return "鏈上巨鯨";
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
      const items = await fetchRssItems(feed, 60);
      collected.push(
        ...items
          .filter((item) => {
            if (!item.pubDate) return true;
            const published = dayjs(item.pubDate);
            if (!published.isValid()) return true;
            return now.diff(published, "day") <= MAX_SIGNAL_AGE_DAYS;
          })
          .filter((item) => KEYWORDS.test(`${item.title} ${item.description}`))
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

  const ranked = [...unique.values()]
    .map((signal) => ({
      ...signal,
      priorityScore: majorEventScore(signal)
    }))
    .sort((a, b) => {
      if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
      return dayjs(b.time).valueOf() - dayjs(a.time).valueOf();
    });

  const kept = [];
  const keyChangeCount = new Map();
  for (const signal of ranked) {
    const key = String(signal.keyChange || "").trim();
    const count = keyChangeCount.get(key) || 0;
    if (count >= MAX_SAME_KEYCHANGE) continue;
    keyChangeCount.set(key, count + 1);
    kept.push(signal);
    if (kept.length >= 30) break;
  }

  const aggregated = aggregateSimilarSignals(kept);
  return aggregated.slice(0, 30);
}
