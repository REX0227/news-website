/**
 * liq-heatmap-poller.js — Level 2 CoinGlass 清算熱力圖壓力指標
 *
 * 每 15 分鐘讀取 BTC/ETH 清算熱力圖，計算：
 *   liq_heatmap_pressure = (short_liq_above - long_liq_below) / total
 *   正值 → 上方空頭集中（軋空潛力，bullish）
 *   負值 → 下方多頭集中（清洗潛力，bearish）
 *
 * Factor keys：
 *   crypto.derivatives.BTC.liq_heatmap_pressure
 *   crypto.derivatives.ETH.liq_heatmap_pressure
 *
 * 執行：
 *   pm2 start backend/scripts/liq-heatmap-poller.js --name liq-heatmap
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const DB_PATH    = path.join(__dirname, "..", "gecko.db");
const CG_API_KEY = process.env.COINGLASS_API_KEY;
const CG_BASE    = "https://open-api-v4.coinglass.com";
const POLL_MS    = 15 * 60 * 1_000;

const SYMBOLS = [
  { sym: "BTC", cg: "BTC" },
  { sym: "ETH", cg: "ETH" },
];

if (!CG_API_KEY) {
  console.error("[liq-heatmap] COINGLASS_API_KEY not set"); process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 10000");

const insertFactor = db.prepare(`
  INSERT OR REPLACE INTO factor_snapshots
    (run_id, factor_key, factor_category, raw_value, normalized_score,
     direction, confidence, source_tier, extra_json, computed_at)
  VALUES (?, ?, 'derivatives', ?, ?, ?, 0.78, 2, ?, ?)
`);

function clamp(v, min = -1, max = 1) { return Math.max(min, Math.min(max, v)); }

async function cgFetch(endpoint, params = {}) {
  const url = new URL(`${CG_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    headers: { "accept": "application/json", "CG-API-KEY": CG_API_KEY },
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (String(json.code) !== "0") throw new Error(`CG code=${json.code} msg=${json.msg}`);
  return json.data;
}

async function fetchHeatmap(cgSym) {
  // CoinGlass liquidation map: returns price levels with long/short liquidation amounts
  const data = await cgFetch("/api/futures/liquidation-map/data", {
    symbol: cgSym,
    exchange: "Binance"
  });

  if (!data || !Array.isArray(data)) return null;

  // data structure: [{ price, longLiqUsd, shortLiqUsd }, ...]
  // or similar — find current price as midpoint
  const prices  = data.map(d => parseFloat(d.price ?? d.p ?? 0)).filter(p => p > 0);
  if (prices.length === 0) return null;

  const currentPrice = prices[Math.floor(prices.length / 2)]; // approximate midpoint
  if (!currentPrice) return null;

  let aboveShortLiq = 0, belowLongLiq = 0, total = 0;

  for (const row of data) {
    const price    = parseFloat(row.price ?? row.p ?? 0);
    const longLiq  = parseFloat(row.longLiqUsd  ?? row.long_liq  ?? row.l ?? 0);
    const shortLiq = parseFloat(row.shortLiqUsd ?? row.short_liq ?? row.s ?? 0);
    if (!price) continue;

    total += longLiq + shortLiq;

    if (price > currentPrice) {
      aboveShortLiq += shortLiq;  // shorts above = squeeze if price rises
    } else {
      belowLongLiq += longLiq;    // longs below = flush if price falls
    }
  }

  if (total === 0) return null;

  // asymmetry: positive = more short squeeze potential above (bullish)
  const asymmetry = (aboveShortLiq - belowLongLiq) / total;
  return { asymmetry, total, aboveShortLiq, belowLongLiq };
}

async function runPoll() {
  const now = new Date();
  const computedAt = now.toISOString().replace("T", " ").slice(0, 19);
  const runId = `liq_heatmap_${now.toISOString().slice(0, 16).replace(/[T:]/g, "_")}`;
  let written = 0;

  for (const { sym, cg } of SYMBOLS) {
    try {
      const result = await fetchHeatmap(cg);
      if (!result) continue;

      const { asymmetry, aboveShortLiq, belowLongLiq, total } = result;
      const score = clamp(asymmetry / 0.3);  // ±30% asymmetry = ±1.0
      const dir   = score > 0.2 ? "bullish" : score < -0.2 ? "bearish" : "neutral";

      insertFactor.run(
        runId,
        `crypto.derivatives.${sym}.liq_heatmap_pressure`,
        Number(asymmetry.toFixed(4)), score, dir,
        JSON.stringify({
          above_short_liq_usd: Math.round(aboveShortLiq),
          below_long_liq_usd:  Math.round(belowLongLiq),
          total_liq_usd:       Math.round(total)
        }),
        computedAt
      );
      written++;
    } catch (err) {
      console.error(`[liq-heatmap] ${sym} error: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 1_000));
  }

  if (written > 0) {
    console.log(`[liq-heatmap] ${computedAt} — wrote ${written} heatmap factors`);
  }
}

console.log("[liq-heatmap] Starting Liquidation Heatmap Poller");
runPoll().catch(console.error);
setInterval(() => runPoll().catch(console.error), POLL_MS);

process.on("SIGINT",  () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
