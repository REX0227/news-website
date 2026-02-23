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

const baseUrl = process.env.UPSTASH_REDIS_REST_URL;
const readToken = process.env.UPSTASH_REDIS_REST_TOKEN_READ;
const key = process.env.UPSTASH_KEY || "crypto_dashboard:latest";

if (!baseUrl || !readToken) {
  throw new Error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN_READ");
}

const url = `${baseUrl}/get/${encodeURIComponent(key)}`;
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${readToken}` }
});

if (!res.ok) {
  throw new Error(`Upstash get failed: ${res.status}`);
}

const payload = await res.json();
const raw = payload?.result;
const data = typeof raw === "string" ? JSON.parse(raw) : raw;

const nowTs = Date.now();
const macroEvents = Array.isArray(data?.macroEvents) ? data.macroEvents : [];
const cryptoSignals = Array.isArray(data?.cryptoSignals) ? data.cryptoSignals : [];
const globalRiskSignals = Array.isArray(data?.globalRiskSignals) ? data.globalRiskSignals : [];

const highMacro = macroEvents
  .filter((event) => event && event.importance === "high")
  .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

const upcomingHigh = highMacro
  .filter((event) => new Date(event.datetime).getTime() >= nowTs)
  .slice(0, 8)
  .map((event) => ({
    t: dayjs(event.datetime).format("MM/DD HH:mm"),
    country: event.country,
    type: event.eventType,
    title: event.title,
    bias: event?.result?.shortTermBias || "",
    impact: (event?.result?.cryptoImpact || event.impactHint || "").slice(0, 140)
  }));

const recentHigh = highMacro
  .filter((event) => new Date(event.datetime).getTime() < nowTs)
  .slice(-8)
  .reverse()
  .map((event) => ({
    t: dayjs(event.datetime).format("MM/DD HH:mm"),
    type: event.eventType,
    title: event.title,
    actual: String(event?.result?.actual || "").slice(0, 60),
    bias: event?.result?.shortTermBias || "",
    impact: (event?.result?.cryptoImpact || event.impactHint || "").slice(0, 140)
  }));

const topCrypto = cryptoSignals
  .slice(0, 12)
  .map((signal) => ({
    t: dayjs(signal.time).format("MM/DD HH:mm"),
    impact: signal.impact,
    category: signal.category,
    bias: signal.shortTermBias,
    change: String(signal.keyChange || signal.zhTitle || signal.title || "").slice(0, 160)
  }));

const topRisk = globalRiskSignals
  .slice(0, 10)
  .map((signal) => ({
    t: dayjs(signal.time).format("MM/DD HH:mm"),
    bias: signal.shortTermBias,
    change: String(signal.keyChange || signal.title || "").slice(0, 160)
  }));

const overview = data?.marketOverview || {};
const marketIntel = data?.marketIntel || {};
const policySignals = Array.isArray(data?.policySignals) ? data.policySignals : [];
const ratesIntel = data?.ratesIntel || {};
const liquidityIntel = data?.liquidityIntel || {};

function headLines(text, max = 6) {
  return String(text || "")
    .split(/\r?\n/g)
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0)
    .slice(0, max);
}

console.log("\n=== MARKET_OVERVIEW (current) ===");
console.log(JSON.stringify({
  shortTermTrend: overview.shortTermTrend,
  shortTermCondition: overview.shortTermCondition || "",
  midTermTrend: overview.midTermTrend,
  midTermCondition: overview.midTermCondition || "",
  longTermTrend: overview.longTermTrend,
  longTermCondition: overview.longTermCondition || "",
  externalRiskBias: overview.externalRiskBias,
  trendModelMeta: overview.trendModelMeta,
  shortTrendReason_head: headLines(overview.shortTrendReason),
  midTrendReason_head: headLines(overview.midTrendReason),
  longTrendReason_head: headLines(overview.longTrendReason)
}, null, 2));

console.log("\n=== UPCOMING_HIGH_MACRO ===");
console.log(JSON.stringify(upcomingHigh, null, 2));

console.log("\n=== RECENT_HIGH_MACRO ===");
console.log(JSON.stringify(recentHigh, null, 2));

console.log("\n=== TOP_CRYPTO_SIGNALS ===");
console.log(JSON.stringify(topCrypto, null, 2));

console.log("\n=== TOP_EXTERNAL_RISK ===");
console.log(JSON.stringify(topRisk, null, 2));

console.log("\n=== MARKET_INTEL (summary) ===");
console.log(JSON.stringify({
  updatedAt: marketIntel?.updatedAt || null,
  sources: marketIntel?.sources || {},
  global: marketIntel?.global || null,
  sentiment: marketIntel?.sentiment || null
}, null, 2));

console.log("\n=== POLICY_SIGNALS (summary) ===");
console.log(JSON.stringify({
  count: policySignals.length,
  latest: policySignals
    .slice()
    .sort((a, b) => new Date(b.time) - new Date(a.time))[0] || null
}, null, 2));

console.log("\n=== RATES_INTEL (summary) ===");
console.log(JSON.stringify(ratesIntel, null, 2));

console.log("\n=== LIQUIDITY_INTEL (summary) ===");
console.log(JSON.stringify(liquidityIntel, null, 2));
