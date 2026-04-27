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
import { collectCoinglassDerivatives } from "../src/collectors/coinglassCollector.js";
import { collectCoinglassPerSymbol } from "../src/collectors/coinglassPerSymbolCollector.js";
import { collectVixDxy } from "../src/collectors/vixDxyCollector.js";
import { collectDeribitOptions } from "../src/collectors/deribitCollector.js";
import { collectJin10News } from "../src/collectors/jin10Collector.js";
import { collectRssNews } from "../src/collectors/rssCollector.js";
import { collectPanewsFlash } from "../src/collectors/panewsCollector.js";
import { collectFedRegisterActions } from "../src/collectors/federalRegisterCollector.js";
import { collectBtcMomentum, collectAllMomentum } from "../src/collectors/momentumCollector.js";
import { buildAiSummary, buildTraderOutlookFromPayload } from "../src/lib/ai.js";
import { enrichRecentMacroResults } from "../src/lib/macroResults.js";
import { eventStatus } from "../src/lib/utils.js";
import { upstashSetJson, upstashListPrepend, upstashListTrim } from "../src/lib/upstash.js";
import { saveToSQLite, logUpdateToSQLite, saveFactorsAndGates, getPreviousRunFactors, saveCompositeHistory, saveTrendHistory, saveJin10News, getPollerFactor } from "../src/lib/sqlite.js";
import { computeCompositeScore, computeFactorDelta } from "../src/lib/composite.js";
import { buildFactorVector } from "../src/lib/normalize.js";
import { computeGates, gatesSummary } from "../src/lib/gates.js";
import { fetchRateCutData } from "../src/lib/rateCutData.js";
import { withCache, getCacheMeta } from "../src/lib/collectorCache.js";

// ── Collector 快取 TTL 設定 ────────────────────────────────────────
const MIN = 60 * 1000;
const CACHE_TTL = {
  vixDxy:               3 * MIN,   // 即時市場：盤中隨時變動
  deribitOptions:       3 * MIN,   // 即時選擇權：P/C 比即時
  cryptoImpact:         5 * MIN,   // 突發新聞：加密 RSS 隨時爆出
  globalRisk:           5 * MIN,   // 突發新聞：地緣事件突發性高
  coinglassDerivatives: 20 * MIN,  // 市場結構：4-8h K線，20分足夠
  coinglassPerSymbol:   30 * MIN,  // 多幣種衍生品：28 API calls，30分鐘一次
  allMomentum:           5 * MIN,  // 多幣種動量（BTC/ETH/SOL/XRP）：Binance 公開 API，5 分鐘
  coinalyzeLiquidation: 20 * MIN,  // 市場結構：清算同上
  noKeyLiquidation:     20 * MIN,  // 市場結構：備援清算
  liquidityIntel:       30 * MIN,  // 流動性：DeFiLlama 每小時更新
  marketIntel:          60 * MIN,  // 情緒：Fear&Greed 每日，CoinGecko 每小時
  policySignals:        30 * MIN,  // 重大政策：30 分鐘更新（白宮/Fed/SEC/CFTC）
  rateCutData:          60 * MIN,  // 降息預期：變動緩慢
  usMacro:             120 * MIN,  // 宏觀事件：CPI/NFP 每月
  jpMacro:             120 * MIN,  // 宏觀事件：BOJ 每季
  ratesIntel:          120 * MIN,  // FRED 殖利率：每日更新
};
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
    normalized.etfFlowConfidence = 0.55;
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

  // 確保 confidence 欄位存在：若來源已設定但 confidence 漏填，給保守預設
  if (normalized.etfNetFlowUsd && !Number.isFinite(normalized.etfFlowConfidence)) {
    normalized.etfFlowConfidence = 0.55;
  }
  if (normalized.liquidationTotalUsd && !Number.isFinite(normalized.liquidationConfidence)) {
    normalized.liquidationConfidence = 0.5;
  }

  return normalized;
}

async function main() {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const writeToken = process.env.UPSTASH_REDIS_REST_TOKEN_WRITE;

  const [usEvents, jpEvents, cryptoSignals, globalRiskSignals, rateCutData, marketIntel, policySignals, ratesIntel, liquidityIntel, coinalyzeLiquidation, noKeyLiquidation, coinglassDerivatives, vixDxy, deribitOptions, coinglassPerSymbol, allMomentum] = await Promise.all([
    withCache('usMacro',              CACHE_TTL.usMacro,             () => collectUsMacroEvents()),
    withCache('jpMacro',              CACHE_TTL.jpMacro,             () => collectJapanMacroEvents()),
    withCache('cryptoImpact',         CACHE_TTL.cryptoImpact,        () => collectCryptoImpactSignals()),
    withCache('globalRisk',           CACHE_TTL.globalRisk,          () => collectGlobalRiskSignals()),
    withCache('rateCutData',          CACHE_TTL.rateCutData,         () => fetchRateCutData()),
    withCache('marketIntel',          CACHE_TTL.marketIntel,         () => collectMarketIntel()),
    withCache('policySignals',        CACHE_TTL.policySignals,       () => collectPolicySignals()),
    withCache('ratesIntel',           CACHE_TTL.ratesIntel,          () => collectRatesIntel()),
    withCache('liquidityIntel',       CACHE_TTL.liquidityIntel,      () => collectLiquidityIntel()),
    withCache('coinalyzeLiquidation', CACHE_TTL.coinalyzeLiquidation,() => collectCoinalyzeLiquidationMetrics()),
    withCache('noKeyLiquidation',     CACHE_TTL.noKeyLiquidation,    () => collectMajorNoKeyLiquidationMetrics()),
    withCache('coinglassDerivatives', CACHE_TTL.coinglassDerivatives,() => collectCoinglassDerivatives()),
    withCache('vixDxy',               CACHE_TTL.vixDxy,              () => collectVixDxy()),
    withCache('deribitOptions',       CACHE_TTL.deribitOptions,      () => collectDeribitOptions()),
    withCache('coinglassPerSymbol',   CACHE_TTL.coinglassPerSymbol,  () => collectCoinglassPerSymbol()),
    withCache('allMomentum',           CACHE_TTL.allMomentum,         () => collectAllMomentum()),
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
    cryptoSignalMetrics7d.liquidationConfidence = 0.95;
    cryptoSignalMetrics7d.liquidationWindowHours = 7 * 24;
  } else if (noKeyLiquidation?.available && Number.isFinite(noKeyLiquidation.liquidationTotalUsdRecent)) {
    cryptoSignalMetrics7d.liquidationTotalUsd = Number(noKeyLiquidation.liquidationTotalUsdRecent);
    cryptoSignalMetrics7d.liquidationCountWithAmount = Number(noKeyLiquidation.liquidationCountRecent || 0);
    cryptoSignalMetrics7d.liquidationSource = String(noKeyLiquidation.source || "exchange_no_key");
    cryptoSignalMetrics7d.liquidationConfidence = 0.8;
    cryptoSignalMetrics7d.liquidationWindowHours = Number(noKeyLiquidation.windowHours || 0);
  } else if (cryptoSignalMetrics7d?.liquidationFallback?.mode === "latest_news_signal") {
    cryptoSignalMetrics7d.liquidationSource = "news_latest_signal_fallback";
    cryptoSignalMetrics7d.liquidationConfidence = 0.5;
    cryptoSignalMetrics7d.liquidationWindowHours = 24;
  } else {
    cryptoSignalMetrics7d.liquidationSource = "news_estimate";
    cryptoSignalMetrics7d.liquidationConfidence = 0.5;
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

  // FIX: 統一使用完整 rawDataToEvaluate，直接傳入 ai.js（移除全域 _cachedRawData）
  // FIX: marketIntel 完整傳入（非 marketIntel?.macroIntel，該子 key 不存在）
  // FIX: policySignals 加入，供 ai.js calcLongTerm 使用
  const rawDataToEvaluate = {
    macroEvents,
    whaleTrend,
    cryptoSignalMetrics7d: validatedMetrics7d,
    liquidationIntel: coinalyzeLiquidation,
    liquidationIntelNoKey: noKeyLiquidation,
    ratesIntel,
    liquidityIntel,
    marketIntel,
    coinglassDerivatives,
    coinglassPerSymbol,
    vixDxy,
    deribitOptions,
    cryptoSignals: cryptoSignalsPayload,
    globalRiskSignals,
    policySignals,
    allMomentum         // §4.2 多幣種價格動量（BTC/ETH/SOL/XRP）
  };

  const trendOutlook = await buildTraderOutlookFromPayload(rawDataToEvaluate);
  const aiSummary = await buildAiSummary(rawDataToEvaluate);
  const marketOverview = buildMarketOverview(macroEvents, cryptoSignalsPayload, globalRiskSignals, trendOutlook);
  const keyWindows = buildKeyWindows(macroEvents);

  // ── Factor / Gate Pipeline（交易系統消息面來源）─────────────────
  const factorVector    = buildFactorVector(rawDataToEvaluate);

  // ── DB-backed 高精度覆蓋（來自背景 poller，多交易所 z-score）────────────────
  // 僅在 poller 數據新鮮時才覆蓋，舊 collector 資料保底
  //
  // 1. 清算 7D z-score（cg-liq-poller，15m 解析度，Binance+Bybit+OKX+Gate）
  //    覆蓋 derivatives.liquidation_7d（原為 coinglassCollector 1d bucket）
  const liqDbFactor = getPollerFactor("crypto.derivatives.BTC.liquidation_7d", 30);
  if (liqDbFactor && factorVector["derivatives.liquidation_7d"]) {
    factorVector["derivatives.liquidation_7d"].score       = liqDbFactor.score;
    factorVector["derivatives.liquidation_7d"].direction   = liqDbFactor.direction;
    factorVector["derivatives.liquidation_7d"].confidence  = liqDbFactor.confidence;
    factorVector["derivatives.liquidation_7d"].source_detail = "coinglass_15m_multiexch_zscore";
    factorVector["derivatives.liquidation_7d"].db_age_min  = liqDbFactor.age_min;
    console.log(`[factor-override] liquidation_7d → DB z-score=${liqDbFactor.score} (${liqDbFactor.direction}, ${liqDbFactor.age_min}min old)`);
  }

  // 2. 資金費率 90D z-score（cg-fr-poller，多交易所 8h/1h，90d 歷史）
  //    覆蓋 derivatives.btc_funding_rate（原為 coinglassCollector Binance 單一費率）
  const frDbFactor = getPollerFactor("crypto.derivatives.BTC.funding_rate_zscore", 60);
  if (frDbFactor && factorVector["derivatives.btc_funding_rate"]) {
    factorVector["derivatives.btc_funding_rate"].score       = frDbFactor.score;
    factorVector["derivatives.btc_funding_rate"].direction   = frDbFactor.direction;
    factorVector["derivatives.btc_funding_rate"].confidence  = frDbFactor.confidence;
    factorVector["derivatives.btc_funding_rate"].source_detail = "coinglass_multiexch_90d_zscore";
    factorVector["derivatives.btc_funding_rate"].db_age_min  = frDbFactor.age_min;
    console.log(`[factor-override] btc_funding_rate → DB z-score=${frDbFactor.score} (${frDbFactor.direction}, ${frDbFactor.age_min}min old)`);
  } else if (!frDbFactor) {
    console.log(`[factor-override] btc_funding_rate — DB factor stale/missing, using coinglassCollector fallback`);
  }

  const gateConditions  = computeGates(factorVector);
  const gatesSummaryData = gatesSummary(gateConditions);

  // composite_score + factor_delta（寫入 payload 供前端直接讀取）
  const compositeScore  = computeCompositeScore(factorVector);
  const previousRows    = getPreviousRunFactors();  // 取上一次 run 資料（在 save 之前）
  const factorDelta     = computeFactorDelta(factorVector, previousRows);

  console.log(`[factors] Built ${Object.keys(factorVector).length} factors, ${Object.keys(gateConditions).length} gates`);
  console.log(`[composite] score=${compositeScore?.score ?? "N/A"} (${compositeScore?.label ?? "N/A"}), coverage=${compositeScore?.coverage_pct ?? 0}%`);
  console.log(`[delta] ${factorDelta.count} factors changed`);
  console.log(`[gates] Summary:`, JSON.stringify(gatesSummaryData, null, 2));

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
    coinglassDerivatives,
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
    aiSummary,
    compositeScore,         // Factor 綜合評分（-1~+1，含 label / coverage）
    gateScore: compositeScore?.score ?? null,   // 平層別名，方便外部整合直接讀取
    gateLabel: compositeScore?.label ?? null,   // 平層別名，方便外部整合直接讀取
    factorDelta,            // 本次 run 相比上次的 factor 方向/分數變化
    collectorFetchTimes: getCacheMeta()  // 各 collector 最後真正打 API 的時間
  };

  // ── Upstash 寫入（保留原始 dashboard + 新增 factors/gates）───────
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
    // 新增：factors / gates 獨立 key（供交易程式直接讀取）
    await upstashSetJson({
      baseUrl: upstashUrl,
      token: writeToken,
      key: "crypto_factors:latest",
      value: { computed_at: payload.generatedAt, factors: factorVector }
    });
    await upstashSetJson({
      baseUrl: upstashUrl,
      token: writeToken,
      key: "crypto_gates:latest",
      value: { computed_at: payload.generatedAt, gates: gateConditions, summary: gatesSummaryData }
    });
    // composite_score 歷史走勢（Redis list，保留最近 24 筆 ≈ 2 小時@5min）
    if (compositeScore) {
      const histEntry = {
        t: payload.generatedAt,
        s: compositeScore.score,
        l: compositeScore.label
      };
      await upstashListPrepend({ baseUrl: upstashUrl, token: writeToken, key: "crypto_composite:history", value: histEntry });
      await upstashListTrim({ baseUrl: upstashUrl, token: writeToken, key: "crypto_composite:history", keepLast: 144 });
    }
    console.log(`[upstash] Write complete.`);
  } else {
    console.warn(`[upstash] SKIPPED — UPSTASH_REDIS_REST_URL=${upstashUrl ? "OK" : "MISSING"}, TOKEN_WRITE=${writeToken ? "OK" : "MISSING"}`);
  }

  // ── 聯邦公報行政令：寫入 SQLite（非同步，不阻塞主流程）──────────
  collectFedRegisterActions({ limit: 20 }).then(result => {
    if (!result.ok || result.items.length === 0) return;
    saveJin10News(result.items, "fedregister");
  }).catch(() => {});

  // ── PANews 快訊：寫入 SQLite（非同步，不阻塞主流程）──────────────
  collectPanewsFlash({ limit: 50 }).then(result => {
    if (!result.ok || result.items.length === 0) return;
    saveJin10News(result.items, "panews");
  }).catch(() => {});

  // ── RSS 快訊（CoinDesk + CoinTelegraph）：寫入 SQLite（非同步，不阻塞主流程）──
  collectRssNews({ limit: 30 }).then(rssResults => {
    for (const result of rssResults) {
      if (!result.ok || result.items.length === 0) continue;
      saveJin10News(result.items, result.source);
    }
  }).catch(() => {});

  // ── 金十快訊：寫入 SQLite + Upstash（非同步，不阻塞主流程）───────
  collectJin10News({ onlyImportant: true, limit: 30 }).then(async jin10Result => {
    if (!jin10Result.ok || jin10Result.items.length === 0) return;
    // 1. 寫 SQLite（歷史累積）
    saveJin10News(jin10Result.items);
    // 2. 寫 Upstash（GitHub Pages fallback）
    if (upstashUrl && writeToken) {
      // 寫 jin10:latest（最新這批，供 GitHub Pages 即時顯示用）
      await upstashSetJson({
        baseUrl: upstashUrl,
        token: writeToken,
        key: "jin10:latest",
        value: { updatedAt: new Date().toISOString(), items: jin10Result.items }
      });
      // 寫 jin10:history list（每筆個別 lpush，保留最近 200 筆）
      for (const item of jin10Result.items) {
        await upstashListPrepend({ baseUrl: upstashUrl, token: writeToken, key: "jin10:history", value: item });
      }
      await upstashListTrim({ baseUrl: upstashUrl, token: writeToken, key: "jin10:history", keepLast: 200 });
    }
  }).catch(() => {});

  // ── SQLite 寫入（保留 dashboard + 新增時序 factor/gate 歷史）─────
  const sqliteResult = await saveToSQLite(payload);
  const factorGateResult = await saveFactorsAndGates(factorVector, gateConditions, {
    startedAt: payload.generatedAt,
    collectorsOk: ["usMacro", "jpMacro", "cryptoImpact", "globalRisk", "rateCut", "marketIntel", "policy", "rates", "liquidity", "coinalyze", "noKeyLiq", "coinglassDerivatives", "vixDxy", "deribit", "cgPerSymbol"],
    collectorsFailed: []
  });

  if (compositeScore) {
    await saveCompositeHistory(compositeScore, factorGateResult.runId || null);
  }

  // 儲存趨勢判斷歷史（供回測驗證平台訊號有效性）
  await saveTrendHistory(trendOutlook, {
    compositeScore,
    runId: factorGateResult.runId || null
  });

  if (sqliteResult.ok) {
    await logUpdateToSQLite("success", 11, null);
  } else {
    await logUpdateToSQLite("error", 11, sqliteResult.error || "unknown sqlite error");
  }

  console.log(`Updated payload with ${payload.macroEvents.length} macro events, ${payload.cryptoSignals.length} signals, ${Object.keys(factorVector).length} factors.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
