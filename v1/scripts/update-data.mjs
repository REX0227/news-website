import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dayjs from "dayjs";
import dotenv from "dotenv";
import { collectUsMacroEvents } from "../src/collectors/usMacroCollector.js";
import { collectJapanMacroEvents } from "../src/collectors/japanMacroCollector.js";
import { collectCryptoImpactSignals } from "../src/collectors/cryptoImpactCollector.js";
import { collectGlobalRiskSignals } from "../src/collectors/globalRiskCollector.js";
import { collectMarketIntel } from "../src/collectors/marketIntelCollector.js";
import { collectPolicySignals } from "../src/collectors/policyCollector.js";
import { collectRatesIntel } from "../src/collectors/ratesCollector.js";
import { collectLiquidityIntel } from "../src/collectors/liquidityCollector.js";
import { collectCoinalyzeLiquidationMetrics } from "../src/collectors/coinalyzeLiquidationCollector.js";
import { collectMajorNoKeyLiquidationMetrics } from "../src/collectors/majorNoKeyLiquidationCollector.js";
import { buildAiSummary, buildTraderOutlookFromPayload, setRawDataForEval } from "../src/lib/ai.js";
import { enrichRecentMacroResults } from "../src/lib/macroResults.js";
import { eventStatus } from "../src/lib/utils.js";
import { upstashSetJson } from "../src/lib/upstash.js";
import { saveToSQLite, logUpdateToSQLite } from "../src/lib/sqlite.js";
import { fetchRateCutData } from "../src/lib/rateCutData.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

let dotenvResult = dotenv.config();
if (dotenvResult.error) dotenvResult = dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });
if (dotenvResult.error) dotenvResult = dotenv.config({ path: path.join(PROJECT_ROOT, "..", ".env") });

// V1: 更新只寫入 Upstash（不產生/不部署本地 latest.json）。

function buildKeyWindows(macroEvents) {
  const now = dayjs();
  return macroEvents
    .filter((event) => event.importance === "high")
    .filter((event) => dayjs(event.datetime).isAfter(now.subtract(1, "day")) && dayjs(event.datetime).isBefore(now.add(7, "day")))
    .sort((a, b) => dayjs(a.datetime).valueOf() - dayjs(b.datetime).valueOf())
    .slice(0, 8)
    .map((event) => ({
      eventId: event.id,
      title: event.title,
      datetime: event.datetime,
      country: event.country,
      why: event.impactHint
    }));
}

function defaultUpcomingMacroImpact(event) {
  const eventType = String(event.eventType || "").toLowerCase();
  if (eventType === "cpi" || eventType === "ppi") {
    return {
      cryptoImpact: "通膨數據會直接影響降息預期，常造成 BTC/ETH 短線急波動。",
      shortTermBias: "震盪"
    };
  }
  if (eventType === "nfp") {
    return {
      cryptoImpact: "就業數據影響美元與利率預期，風險資產可能快速重定價。",
      shortTermBias: "震盪"
    };
  }
  if (eventType === "central-bank") {
    return {
      cryptoImpact: "央行政策與措辭變動，通常是幣市最重要波動觸發點之一。",
      shortTermBias: "震盪"
    };
  }

  return {
    cryptoImpact: event.impactHint || "可能影響市場風險偏好。",
    shortTermBias: "震盪"
  };
}

function enrichMacroDefaultImpact(events) {
  return events.map((event) => {
    if (event.status !== "recent") return event;

    const existingResult = event.result || {};
    const fallback = defaultUpcomingMacroImpact(event);

    return {
      ...event,
      result: {
        ...existingResult,
        cryptoImpact: existingResult.cryptoImpact || fallback.cryptoImpact,
        shortTermBias: existingResult.shortTermBias || fallback.shortTermBias
      }
    };
  });
}

function inferActorFromTitle(title = "") {
  if (/BlackRock/i.test(title)) return "BlackRock";
  if (/Fidelity/i.test(title)) return "Fidelity";
  if (/MicroStrategy|Strategy/i.test(title)) return "Strategy";
  if (/Binance/i.test(title)) return "Binance";
  if (/Coinbase/i.test(title)) return "Coinbase";
  if (/HTX/i.test(title)) return "HTX";
  if (/Bitdeer/i.test(title)) return "Bitdeer";
  if (/Saylor/i.test(title)) return "Michael Saylor";
  if (/whale/i.test(title)) return "鏈上巨鯨";
  return "未知主體";
}

function buildWhaleTrend(cryptoSignals) {
  const whaleSignals = cryptoSignals.filter((signal) => signal.whaleHint);
  const bull = whaleSignals.filter((signal) => signal.whaleHint === "偏多").length;
  const bear = whaleSignals.filter((signal) => signal.whaleHint === "偏空").length;
  const neutral = whaleSignals.filter((signal) => signal.whaleHint === "中性").length;

  const trend = bear > bull ? "偏空" : bull > bear ? "偏多" : "中性";
  const summary = whaleSignals.length === 0
    ? "近期新聞中未出現足夠的大戶訊號，暫以中性看待。"
    : `近期待觀察到 ${whaleSignals.length} 則大戶相關訊號（偏多 ${bull} / 偏空 ${bear} / 中性 ${neutral}）。`;

  const details = whaleSignals
    .sort((a, b) => dayjs(b.time).valueOf() - dayjs(a.time).valueOf())
    .slice(0, 6)
    .map((signal) => ({
      time: signal.time,
      actor: signal.whaleActor || inferActorFromTitle(signal.title || signal.keyChange || ""),
      action: signal.keyChange || signal.title,
      bias: signal.shortTermBias || "震盪"
    }));

  return { trend, count: whaleSignals.length, bull, bear, neutral, summary, details };
}

function buildMarketOverview(macroEvents, cryptoSignals, globalRiskSignals, trendOutlook) {
  const upcomingHigh = macroEvents.filter((event) => event.status === "upcoming" && event.importance === "high").length;
  const highRiskSignals = cryptoSignals.filter((signal) => signal.impact === "high").length;
  const bearishSignals = cryptoSignals.filter((signal) => signal.shortTermBias === "偏跌").length;
  const bullishSignals = cryptoSignals.filter((signal) => signal.shortTermBias === "偏漲").length;

  const riskBear = globalRiskSignals.filter((signal) => signal.shortTermBias === "偏跌").length;
  const riskBull = globalRiskSignals.filter((signal) => signal.shortTermBias === "偏漲").length;
  const externalRiskBias = riskBear > riskBull ? "外部風險偏空" : riskBull > riskBear ? "外部風險偏多" : "外部風險中性";

  const nextHighImpact = macroEvents
    .filter((event) => event.status === "upcoming" && event.importance === "high")
    .sort((a, b) => dayjs(a.datetime).valueOf() - dayjs(b.datetime).valueOf())[0] || null;

  const shortTermTrend = trendOutlook?.shortTermTrend || "震盪";
  const midTermTrend = trendOutlook?.midTermTrend || "震盪";
  const longTermTrend = trendOutlook?.longTermTrend || "震盪";
  const overallSummary = `短線${shortTermTrend}；中線${midTermTrend}；長線${longTermTrend}；${externalRiskBias}；近期請優先關注 ${nextHighImpact?.title || "外部風險與資金流"}`;

  return {
    upcomingHigh,
    highRiskSignals,
    shortTermTrend,
    midTermTrend,
    longTermTrend,
    shortTermCondition: trendOutlook?.shortTermCondition || "",
    midTermCondition: trendOutlook?.midTermCondition || "",
    longTermCondition: trendOutlook?.longTermCondition || "",
    shortTrendBasis: {
      bullishSignals,
      bearishSignals,
      riskBull,
      riskBear
    },
    trendModelMeta: trendOutlook?.aiMeta || { mode: "trader_auto" },
    shortTrendReason: trendOutlook?.shortReason || "短線依據：訊號不足，暫以震盪保守判讀。",
    midTrendReason: trendOutlook?.midReason || "中線依據：訊號不足，暫以震盪保守判讀。",
    longTrendReason: trendOutlook?.longReason || "長線依據：訊號不足，暫以震盪保守判讀。",
    globalRiskCount: globalRiskSignals.length,
    externalRiskBias,
    nextHighImpact,
    overallSummary
  };
}

function validateAndNormalizeMetricsBeforePublish(metrics) {
  const normalized = { ...(metrics || {}) };

  if (Number.isFinite(normalized?.latestNewsEtfFlow?.usd)) {
    normalized.etfNetFlowUsd = Number(normalized.latestNewsEtfFlow.usd);
    normalized.etfCountWithAmount = 1;
    normalized.etfFlowSource = "news_latest_signal_validated";
    normalized.etfFlowSanityNote = "新聞 ETF 僅採最近一筆可量化值，避免多篇重複事件加總。";
  }

  if (Number.isFinite(normalized.etfNetFlowUsd) && Math.abs(normalized.etfNetFlowUsd) > 7e9) {
    console.warn(`WARNING: ETF 7D 淨流數值過大（${normalized.etfNetFlowUsd}）疑為長期或是總量數據，自動忽略以防失算。`);
    normalized.etfNetFlowUsd = 0;
    normalized.etfCountWithAmount = 0;
    delete normalized.latestNewsEtfFlow;
    normalized.etfFlowSanityNote = "數值異常過大，已自動忽略";
  }

  if (String(normalized.liquidationSource || "") === "news_estimate") {
    const latestNewsLiqUsd = Number(normalized?.latestNewsLiquidation?.usd);
    if (Number.isFinite(latestNewsLiqUsd) && latestNewsLiqUsd > 0) {
      normalized.liquidationTotalUsd = latestNewsLiqUsd;
      normalized.liquidationCountWithAmount = 1;
      normalized.liquidationSource = "news_latest_signal_validated";
      normalized.liquidationWindowHours = 24;
      normalized.liquidationSanityNote = "新聞清算採最近一筆可量化訊號，避免多篇同事件重複累加。";
    }
  }

  if (Number.isFinite(normalized.liquidationTotalUsd) && normalized.liquidationTotalUsd > 3e9 && String(normalized.liquidationSource || "").includes("news")) {
    console.warn(`WARNING: 新聞清算數值異常偏大（${normalized.liquidationTotalUsd}），已轉為回退機制。`);
    normalized.liquidationTotalUsd = 0;
    normalized.liquidationCountWithAmount = 0;
    delete normalized.latestNewsLiquidation;
    normalized.liquidationSanityNote = "數值異常偏大，已自動忽略";
  }

  return normalized;
}

async function main() {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const writeToken = process.env.UPSTASH_REDIS_REST_TOKEN_WRITE;

  const [usEvents, jpEvents, cryptoSignals, globalRiskSignals, rateCutData, marketIntel, policySignals, ratesIntel, liquidityIntel, coinalyzeLiquidation, noKeyLiquidation] = await Promise.all([
    collectUsMacroEvents(),
    collectJapanMacroEvents(),
    collectCryptoImpactSignals(),
    collectGlobalRiskSignals(),
    fetchRateCutData(),
    collectMarketIntel(),
    collectPolicySignals(),
    collectRatesIntel(),
    collectLiquidityIntel(),
    collectCoinalyzeLiquidationMetrics(),
    collectMajorNoKeyLiquidationMetrics()
  ]);

  const cryptoSignalsPayload = Array.isArray(cryptoSignals?.signals) ? cryptoSignals.signals : (Array.isArray(cryptoSignals) ? cryptoSignals : []);
  const cryptoSignalMetrics7dRaw = cryptoSignals?.metrics7d || null;
  const cryptoSignalMetrics7d = cryptoSignalMetrics7dRaw
    ? { ...cryptoSignalMetrics7dRaw }
    : {
        windowDays: 7,
        etfNetFlowUsd: 0,
        etfCountWithAmount: 0,
        liquidationTotalUsd: 0,
        liquidationCountWithAmount: 0
      };

  if (coinalyzeLiquidation?.available && Number.isFinite(coinalyzeLiquidation.liquidationTotalUsd7d)) {
    cryptoSignalMetrics7d.liquidationTotalUsd = Number(coinalyzeLiquidation.liquidationTotalUsd7d);
    cryptoSignalMetrics7d.liquidationCountWithAmount = Number(coinalyzeLiquidation.samplesWithAmount || 0);
    cryptoSignalMetrics7d.liquidationSource = "coinalyze";
    cryptoSignalMetrics7d.liquidationWindowHours = 7 * 24;
  } else if (noKeyLiquidation?.available && Number.isFinite(noKeyLiquidation.liquidationTotalUsdRecent)) {
    cryptoSignalMetrics7d.liquidationTotalUsd = Number(noKeyLiquidation.liquidationTotalUsdRecent);
    cryptoSignalMetrics7d.liquidationCountWithAmount = Number(noKeyLiquidation.liquidationCountRecent || 0);
    cryptoSignalMetrics7d.liquidationSource = String(noKeyLiquidation.source || "exchange_no_key");
    cryptoSignalMetrics7d.liquidationWindowHours = Number(noKeyLiquidation.windowHours || 0);
  } else if (cryptoSignalMetrics7d?.liquidationFallback?.mode === "latest_news_signal") {
    cryptoSignalMetrics7d.liquidationSource = "news_latest_signal_fallback";
    cryptoSignalMetrics7d.liquidationWindowHours = 24;
  } else {
    cryptoSignalMetrics7d.liquidationSource = "news_estimate";
    cryptoSignalMetrics7d.liquidationWindowHours = 7 * 24;
  }

  const validatedMetrics7d = validateAndNormalizeMetricsBeforePublish(cryptoSignalMetrics7d);

  const baseMacroEvents = [...usEvents, ...jpEvents]
    .map((event) => ({
      ...event,
      status: eventStatus(event.datetime)
    }))
    .sort((a, b) => dayjs(a.datetime).valueOf() - dayjs(b.datetime).valueOf());

  const macroEvents = enrichMacroDefaultImpact(await enrichRecentMacroResults(baseMacroEvents));

  const whaleTrend = buildWhaleTrend(cryptoSignalsPayload);

  const rawDataToEvaluate = {
    macroEvents,
    whaleTrend,
    cryptoSignalMetrics7d: validatedMetrics7d,
    liquidationIntel: coinalyzeLiquidation,
    liquidationIntelNoKey: noKeyLiquidation,
    ratesIntel,
    liquidityIntel,
    macroIntel: marketIntel?.macroIntel,
    cryptoSignals: cryptoSignalsPayload,
    globalRiskSignals
  };

  // 傳入 raw data，讓 ai.js 在沒有 copilot-evaluation.json 時自動呼叫 Claude API
  setRawDataForEval(rawDataToEvaluate);

  const trendOutlook = await buildTraderOutlookFromPayload({
    macroEvents,
    whaleTrend,
    cryptoSignalMetrics7d,
    ratesIntel,
    liquidityIntel,
    macroIntel: marketIntel?.macroIntel
  });
  const aiSummary = await buildAiSummary(macroEvents, cryptoSignalsPayload, globalRiskSignals, trendOutlook);
  const marketOverview = buildMarketOverview(macroEvents, cryptoSignalsPayload, globalRiskSignals, trendOutlook);
  const keyWindows = buildKeyWindows(macroEvents);

  const payload = {
    generatedAt: new Date().toISOString(),
    sources: {
      us: [
        "https://www.bls.gov/schedule/news_release/cpi.htm",
        "https://www.bls.gov/schedule/news_release/empsit.htm",
        "https://www.bls.gov/schedule/news_release/ppi.htm",
        "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
      ],
      jp: ["https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm"],
      market: [
        "https://api.coingecko.com/api/v3/global",
        "https://api.alternative.me/fng/"
      ],
      policy: [
        "https://www.whitehouse.gov/briefing-room/feed/",
        "https://home.treasury.gov/news/press-releases/rss",
        "https://www.federalreserve.gov/feeds/press_all.xml",
        "https://www.sec.gov/news/pressreleases.rss",
        "https://www.cftc.gov/PressRoom/PressReleases/rss"
      ],
      rates: [
        "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10",
        "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2",
        "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO"
      ],
      liquidity: [
        "https://stablecoins.llama.fi/stablecoincharts/all",
        "https://api.llama.fi/v2/chains"
      ],
      cryptoNews: [
        "https://www.coindesk.com/arc/outboundfeeds/rss/",
        "https://cointelegraph.com/rss",
        "https://news.google.com/rss"
      ]
    },
    macroEvents,
    cryptoSignals: cryptoSignalsPayload,
    cryptoSignalMetrics7d: validatedMetrics7d,
    liquidationIntel: coinalyzeLiquidation,
    liquidationIntelNoKey: noKeyLiquidation,
    globalRiskSignals,
    keyWindows,
    keyWindowsNote: keyWindows.length === 0 ? "未來 7 天暫無高影響事件，建議改看外部風險與資金流向。" : "",
    whaleTrend,
    marketOverview,
    rateCutData,
    marketIntel,
    policySignals,
    ratesIntel,
    liquidityIntel,
    aiSummary
  };

  if (upstashUrl && writeToken) {
    console.log(`[upstash] Writing to ${upstashUrl}...`);
    await upstashSetJson({
      baseUrl: upstashUrl,
      token: writeToken,
      key: "crypto_dashboard:latest",
      value: payload
    });
    await upstashSetJson({
      baseUrl: upstashUrl,
      token: writeToken,
      key: "crypto_dashboard:last_updated",
      value: { at: payload.generatedAt }
    });
    console.log(`[upstash] Write complete.`);
  } else {
    console.warn(`[upstash] SKIPPED — UPSTASH_REDIS_REST_URL=${upstashUrl ? "OK" : "MISSING"}, TOKEN_WRITE=${writeToken ? "OK" : "MISSING"}`);
  }

  // Also persist the payload to the local SQLite database (backend/gecko.db).
  // This keeps the local backend API in sync without requiring Upstash to be available.
  const sqliteResult = await saveToSQLite(payload);
  if (sqliteResult.ok) {
    await logUpdateToSQLite("success", 11, null);
  } else {
    await logUpdateToSQLite("error", 11, sqliteResult.error || "unknown sqlite error");
  }

  console.log(`Updated payload with ${payload.macroEvents.length} macro events and ${payload.cryptoSignals.length} crypto signals.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
