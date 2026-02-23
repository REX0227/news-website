import { safeJsonParse } from "./utils.js";
import dayjs from "dayjs";

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

  return {
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
  };
}

export async function buildAiSummary(macroEvents, cryptoSignals, globalRiskSignals = []) {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  if (!apiKey) {
    return fallbackInsight(macroEvents, cryptoSignals, globalRiskSignals);
  }

  const payload = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a crypto macro trading analyst. Return concise Traditional Chinese JSON with keys: keyInsights(string[]), eventImpacts({eventId,impactSummary,tradingHint}[]), signalHighlights({signalId,whyImportant}[]). keyInsights must be actionable, include concrete event/change, crypto impact, and short-term direction (偏漲/偏跌/震盪). Avoid generic advice."
      },
      {
        role: "user",
        content: JSON.stringify({
          macroEvents: macroEvents.slice(0, 40),
          cryptoSignals: cryptoSignals.slice(0, 30),
          globalRiskSignals: globalRiskSignals.slice(0, 20)
        })
      }
    ]
  };

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      return fallbackInsight(macroEvents, cryptoSignals);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    const parsed = safeJsonParse(content, null);

    if (!parsed || !Array.isArray(parsed.keyInsights)) {
      return fallbackInsight(macroEvents, cryptoSignals, globalRiskSignals);
    }

    return parsed;
  } catch {
    return fallbackInsight(macroEvents, cryptoSignals, globalRiskSignals);
  }
}
