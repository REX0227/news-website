import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dayjs from "dayjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

let dotenvResult = dotenv.config();
if (dotenvResult.error) dotenvResult = dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });
if (dotenvResult.error) dotenvResult = dotenv.config({ path: path.join(PROJECT_ROOT, "..", ".env") });

const args = new Set(process.argv.slice(2));
const allowAuto = args.has("--auto");

const base = process.env.UPSTASH_REDIS_REST_URL;
const readToken = process.env.UPSTASH_REDIS_REST_TOKEN_READ;
const writeToken = process.env.UPSTASH_REDIS_REST_TOKEN_WRITE;
const key = "crypto_dashboard:latest";

if (!base || !readToken || !writeToken) {
  throw new Error("Missing Upstash env vars");
}

const getRes = await fetch(`${base}/get/${encodeURIComponent(key)}`, {
  headers: { Authorization: `Bearer ${readToken}` }
});
if (!getRes.ok) throw new Error(`get failed ${getRes.status}`);

const raw = await getRes.json();
const data = typeof raw.result === "string" ? JSON.parse(raw.result) : raw.result;

const crypto = data.cryptoSignals || [];
const risks = data.globalRiskSignals || [];
const macro = data.macroEvents || [];

function ageDays(value) {
  const t = dayjs(value);
  if (!t.isValid()) return null;
  return Math.max(0, dayjs().diff(t, "day", true));
}

function decay(age, halfLife) {
  if (!Number.isFinite(age) || !Number.isFinite(halfLife) || halfLife <= 0) return 0;
  return Math.exp(-Math.log(2) * (age / halfLife));
}

function direction(bias = "") {
  if (bias === "偏漲") return 1;
  if (bias === "偏跌") return -1;
  return 0;
}

function impactMultiplier(level = "medium") {
  if (level === "high") return 1.4;
  if (level === "low") return 0.7;
  return 1;
}

function scoreSignals(signals, cfg) {
  return signals.reduce((acc, signal) => {
    const age = ageDays(signal.time);
    if (!Number.isFinite(age) || age > cfg.maxAge) return acc;
    const weight = direction(signal.shortTermBias) * impactMultiplier(signal.impact) * decay(age, cfg.halfLife);
    return acc + weight;
  }, 0);
}

function scoreMacro(events, cfg) {
  return events.reduce((acc, event) => {
    const isUpcoming = event.status === "upcoming";
    const age = isUpcoming
      ? Math.max(0, dayjs(event.datetime).diff(dayjs(), "day", true))
      : ageDays(event.datetime);
    if (!Number.isFinite(age) || age > cfg.maxAge) return acc;
    const weight = direction(event.result?.shortTermBias) * impactMultiplier(event.importance) * (isUpcoming ? 1.15 : 1) * decay(age, cfg.halfLife * 1.3);
    return acc + weight;
  }, 0);
}

function labelTrend(score) {
  if (score >= 0.8) return "偏漲";
  if (score <= -0.8) return "偏跌";
  return "震盪";
}

function topDrivers({ cryptoSignals, riskSignals, macroEvents }, maxAge, halfLife) {
  const points = [];

  for (const signal of cryptoSignals) {
    const age = ageDays(signal.time);
    if (!Number.isFinite(age) || age > maxAge) continue;
    const contribution = direction(signal.shortTermBias) * impactMultiplier(signal.impact) * decay(age, halfLife);
    points.push({
      text: `${signal.keyChange || signal.zhTitle || signal.title}（${age.toFixed(1)}天前，${signal.shortTermBias || "震盪"}）`,
      contribution
    });
  }

  for (const signal of riskSignals) {
    const age = ageDays(signal.time);
    if (!Number.isFinite(age) || age > maxAge) continue;
    const contribution = direction(signal.shortTermBias) * impactMultiplier(signal.impact) * 1.1 * decay(age, halfLife);
    points.push({
      text: `${signal.keyChange || signal.title}（${age.toFixed(1)}天前，${signal.shortTermBias || "震盪"}）`,
      contribution
    });
  }

  for (const event of macroEvents) {
    if (event.status !== "recent" && event.status !== "upcoming") continue;
    const age = event.status === "upcoming"
      ? Math.max(0, dayjs(event.datetime).diff(dayjs(), "day", true))
      : ageDays(event.datetime);
    if (!Number.isFinite(age) || age > maxAge) continue;
    const contribution = direction(event.result?.shortTermBias) * impactMultiplier(event.importance) * (event.status === "upcoming" ? 1.15 : 1) * decay(age, halfLife * 1.3);
    points.push({
      text: `${event.title}（${event.status === "upcoming" ? `距今 ${age.toFixed(1)} 天` : `${age.toFixed(1)}天前`}，${event.result?.shortTermBias || "震盪"}）`,
      contribution
    });
  }

  return points
    .filter((point) => Math.abs(point.contribution) >= 0.1)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 3)
    .map((point) => point.text);
}

function normalizeManualTrend(value) {
  return ["偏漲", "偏跌", "震盪"].includes(value) ? value : null;
}

function envText(name) {
  const v = String(process.env[name] || "").trim();
  return v.length > 0 ? v : null;
}

function splitReasonLines(text = "") {
  return String(text)
    .split(/\r?\n|；|;|\|\|/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateTraderReason(text, label) {
  const legacy = ["主因", "傳導", "風險情境", "觀察指標", "失效條件"];
  const comprehensive = [
    "政治/政策",
    "央行/利率",
    "美/日政策",
    "機構資金流",
    "巨鯨/鏈上",
    "散戶/槓桿",
    "市場結構",
    "催化/節奏",
    "觀察指標",
    "失效條件"
  ];

  const raw = String(text || "").replace(/\r\n/g, "\n");
  const hasAnyComprehensiveKey = comprehensive.some((key) => new RegExp(`${escapeRegExp(key)}\\s*[:：]`).test(raw));
  const required = hasAnyComprehensiveKey ? comprehensive : legacy;

  const missing = required.filter((key) => !new RegExp(`${escapeRegExp(key)}\\s*[:：]`).test(raw));
  if (missing.length > 0) {
    throw new Error(
      `${label} 格式不完整，缺少：${missing.join("、")}。\n` +
      `請用固定模板（每個欄位一段）：\n` +
      (hasAnyComprehensiveKey
        ? `政治/政策：...\n央行/利率：...\n美/日政策：...\n機構資金流：...\n巨鯨/鏈上：...\n散戶/槓桿：...\n市場結構：...\n催化/節奏：...\n觀察指標：...\n失效條件：...`
        : `主因：...\n傳導：...\n風險情境：...\n觀察指標：...\n失效條件：...`
      )
    );
  }
}

function extractCondition({ conditionEnv, reasonText }) {
  const fromEnv = String(conditionEnv || "").trim();
  if (fromEnv) {
    return { condition: fromEnv, reason: reasonText };
  }

  const lines = splitReasonLines(reasonText);
  let condition = "";
  const kept = [];
  for (const line of lines) {
    const m = line.match(/^附帶條件\s*[:：]\s*(.+)$/);
    if (m && m[1]) {
      condition = condition || m[1].trim();
      continue;
    }
    kept.push(line);
  }
  return { condition, reason: kept.join("\n") };
}

const shortCfg = { maxAge: 7, halfLife: 3 };
const midCfg = { maxAge: 42, halfLife: 12 };
const longCfg = { maxAge: 120, halfLife: 35 };

const manualShortTrend = normalizeManualTrend(envText("TRADER_SHORT_TREND"));
const manualMidTrend = normalizeManualTrend(envText("TRADER_MID_TREND"));
const manualLongTrend = normalizeManualTrend(envText("TRADER_LONG_TREND"));

const manualShortReason = envText("TRADER_SHORT_REASON");
const manualMidReason = envText("TRADER_MID_REASON");
const manualLongReason = envText("TRADER_LONG_REASON");

const manualShortCondition = envText("TRADER_SHORT_CONDITION");
const manualMidCondition = envText("TRADER_MID_CONDITION");
const manualLongCondition = envText("TRADER_LONG_CONDITION");

const hasManual = Boolean(manualShortTrend && manualMidTrend && manualLongTrend && manualShortReason && manualMidReason && manualLongReason);

let shortCondition = "";
let midCondition = "";
let longCondition = "";

let shortReasonFinal = manualShortReason;
let midReasonFinal = manualMidReason;
let longReasonFinal = manualLongReason;

if (hasManual) {
  const shortExtracted = extractCondition({ conditionEnv: manualShortCondition, reasonText: manualShortReason });
  const midExtracted = extractCondition({ conditionEnv: manualMidCondition, reasonText: manualMidReason });
  const longExtracted = extractCondition({ conditionEnv: manualLongCondition, reasonText: manualLongReason });
  shortCondition = shortExtracted.condition;
  midCondition = midExtracted.condition;
  longCondition = longExtracted.condition;
  shortReasonFinal = shortExtracted.reason;
  midReasonFinal = midExtracted.reason;
  longReasonFinal = longExtracted.reason;

  validateTraderReason(shortReasonFinal, "TRADER_SHORT_REASON");
  validateTraderReason(midReasonFinal, "TRADER_MID_REASON");
  validateTraderReason(longReasonFinal, "TRADER_LONG_REASON");
}

let shortTrend;
let midTrend;
let longTrend;

if (hasManual) {
  shortTrend = manualShortTrend;
  midTrend = manualMidTrend;
  longTrend = manualLongTrend;
} else if (allowAuto) {
  const shortScore = scoreSignals(crypto, shortCfg) + scoreSignals(risks, shortCfg) + scoreMacro(macro, shortCfg);
  const midScore = scoreSignals(crypto, midCfg) + scoreSignals(risks, midCfg) + scoreMacro(macro, midCfg);
  const longScore = scoreSignals(crypto, longCfg) + scoreSignals(risks, longCfg) + scoreMacro(macro, longCfg);
  shortTrend = labelTrend(shortScore);
  midTrend = labelTrend(midScore);
  longTrend = labelTrend(longScore);
} else {
  throw new Error("Manual trader input required. Set TRADER_SHORT_TREND/TRADER_MID_TREND/TRADER_LONG_TREND and TRADER_SHORT_REASON/TRADER_MID_REASON/TRADER_LONG_REASON, or pass --auto.");
}

const nextHigh =
  macro
    .filter((e) => e.status === "upcoming" && e.importance === "high")
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))[0] || null;

const topSignals = [...crypto]
  .sort((a, b) => new Date(b.time) - new Date(a.time))
  .slice(0, 3);

const nowIso = new Date().toISOString();

data.marketOverview = data.marketOverview || {};
data.marketOverview.shortTermTrend = shortTrend;
data.marketOverview.midTermTrend = midTrend;
data.marketOverview.longTermTrend = longTrend;
data.marketOverview.shortTrendReason = hasManual
  ? shortReasonFinal
  : `自動估算（1-7天）：重點驅動 ${topDrivers({ cryptoSignals: crypto, riskSignals: risks, macroEvents: macro }, shortCfg.maxAge, shortCfg.halfLife).join("；") || "資料不足"}；超過 7 天訊號降權。`;
data.marketOverview.midTrendReason = hasManual
  ? midReasonFinal
  : `自動估算（2-6週）：重點驅動 ${topDrivers({ cryptoSignals: crypto, riskSignals: risks, macroEvents: macro }, midCfg.maxAge, midCfg.halfLife).join("；") || "資料不足"}；超過 42 天訊號降權。`;
data.marketOverview.longTrendReason = hasManual
  ? longReasonFinal
  : `自動估算（1-3個月）：重點驅動 ${topDrivers({ cryptoSignals: crypto, riskSignals: risks, macroEvents: macro }, longCfg.maxAge, longCfg.halfLife).join("；") || "資料不足"}；超過 120 天訊號僅作背景參考。`;

data.marketOverview.shortTermCondition = hasManual ? shortCondition : "";
data.marketOverview.midTermCondition = hasManual ? midCondition : "";
data.marketOverview.longTermCondition = hasManual ? longCondition : "";
data.marketOverview.trendModelMeta = {
  mode: hasManual ? "manual_trader" : "rule_based_auto",
  model: hasManual ? "GPT-5.2" : "rule-based-local",
  updatedAt: nowIso
};
data.marketOverview.overallSummary = `短線${shortTrend}；中線${midTrend}；長線${longTrend}；近期請優先關注 ${nextHigh?.title || "外部風險與資金流"}`;

data.aiSummary = {
  keyInsights: [
    `${hasManual ? "【交易員】" : "【規則】"}短線（1-7天）：${shortTrend}；中線（2-6週）：${midTrend}；長線（1-3個月）：${longTrend}。`,
    nextHigh
      ? `【關鍵時間】${dayjs(nextHigh.datetime).format("MM/DD HH:mm")} ${nextHigh.title}`
      : "【關鍵時間】未來7天暫無高影響事件。",
    ...topSignals.map((s) => `【市場重點】${s.keyChange}｜短線：${s.shortTermBias || "震盪"}`)
  ].slice(0, 8),
  eventImpacts: [],
  signalHighlights: topSignals.map((s) => ({
    signalId: s.id,
    whyImportant: `${s.keyChange}；短線 ${s.shortTermBias || "震盪"}。`
  })),
  aiMeta: {
    mode: hasManual ? "manual_trader" : "rule_based_auto",
    model: hasManual ? "GPT-5.2" : "rule-based-local",
    promptVersion: hasManual ? "trader-template-v1" : "rule-v1",
    updatedAt: nowIso
  }
};

data.generatedAt = nowIso;

const setRes = await fetch(`${base}/set/${encodeURIComponent(key)}`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${writeToken}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(data)
});
if (!setRes.ok) {
  const t = await setRes.text();
  throw new Error(`set failed ${setRes.status} ${t}`);
}

await fetch(`${base}/set/${encodeURIComponent("crypto_dashboard:last_updated")}`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${writeToken}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ at: nowIso, mode: hasManual ? "manual_trader" : "rule_based_auto" })
});

console.log("manual AI update done", nowIso, shortTrend, longTrend);
