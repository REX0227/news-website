import process from "node:process";
import dayjs from "dayjs";

const ASSESSMENT_META = {
  mode: "trader_auto",
  logicVersion: "v2_llm"
};

function withAiMeta(payload, meta) {
  return {
    ...payload,
    aiMeta: meta
  };
}

async function callLLM(systemPrompt, userPrompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY environment variable. LLM evaluation is required by product constraints.");
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API Error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  return JSON.parse(content);
}

export async function buildTraderOutlookFromPayload(payload) {
  const systemPrompt = `You are a senior crypto trader and macro strategist. 
Analyze the provided market data payload and return a concise Traditional Chinese JSON object with the following keys:
- shortTermTrend: "偏漲" | "偏跌" | "震盪" (Next 1-7 days)
- midTermTrend: "偏漲" | "偏跌" | "震盪" (Next 2-6 weeks)
- longTermTrend: "偏漲" | "偏跌" | "震盪" (Next 1-3 months)
- shortReason: Concrete reason for short-term trend based on recent events/liquidations.
- midReason: Concrete reason for mid-term trend based on ETFs/rates/policy.
- longReason: Concrete reason for long-term trend based on macro liquidity/TVL.
Do not use generic advice. Cite specific data points from the payload.`;

  const userPrompt = JSON.stringify(payload, null, 2);
  
  try {
    const result = await callLLM(systemPrompt, userPrompt);
    return result;
  } catch (error) {
    console.error("Failed to build trader outlook via LLM:", error);
    throw error;
  }
}

export async function buildAiSummary(macroEvents, cryptoSignals, globalRiskSignals = [], trendOutlook = null) {
  const systemPrompt = `You are a crypto macro trading analyst. 
Analyze the provided events and signals, and return a concise Traditional Chinese JSON object with the following keys:
- keyInsights: Array of 3-5 string insights. Must be actionable, include concrete event/change, crypto impact, and short-term direction.
- eventImpacts: Array of objects { eventId: string, impactSummary: string, tradingHint: string } for upcoming high-impact macro events.
- signalHighlights: Array of objects { signalId: string, whyImportant: string } for top crypto signals.
Do not use generic advice.`;

  const userPrompt = JSON.stringify({
    macroEvents: macroEvents.filter(e => e.importance === "high" || e.status === "recent").slice(0, 10),
    cryptoSignals: cryptoSignals.slice(0, 10),
    globalRiskSignals: globalRiskSignals.slice(0, 5),
    trendOutlook
  }, null, 2);

  try {
    const result = await callLLM(systemPrompt, userPrompt);
    
    const keyInsights = Array.isArray(result.keyInsights) ? result.keyInsights : [];
    if (trendOutlook?.shortTermTrend && trendOutlook?.midTermTrend && trendOutlook?.longTermTrend) {
      keyInsights.unshift(`【交易員總結】短線(1-7天)：${trendOutlook.shortTermTrend}，中線(2-6週)：${trendOutlook.midTermTrend}，長線(1-3個月)：${trendOutlook.longTermTrend}。`);
    }

    return withAiMeta({
      ...result,
      keyInsights
    }, ASSESSMENT_META);
  } catch (error) {
    console.error("Failed to build AI summary via LLM:", error);
    throw error;
  }
}
