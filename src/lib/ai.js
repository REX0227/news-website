import { safeJsonParse } from "./utils.js";

function fallbackInsight(macroEvents, cryptoSignals) {
  const highImpact = macroEvents.filter((event) => event.importance === "high").slice(0, 5);
  const topSignals = cryptoSignals.slice(0, 5);

  return {
    keyInsights: [
      "關注高影響宏觀事件前後 2-4 小時，虛擬幣波動通常放大。",
      "若同時出現政策/監管新聞與大型資金流事件，短線風險更高。",
      "建議在關鍵時段降低槓桿，並預先設置止損。"
    ],
    eventImpacts: highImpact.map((event) => ({
      eventId: event.id,
      impactSummary: event.impactHint,
      tradingHint: "事件前降低倉位，發布後等待 15-30 分鐘再評估方向。"
    })),
    signalHighlights: topSignals.map((signal) => ({
      signalId: signal.id,
      whyImportant: signal.summary || "市場新聞顯示短期情緒與流動性改變。"
    }))
  };
}

export async function buildAiSummary(macroEvents, cryptoSignals) {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  if (!apiKey) {
    return fallbackInsight(macroEvents, cryptoSignals);
  }

  const payload = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a macro+crypto analyst. Return concise Traditional Chinese JSON with keys: keyInsights(string[]), eventImpacts({eventId,impactSummary,tradingHint}[]), signalHighlights({signalId,whyImportant}[])."
      },
      {
        role: "user",
        content: JSON.stringify({
          macroEvents: macroEvents.slice(0, 40),
          cryptoSignals: cryptoSignals.slice(0, 30)
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
      return fallbackInsight(macroEvents, cryptoSignals);
    }

    return parsed;
  } catch {
    return fallbackInsight(macroEvents, cryptoSignals);
  }
}
