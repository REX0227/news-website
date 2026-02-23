import { safeJsonParse } from "./utils.js";
import dayjs from "dayjs";

const PROMPT_VERSION = "v2.1";
const SYSTEM_PROMPT = "You are a crypto macro trading analyst. Return concise Traditional Chinese JSON with keys: keyInsights(string[]), eventImpacts({eventId,impactSummary,tradingHint}[]), signalHighlights({signalId,whyImportant}[]). keyInsights must be actionable, include concrete event/change, crypto impact, and short-term direction (偏漲/偏跌/震盪). Avoid generic advice.";
const TREND_PROMPT_VERSION = "v1.2";
const TREND_SYSTEM_PROMPT = "You are a senior crypto trader and macro strategist. Return concise Traditional Chinese JSON with keys: shortTermTrend, midTermTrend, longTermTrend, shortReason, midReason, longReason. Trend must be one of 偏漲/偏跌/震盪. Horizons: shortTerm=next 1-7 days, midTerm=next 2-6 weeks, longTerm=next 1-3 months. Each reason must be concrete and causal: (1) cite at least 2-3 specific drivers with time tags (date or 幾天前/幾天後), (2) explain transmission path to BTC/ETH risk appetite/liquidity/USDT demand/yields, (3) explain why this supports your direction, (4) explicitly state stale signals are down-weighted. You must synthesize macro events, crypto signals, and external risks together as one portfolio view. Never justify trend using only counts like 多訊息>空訊息.";

const OPENAI_DISABLED_NOTICE = "已依設定取消 OpenAI 自動評估：請使用『人工交易員評估』手動回寫（scripts/manual-ai-update.mjs）。";

function withAiMeta(payload, meta) {
  return {
    ...payload,
    aiMeta: meta
  };
}

function fallbackInsight(macroEvents, cryptoSignals, globalRiskSignals) {
  const upcomingHigh = macroEvents
    .filter((event) => event.importance === "high" && event.status === "upcoming")
    .sort((a, b) => dayjs(a.datetime).valueOf() - dayjs(b.datetime).valueOf())
    .slice(0, 3);

  const topSignals = cryptoSignals.slice(0, 3);
  const topRisks = globalRiskSignals.slice(0, 2);

  const dryInsights = [];

  if (upcomingHigh.length > 0) {
    for (const event of upcomingHigh) {
      dryInsights.push(`【時間】${dayjs(event.datetime).format("MM/DD HH:mm")} ${event.title}｜【影響】${event.result?.cryptoImpact || event.impactHint}｜【短線】${event.result?.shortTermBias || "震盪"}`);
    }
  } else {
    dryInsights.push("未來 7 天無高影響數據，盤勢可能由外部政策與資金面主導。", "操作重點改看：監管消息、地緣政治、ETF/交易所資金流。", "槓桿策略宜保守，避免在低事件密度區間過度交易。");
  }

  for (const signal of topSignals) {
    dryInsights.push(`【事件】${signal.keyChange || signal.zhTitle}｜【對幣市】${signal.cryptoImpact}｜【短線】${signal.shortTermBias}`);
  }

  for (const risk of topRisks) {
    dryInsights.push(`【外部風險】${risk.keyChange}｜【對幣市】${risk.cryptoImpact}｜【短線】${risk.shortTermBias}`);
  }

  return withAiMeta({
    keyInsights: dryInsights.slice(0, 8),
    eventImpacts: upcomingHigh.map((event) => ({
      eventId: event.id,
      impactSummary: event.result?.cryptoImpact || event.impactHint,
      tradingHint: `短線方向：${event.result?.shortTermBias || "震盪"}；建議事件前 30 分鐘降低槓桿。`
    })),
    signalHighlights: topSignals.map((signal) => ({
      signalId: signal.id,
      whyImportant: `${signal.keyChange || signal.zhTitle}；短線 ${signal.shortTermBias}。`
    }))
  }, {
    mode: "fallback",
    promptVersion: PROMPT_VERSION,
    model: "rule-based"
  });
}

function toAgeDays(value) {
  const t = dayjs(value);
  if (!t.isValid()) return null;
  return Math.max(0, dayjs().diff(t, "day", true));
}

function decayWeight(ageDays, halfLifeDays) {
  if (!Number.isFinite(ageDays)) return 0;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 0;
  return Math.exp(-Math.log(2) * (ageDays / halfLifeDays));
}

function trendDirection(text = "") {
  if (text === "偏漲") return 1;
  if (text === "偏跌") return -1;
  return 0;
}

function impactWeight(level = "medium") {
  if (level === "high") return 1.4;
  if (level === "low") return 0.7;
  return 1;
}

function buildTrendContext(macroEvents, cryptoSignals, globalRiskSignals) {
  const now = dayjs();
  const horizons = {
    short: { maxAgeDays: 7, halfLifeDays: 3 },
    mid: { maxAgeDays: 42, halfLifeDays: 12 },
    long: { maxAgeDays: 120, halfLifeDays: 35 }
  };

  const recentCrypto = (cryptoSignals || [])
    .map((signal) => {
      const ageDays = toAgeDays(signal.time);
      return {
        id: signal.id,
        title: signal.keyChange || signal.zhTitle || signal.title,
        bias: signal.shortTermBias || "震盪",
        impact: signal.impact || "medium",
        time: signal.time,
        ageDays,
        type: "crypto"
      };
    })
    .filter((signal) => Number.isFinite(signal.ageDays) && signal.ageDays <= horizons.long.maxAgeDays + 20);

  const recentRisk = (globalRiskSignals || [])
    .map((signal) => {
      const ageDays = toAgeDays(signal.time);
      return {
        id: signal.id,
        title: signal.keyChange || signal.title,
        bias: signal.shortTermBias || "震盪",
        impact: signal.impact || "medium",
        time: signal.time,
        ageDays,
        type: "risk"
      };
    })
    .filter((signal) => Number.isFinite(signal.ageDays) && signal.ageDays <= horizons.long.maxAgeDays + 20);

  const recentMacro = (macroEvents || [])
    .filter((event) => event.status === "recent" || event.status === "upcoming")
    .map((event) => {
      const ageDays = event.status === "upcoming"
        ? Math.max(0, dayjs(event.datetime).diff(now, "day", true))
        : toAgeDays(event.datetime);
      return {
        id: event.id,
        title: event.title,
        bias: event.result?.shortTermBias || "震盪",
        importance: event.importance || "medium",
        status: event.status,
        datetime: event.datetime,
        ageDays,
        type: "macro"
      };
    })
    .filter((event) => Number.isFinite(event.ageDays) && event.ageDays <= horizons.long.maxAgeDays + 30);

  const scoreFor = (bucket) => {
    const cfg = horizons[bucket];
    const cryptoScore = recentCrypto.reduce((acc, signal) => {
      if (signal.ageDays > cfg.maxAgeDays) return acc;
      return acc + trendDirection(signal.bias) * impactWeight(signal.impact) * decayWeight(signal.ageDays, cfg.halfLifeDays);
    }, 0);

    const riskScore = recentRisk.reduce((acc, signal) => {
      if (signal.ageDays > cfg.maxAgeDays) return acc;
      return acc + trendDirection(signal.bias) * impactWeight(signal.impact) * 1.1 * decayWeight(signal.ageDays, cfg.halfLifeDays);
    }, 0);

    const macroScore = recentMacro.reduce((acc, event) => {
      const relevanceAge = event.status === "upcoming" ? event.ageDays : event.ageDays;
      if (relevanceAge > cfg.maxAgeDays) return acc;
      const direction = trendDirection(event.bias);
      const importance = impactWeight(event.importance);
      const statusBoost = event.status === "upcoming" ? 1.15 : 1;
      return acc + direction * importance * statusBoost * decayWeight(relevanceAge, cfg.halfLifeDays * 1.35);
    }, 0);

    return {
      total: Number((cryptoScore + riskScore + macroScore).toFixed(3)),
      crypto: Number(cryptoScore.toFixed(3)),
      risk: Number(riskScore.toFixed(3)),
      macro: Number(macroScore.toFixed(3))
    };
  };

  const topDrivers = [...recentCrypto, ...recentRisk, ...recentMacro]
    .map((item) => {
      const dir = trendDirection(item.bias);
      const base = item.type === "macro" ? impactWeight(item.importance) : impactWeight(item.impact);
      const weight = dir * base * decayWeight(item.ageDays, 12);
      return {
        type: item.type,
        title: item.title,
        bias: item.bias,
        ageDays: Number(item.ageDays.toFixed(1)),
        status: item.status || "recent",
        time: item.time || item.datetime,
        weightedContribution: Number(weight.toFixed(3))
      };
    })
    .filter((item) => Math.abs(item.weightedContribution) > 0.08)
    .sort((a, b) => Math.abs(b.weightedContribution) - Math.abs(a.weightedContribution))
    .slice(0, 10);

  return {
    horizons,
    weightedScores: {
      short: scoreFor("short"),
      mid: scoreFor("mid"),
      long: scoreFor("long")
    },
    stalePolicy: "超過對應時窗的訊號僅作背景參考，不得作為主要判斷依據。",
    topDrivers
  };
}

function normalizeTrend(value) {
  return ["偏漲", "偏跌", "震盪"].includes(value) ? value : "震盪";
}

export async function buildAiSummary(macroEvents, cryptoSignals, globalRiskSignals = []) {
  return withAiMeta({
    keyInsights: [OPENAI_DISABLED_NOTICE],
    eventImpacts: [],
    signalHighlights: []
  }, {
    mode: "disabled_manual_only",
    promptVersion: PROMPT_VERSION,
    model: "none"
  });
}

function fallbackTrendOutlook(macroEvents, cryptoSignals, globalRiskSignals) {
  const bullishSignals = cryptoSignals.filter((signal) => signal.shortTermBias === "偏漲").length;
  const bearishSignals = cryptoSignals.filter((signal) => signal.shortTermBias === "偏跌").length;
  const riskBull = globalRiskSignals.filter((signal) => signal.shortTermBias === "偏漲").length;
  const riskBear = globalRiskSignals.filter((signal) => signal.shortTermBias === "偏跌").length;

  const upcomingHigh = macroEvents.filter((event) => event.status === "upcoming" && event.importance === "high").length;
  const recentCpiBear = macroEvents.filter((event) => event.eventType === "cpi" && event.status === "recent" && event.result?.shortTermBias === "偏跌").length;
  const recentNfpBull = macroEvents.filter((event) => event.eventType === "nfp" && event.status === "recent" && event.result?.shortTermBias === "偏漲").length;

  const shortScore = bullishSignals + riskBull - bearishSignals - riskBear;
  const longScore = recentNfpBull - recentCpiBear + (upcomingHigh <= 4 ? 1 : -1);

  const shortTermTrend = shortScore > 1 ? "偏漲" : shortScore < -1 ? "偏跌" : "震盪";
  const longTermTrend = longScore > 0 ? "偏漲" : longScore < 0 ? "偏跌" : "震盪";

  return {
    shortTermTrend,
    longTermTrend,
    shortReason: `短線依據：幣圈偏多 ${bullishSignals} / 偏空 ${bearishSignals}，外部風險偏多 ${riskBull} / 偏空 ${riskBear}`,
    longReason: `長線依據：近期通膨偏空訊號 ${recentCpiBear}、就業偏多訊號 ${recentNfpBull}、未來高影響事件 ${upcomingHigh}`,
    aiMeta: {
      mode: "fallback",
      promptVersion: TREND_PROMPT_VERSION,
      model: "rule-based"
    }
  };
}

export async function buildTrendOutlook(macroEvents, cryptoSignals, globalRiskSignals = []) {
  return {
    shortTermTrend: "待人工AI評估",
    midTermTrend: "待人工AI評估",
    longTermTrend: "待人工AI評估",
    shortReason: OPENAI_DISABLED_NOTICE,
    midReason: OPENAI_DISABLED_NOTICE,
    longReason: OPENAI_DISABLED_NOTICE,
    aiMeta: {
      mode: "disabled_manual_only",
      promptVersion: TREND_PROMPT_VERSION,
      model: "none"
    }
  };
}
