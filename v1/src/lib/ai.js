import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVAL_FILE = path.resolve(__dirname, "../../data/copilot-evaluation.json");

// ── 趨勢判斷 ────────────────────────────────────────────────────────
function scoreTrend(bullCount, bearCount) {
  const total = bullCount + bearCount;
  if (total === 0) return "震盪";
  const ratio = bullCount / total;
  if (ratio >= 0.6) return "偏漲";
  if (ratio <= 0.4) return "偏跌";
  return "震盪";
}

function countBias(signals, biasField = "shortTermBias") {
  let bull = 0, bear = 0;
  for (const s of (signals || [])) {
    const b = s[biasField] || "";
    if (b === "偏漲") bull++;
    else if (b === "偏跌") bear++;
  }
  return { bull, bear };
}

// ── 短線趨勢（近期加密訊號 + 巨鯨 + 清算壓力）────────────────────
function calcShortTerm(rawData) {
  const cryptoBias = countBias(rawData.cryptoSignals);
  const wt = rawData.whaleTrend || {};
  const whaleBull = Number(wt.bull || 0);
  const whaleBear = Number(wt.bear || 0);
  const riskBias = countBias(rawData.globalRiskSignals);

  const bull = cryptoBias.bull + whaleBull + riskBias.bull;
  const bear = cryptoBias.bear + whaleBear + riskBias.bear;
  const trend = scoreTrend(bull, bear);

  const liq = rawData.cryptoSignalMetrics7d?.liquidationTotalUsd || 0;
  const liqNote = liq > 500e6 ? `（近期清算達 ${(liq / 1e6).toFixed(0)}M，槓桿壓力明顯）` : "";

  const reasons = [];
  if (cryptoBias.bull > cryptoBias.bear) reasons.push(`加密訊號偏多（${cryptoBias.bull}多/${cryptoBias.bear}空）`);
  else if (cryptoBias.bear > cryptoBias.bull) reasons.push(`加密訊號偏空（${cryptoBias.bull}多/${cryptoBias.bear}空）`);
  else reasons.push(`加密訊號中性（${cryptoBias.bull}多/${cryptoBias.bear}空）`);

  if (whaleBull > whaleBear) reasons.push(`巨鯨偏多（${whaleBull}/${whaleBear}）`);
  else if (whaleBear > whaleBull) reasons.push(`巨鯨偏空（${whaleBull}/${whaleBear}）`);

  if (riskBias.bear > riskBias.bull) reasons.push("外部風險偏空");

  return {
    trend,
    reason: `短線依據：${reasons.join("；")}${liqNote}。`,
    condition: trend === "偏漲" ? "需外部風險不惡化，且多頭訊號延續"
      : trend === "偏跌" ? "需空頭訊號持續，且無突發政策利多"
      : "等待方向確認，避免重倉操作"
  };
}

// ── 中線趨勢（ETF 資金流 + 宏觀事件方向 + 利率）─────────────────
function calcMidTerm(rawData) {
  const etf = Number(rawData.cryptoSignalMetrics7d?.etfNetFlowUsd || 0);
  const ratesIntel = rawData.ratesIntel || {};
  const tenY = Number(ratesIntel.tenYearYield || 0);
  const twoY = Number(ratesIntel.twoYearYield || 0);
  const inverted = twoY > tenY && tenY > 0;

  const macroEvents = rawData.macroEvents || [];
  const recentResults = macroEvents
    .filter((e) => e.status === "recent" && e.importance === "high" && e.result?.shortTermBias)
    .map((e) => e.result.shortTermBias);
  const macroBias = countBias(recentResults.map((b) => ({ shortTermBias: b })));

  let bull = macroBias.bull;
  let bear = macroBias.bear;
  if (etf > 200e6) bull += 2;
  else if (etf < -200e6) bear += 2;
  if (inverted) bear += 1;

  const trend = scoreTrend(bull, bear);

  const reasons = [];
  if (etf !== 0) reasons.push(`ETF 7D 淨流 ${etf > 0 ? "+" : ""}${(etf / 1e6).toFixed(0)}M USD`);
  if (tenY > 0) reasons.push(`10年債 ${tenY}%${inverted ? "（殖利率倒掛，衰退訊號）" : ""}`);
  if (macroBias.bull + macroBias.bear > 0)
    reasons.push(`近期宏觀結果偏${macroBias.bull > macroBias.bear ? "多" : macroBias.bear > macroBias.bull ? "空" : "中性"}`);

  return {
    trend,
    reason: `中線依據：${reasons.length ? reasons.join("；") : "數據不足，保守中性"}。`,
    condition: trend === "偏漲" ? "需 ETF 持續淨流入且降息預期升溫"
      : trend === "偏跌" ? "需利率持續偏高且機構資金流出"
      : "觀望宏觀數據方向，等待 FOMC 或 CPI 訊號"
  };
}

// ── 長線趨勢（流動性 + 監管 + 機構動向）─────────────────────────
function calcLongTerm(rawData) {
  const liq = rawData.liquidityIntel || {};
  const tvl = Number(liq.totalTvlUsd || 0);
  const stableMcap = Number(liq.stablecoinMarketCapUsd || 0);
  const policySignals = rawData.policySignals || [];
  const regulatoryBull = policySignals.filter((s) => s.shortTermBias === "偏漲").length;
  const regulatoryBear = policySignals.filter((s) => s.shortTermBias === "偏跌").length;

  let bull = regulatoryBull;
  let bear = regulatoryBear;
  if (stableMcap > 150e9) bull += 1;  // 穩定幣市值高 = 流動性充裕
  if (tvl > 80e9) bull += 1;           // DeFi TVL 高 = 鏈上活躍

  const trend = scoreTrend(bull, bear);

  const reasons = [];
  if (tvl > 0) reasons.push(`DeFi TVL ${(tvl / 1e9).toFixed(0)}B USD`);
  if (stableMcap > 0) reasons.push(`穩定幣總市值 ${(stableMcap / 1e9).toFixed(0)}B USD`);
  if (regulatoryBull + regulatoryBear > 0)
    reasons.push(`監管訊號 ${regulatoryBull}正面/${regulatoryBear}負面`);

  return {
    trend,
    reason: `長線依據：${reasons.length ? reasons.join("；") : "流動性數據不足，保守中性"}。`,
    condition: trend === "偏漲" ? "需鏈上流動性持續擴張且監管環境友善"
      : trend === "偏跌" ? "需監管明顯收緊或流動性大幅萎縮"
      : "長線維持中性，等待宏觀週期轉折確認"
  };
}

// ── 10 個段落標籤摘要 ────────────────────────────────────────────
function buildKeyInsights(rawData) {
  const macroEvents = rawData.macroEvents || [];
  const cryptoSignals = rawData.cryptoSignals || [];
  const globalRiskSignals = rawData.globalRiskSignals || [];
  const wt = rawData.whaleTrend || {};
  const metrics = rawData.cryptoSignalMetrics7d || {};
  const ratesIntel = rawData.ratesIntel || {};
  const liq = rawData.liquidityIntel || {};
  const policySignals = rawData.policySignals || [];

  // 1. 政治/政策
  const politicRisks = globalRiskSignals.filter((s) =>
    /政策|政治|制裁|關稅|選舉|trump|白宮/i.test(s.title || s.keyChange || "")
  ).slice(0, 2);
  const p1 = politicRisks.length
    ? `近期政治風險：${politicRisks.map((s) => String(s.keyChange || s.title).slice(0, 60)).join("；")}，需留意政策突發干擾。`
    : "近期無明顯政治/政策突發訊號，宏觀政策面暫時穩定。";

  // 2. 央行/利率
  const tenY = ratesIntel.tenYearYield;
  const twoY = ratesIntel.twoYearYield;
  const threeM = ratesIntel.threeMonthYield;
  const rateStr = [tenY && `10Y ${tenY}%`, twoY && `2Y ${twoY}%`, threeM && `3M ${threeM}%`].filter(Boolean).join("／");
  const p2 = rateStr
    ? `美債殖利率：${rateStr}${twoY && tenY && Number(twoY) > Number(tenY) ? "（倒掛延續，衰退觀察中）" : "（曲線正常化）"}。利率走向是風險資產定價關鍵。`
    : "利率數據暫無更新，持續關注 FRED 與 Fed 聲明。";

  // 3. 美/日政策
  const upcomingFomc = macroEvents.find((e) => e.status === "upcoming" && /fomc|fed|boj|boj/i.test(e.eventType || e.title || ""));
  const recentFomc = macroEvents.filter((e) => e.status === "recent" && e.importance === "high" && /cpi|nfp|ppi|fomc|boj/i.test(e.eventType || "")).slice(0, 2);
  const p3 = recentFomc.length
    ? `近期美/日政策數據：${recentFomc.map((e) => `${e.title}（${e.result?.actual || "待公布"}，${e.result?.shortTermBias || "待評"}）`).join("；")}${upcomingFomc ? `；下次 ${upcomingFomc.title} 即將登場` : ""}。`
    : upcomingFomc ? `近期無重大政策結果，但 ${upcomingFomc.title} 即將到來，建議提前因應。`
    : "近期無美/日重大政策事件。";

  // 4. 機構資金流
  const etf = metrics.etfNetFlowUsd;
  const etfStr = typeof etf === "number" && etf !== 0
    ? `${etf > 0 ? "淨流入" : "淨流出"} ${Math.abs(etf / 1e6).toFixed(0)}M USD`
    : "無可靠 ETF 流量數據";
  const highImpactInst = cryptoSignals.filter((s) =>
    s.impact === "high" && /etf|blackrock|fidelity|institution|機構|灰度|grayscale/i.test(s.title || s.keyChange || "")
  ).slice(0, 2);
  const p4 = `ETF 7D ${etfStr}。${highImpactInst.length ? "機構動向：" + highImpactInst.map((s) => String(s.keyChange || s.title).slice(0, 60)).join("；") + "。" : "無新增高影響機構訊號。"}`;

  // 5. 巨鯨/鏈上
  const p5 = wt.summary
    ? `巨鯨整體${wt.trend}（偏多 ${wt.bull}／偏空 ${wt.bear}）。${wt.details?.length ? "近期動向：" + wt.details.slice(0, 3).map((d) => `${d.actor} ${String(d.action).slice(0, 50)}`).join("；") + "。" : ""}`
    : "巨鯨/鏈上訊號數量不足，暫以中性看待。";

  // 6. 散戶/槓桿
  const liqUsd = metrics.liquidationTotalUsd;
  const liqStr = liqUsd > 0 ? `${(liqUsd / 1e6).toFixed(0)}M USD（來源：${metrics.liquidationSource || "估算"}）` : "無可靠清算數據";
  const fearGreed = rawData.macroIntel?.fearGreedIndex;
  const fgStr = fearGreed ? `，恐慌貪婪指數 ${fearGreed.value}（${fearGreed.label}）` : "";
  const p6 = `近期清算規模 ${liqStr}${fgStr}。槓桿過高時需警惕多殺多/空殺空風險。`;

  // 7. 市場結構
  const tvl = liq.totalTvlUsd;
  const stableMcap = liq.stablecoinMarketCapUsd;
  const tvlStr = tvl ? `DeFi TVL ${(Number(tvl) / 1e9).toFixed(0)}B USD` : "";
  const stableStr = stableMcap ? `穩定幣市值 ${(Number(stableMcap) / 1e9).toFixed(0)}B USD` : "";
  const liquidityStr = [tvlStr, stableStr].filter(Boolean).join("，");
  const p7 = liquidityStr
    ? `市場流動性：${liquidityStr}。${Number(stableMcap) > 150e9 ? "穩定幣市值充裕，乾火藥充足。" : "流動性偏緊，建議觀察。"}`
    : "鏈上流動性數據不足，建議參考 DeFiLlama 最新數字。";

  // 8. 催化/節奏
  const upcoming7d = macroEvents
    .filter((e) => e.status === "upcoming" && e.importance === "high")
    .slice(0, 3)
    .map((e) => e.title);
  const p8 = upcoming7d.length
    ? `未來 7 日關鍵催化劑：${upcoming7d.join("、")}。上述事件前後易有流動性陷阱，建議縮小倉位或設好止損。`
    : "未來 7 日無高影響宏觀事件，行情可能以技術面及新聞面為主導。";

  // 9. 觀察指標
  const watchList = [];
  if (tenY) watchList.push(`10年美債殖利率（現 ${tenY}%）`);
  if (etf !== undefined && etf !== 0) watchList.push("BTC ETF 每日淨流量");
  watchList.push("穩定幣鑄造量變化");
  if (wt.bull + wt.bear > 0) watchList.push(`巨鯨持倉方向（現 ${wt.trend}）`);
  watchList.push("恐慌貪婪指數");
  const p9 = `觀察指標：${watchList.join("、")}。`;

  // 10. 失效條件
  const shortBias = calcShortTerm(rawData).trend;
  const p10 = shortBias === "偏漲"
    ? "失效條件：若 ETF 連續大額淨流出、或重大監管負面消息突發、或美債殖利率急升突破前高，則多頭論點失效。"
    : shortBias === "偏跌"
    ? "失效條件：若 ETF 大幅淨流入、Fed 轉鴿訊號出現、或鏈上巨鯨大量買進，則空頭論點失效。"
    : "失效條件：若市場出現方向性突破（放量漲或跌破支撐），震盪格局立即改變，需重新評估倉位。";

  return [
    `【政治/政策】${p1}`,
    `【央行/利率】${p2}`,
    `【美/日政策】${p3}`,
    `【機構資金流】${p4}`,
    `【巨鯨/鏈上】${p5}`,
    `【散戶/槓桿】${p6}`,
    `【市場結構】${p7}`,
    `【催化/節奏】${p8}`,
    `【觀察指標】${p9}`,
    `【失效條件】${p10}`,
  ];
}

// ── 規則型自動評估（無需任何 API）─────────────────────────────────
function generateEvaluationFromRules(rawData) {
  const short = calcShortTerm(rawData);
  const mid = calcMidTerm(rawData);
  const long = calcLongTerm(rawData);
  const insights = buildKeyInsights(rawData);

  return {
    trendOutlook: {
      shortTermTrend: short.trend,
      midTermTrend: mid.trend,
      longTermTrend: long.trend,
      shortTermCondition: short.condition,
      midTermCondition: mid.condition,
      longTermCondition: long.condition,
      shortReason: short.reason,
      midReason: mid.reason,
      longReason: long.reason,
      aiMeta: { mode: "rule_based", logicVersion: "v1_rules" }
    },
    aiSummary: {
      keyInsights: insights
    }
  };
}

// ── 讀取或自動生成評估 ─────────────────────────────────────────────
function loadOrGenerateEval(rawData) {
  if (fs.existsSync(EVAL_FILE)) {
    console.log("[AI] 使用現有的 copilot-evaluation.json（手動覆蓋模式）");
    return JSON.parse(fs.readFileSync(EVAL_FILE, "utf-8"));
  }

  if (!rawData) {
    throw new Error("[AI] 無 raw data 且無 copilot-evaluation.json，無法生成評估。");
  }

  console.log("[AI] 以規則型邏輯自動生成市場評估…");
  return generateEvaluationFromRules(rawData);
}

// ── 公開 API ────────────────────────────────────────────────────────
let _cachedRawData = null;
export function setRawDataForEval(rawData) {
  _cachedRawData = rawData;
}

export async function buildTraderOutlookFromPayload(payload) {
  const evalData = loadOrGenerateEval(_cachedRawData || payload);
  return evalData.trendOutlook;
}

export async function buildAiSummary(macroEvents, cryptoSignals, globalRiskSignals, trendOutlook) {
  const evalData = loadOrGenerateEval(_cachedRawData);
  return {
    ...evalData.aiSummary,
    aiMeta: { mode: "rule_based", logicVersion: "v1_rules" }
  };
}
