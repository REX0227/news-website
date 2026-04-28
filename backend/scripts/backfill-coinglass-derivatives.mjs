/**
 * backfill-coinglass-derivatives.mjs — CoinGlass VIP per-symbol 衍生品歷史回灌
 *
 * 回灌以下因子：
 *   crypto.derivatives.{sym}.funding_rate_zscore  — 資金費率 z-score
 *   crypto.derivatives.{sym}.open_interest        — 未平倉合約
 *   crypto.derivatives.{sym}.long_short_ratio     — 多空比
 *   crypto.derivatives.{sym}.taker_cvd            — Taker 買賣量淨值
 *   crypto.derivatives.{sym}.liquidation_24h      — 24h 清算
 *   crypto.derivatives.{sym}.liquidation_7d       — 7d 清算
 *   flows.etf_net_flow_7d                         — BTC ETF 7D 淨流量
 *
 * 來源：CoinGlass Standard VIP（需 COINGLASS_API_KEY）
 * 幣種：BTC / ETH / SOL / XRP / ADA / BNB / DOGE
 * 回灌範圍：預設 2025-03-01 至今（VIP 歷史深度允許）
 *
 * 執行方式：
 *   node backend/scripts/backfill-coinglass-derivatives.mjs
 *   node backend/scripts/backfill-coinglass-derivatives.mjs --from=2025-03-01 --dry-run
 *   node backend/scripts/backfill-coinglass-derivatives.mjs --symbol=BTC --type=oi
 *   node backend/scripts/backfill-coinglass-derivatives.mjs --type=etf
 *
 * --type 選項：all（預設）/ oi / lsr / cvd / liq / etf
 *
 * 注意：
 *   - Rate limit：每次 API 請求後等 1.2s，批次間等 0.5s
 *   - VIP 允許的最大歷史深度視合約而定（超出則降解析度）
 *   - INSERT OR REPLACE 安全重跑
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const DB_PATH    = path.join(__dirname, "..", "gecko.db");
const CG_API_KEY = process.env.COINGLASS_API_KEY;
const CG_BASE    = "https://open-api-v4.coinglass.com";

if (!CG_API_KEY) {
  console.error("[cg-deriv-backfill] ERROR: COINGLASS_API_KEY not set in .env");
  process.exit(1);
}

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes("--dry-run");
const FROM_ARG = args.find(a => a.startsWith("--from="))?.split("=")[1] ?? "2025-03-01";
const TO_ARG   = args.find(a => a.startsWith("--to="))?.split("=")[1] ?? null;
const SYM_FILTER = args.find(a => a.startsWith("--symbol="))?.split("=")[1]?.toUpperCase() ?? null;
const TYPE_FILTER = args.find(a => a.startsWith("--type="))?.split("=")[1] ?? "all";

const SYMBOLS = ["BTC", "ETH", "SOL", "XRP", "ADA", "BNB", "DOGE"];
const sleep   = ms => new Promise(r => setTimeout(r, ms));

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 10000");

db.exec(`
  CREATE TABLE IF NOT EXISTS pipeline_runs (
    run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT NOT NULL,
    factor_count INTEGER, gate_count INTEGER, collectors_ok TEXT, collectors_failed TEXT
  );
`);

const insertRun = db.prepare(`
  INSERT OR IGNORE INTO pipeline_runs
    (run_id, started_at, completed_at, factor_count, gate_count, collectors_ok, collectors_failed)
  VALUES (?, ?, ?, ?, 0, 'coinglass_deriv_backfill', '')
`);

const insertFactor = db.prepare(`
  INSERT OR REPLACE INTO factor_snapshots
    (run_id, factor_key, factor_category, normalized_score, raw_value,
     direction, confidence, source_tier, extra_json, computed_at)
  VALUES (?, ?, 'derivatives', ?, ?, ?, 0.90, 2, ?, ?)
`);

// ── Normalization ──────────────────────────────────────────────────────���─────
function clamp(v, min = -1, max = 1) { return Math.max(min, Math.min(max, v)); }

// funding_rate 8h decimal → z-score 需要均值/標準差；先用閾值法近似
function normalizeFrZscore(zScore)    { return clamp(-(zScore) / 3.0); }  // z=+3 = -1.0 (過熱=偏空)
function normalizeLsr(longPct)        { return clamp(-(longPct - 0.5) / 0.1); } // 反指標
function normalizeCvdPct(netPct)      { return clamp(netPct / 15); }
function normalizeLiqUsd(totalUsd)    { return clamp(-totalUsd / 1e9); }
function normalizeOiChangePct(chgPct) { return clamp(chgPct / 3.0); }
function normalizeEtfFlow(flowUsd)    { return clamp(flowUsd / 500e6); }

// ── CoinGlass API helper ─────────────────────────────────────────────────────
async function cgFetch(endpoint, params = {}) {
  const url = new URL(`${CG_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    headers: { "accept": "application/json", "CG-API-KEY": CG_API_KEY },
    signal: AbortSignal.timeout(20_000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.code !== "0" && json.code !== 0) {
    throw new Error(`API error code=${json.code} msg=${json.msg}`);
  }
  return json.data;
}

// ── Per-symbol symbol mapping for CoinGlass ──────────────────────────────────
const CG_SYMBOL_MAP = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT",
  XRP: "XRPUSDT", ADA: "ADAUSDT", BNB: "BNBUSDT", DOGE: "DOGEUSDT"
};

// ── OI history ────────────────────────────────────────────────────────────────
async function backfillOI(sym, fromMs, toMs) {
  const cgSym = CG_SYMBOL_MAP[sym];
  if (!cgSym) return 0;
  const symL = sym.toLowerCase();
  let written = 0, cursor = fromMs;

  while (cursor < toMs) {
    const batchEnd = Math.min(cursor + 90 * 86400_000, toMs);
    try {
      const data = await cgFetch("/api/futures/open-interest/aggregated-history", {
        symbol: sym, exchange_list: "Binance,Bybit",
        interval: "1d", startTime: cursor, endTime: batchEnd, limit: 200
      });
      const rows = Array.isArray(data) ? data : (data?.list ?? []);
      const fromStr = new Date(cursor).toISOString().slice(0, 10);
      const toStr   = new Date(batchEnd).toISOString().slice(0, 10);
      console.log(`  [OI][${sym}] ${fromStr}→${toStr}: ${rows.length} rows`);

      if (!DRY_RUN) {
        for (const row of rows) {
          const ts    = row.time ?? row.t ?? row.createTime;
          const oi    = parseFloat(row.close ?? row.closeUsd ?? row.openInterest ?? row.value ?? row.c ?? NaN);
          const prev  = parseFloat(row.open ?? row.openUsd ?? row.o ?? NaN);
          if (!ts || !Number.isFinite(oi)) continue;

          const dateIso  = new Date(Number(ts)).toISOString().replace("T", " ").slice(0, 19);
          const dateStr  = dateIso.slice(0, 10);
          const runId    = `backfill_cg_oi_${sym}_${dateStr}`;
          const chg4hPct = Number.isFinite(prev) && prev > 0 ? (oi - prev) / prev * 100 : null;
          const score    = chg4hPct !== null ? normalizeOiChangePct(chg4hPct) : null;
          const dir      = chg4hPct !== null ? (chg4hPct > 2 ? "bullish" : chg4hPct < -2 ? "bearish" : "neutral") : "neutral";
          const extra    = JSON.stringify({ change_4h_pct: chg4hPct, exchange: "Binance" });

          insertRun.run(runId, dateIso, dateIso, 1);
          insertFactor.run(runId, `crypto.derivatives.${symL}.open_interest`, score, String(Math.round(oi)), dir, extra, dateIso);
          written++;
        }
      }
    } catch (err) {
      console.error(`  [OI][${sym}] ERROR: ${err.message}`);
    }
    cursor = batchEnd;
    await sleep(1_200);
  }
  return written;
}

// ── LSR history ───────────────────────────────────────────────────────────────
async function backfillLSR(sym, fromMs, toMs) {
  const cgSym = CG_SYMBOL_MAP[sym];
  if (!cgSym) return 0;
  const symL = sym.toLowerCase();
  let written = 0, cursor = fromMs;

  while (cursor < toMs) {
    const batchEnd = Math.min(cursor + 90 * 86400_000, toMs);
    try {
      const data = await cgFetch("/api/futures/global-long-short-account-ratio/history", {
        symbol: cgSym, exchange: "Binance",
        interval: "1d", startTime: cursor, endTime: batchEnd, limit: 200
      });
      const rows = Array.isArray(data) ? data : (data?.list ?? []);
      console.log(`  [LSR][${sym}] ${new Date(cursor).toISOString().slice(0,10)}: ${rows.length} rows`);

      if (!DRY_RUN) {
        for (const row of rows) {
          const ts       = row.time ?? row.t ?? row.createTime;
          const longPct  = parseFloat(row.global_account_long_percent ?? row.longAccount ?? row.longRatio ?? row.long ?? NaN);
          if (!ts || !Number.isFinite(longPct)) continue;

          const lp       = longPct > 1 ? longPct / 100 : longPct; // normalise 0-1
          const dateIso  = new Date(Number(ts)).toISOString().replace("T", " ").slice(0, 19);
          const dateStr  = dateIso.slice(0, 10);
          const runId    = `backfill_cg_lsr_${sym}_${dateStr}`;
          const score    = normalizeLsr(lp);
          const dir      = lp > 0.6 ? "bearish" : lp < 0.4 ? "bullish" : "neutral";
          const extra    = JSON.stringify({ long_pct: Number((lp * 100).toFixed(2)), exchange: "Binance" });

          insertRun.run(runId, dateIso, dateIso, 1);
          insertFactor.run(runId, `crypto.derivatives.${symL}.long_short_ratio`, score, String(lp.toFixed(4)), dir, extra, dateIso);
          written++;
        }
      }
    } catch (err) {
      console.error(`  [LSR][${sym}] ERROR: ${err.message}`);
    }
    cursor = batchEnd;
    await sleep(1_200);
  }
  return written;
}

// ── Liquidation history ───────────────────────────────────────────────────────
async function backfillLiquidation(sym, fromMs, toMs) {
  const cgSym = CG_SYMBOL_MAP[sym];
  if (!cgSym) return 0;
  const symL = sym.toLowerCase();
  let written = 0, cursor = fromMs;

  while (cursor < toMs) {
    const batchEnd = Math.min(cursor + 30 * 86400_000, toMs);
    try {
      const data = await cgFetch("/api/futures/liquidation/history", {
        symbol: cgSym, exchange: "Binance",
        interval: "1d", startTime: cursor, endTime: batchEnd, limit: 200
      });
      const rows = Array.isArray(data) ? data : (data?.list ?? []);
      console.log(`  [LIQ][${sym}] ${new Date(cursor).toISOString().slice(0,10)}: ${rows.length} rows`);

      if (!DRY_RUN) {
        // Keep a 7-day window to compute liquidation_7d
        const dayBuckets = {};
        for (const row of rows) {
          const ts  = row.time ?? row.t ?? row.createTime;
          const longLiqRaw  = row.longLiquidationUsd  ?? row.long_liquidation_usd  ?? row.buyLiqUsd  ?? row.longUsd  ?? null;
          const shortLiqRaw = row.shortLiquidationUsd ?? row.short_liquidation_usd ?? row.sellLiqUsd ?? row.shortUsd ?? null;
          if (!ts || (longLiqRaw === null && shortLiqRaw === null)) continue;
          const liq = parseFloat(longLiqRaw ?? 0) + parseFloat(shortLiqRaw ?? 0);
          if (!Number.isFinite(liq)) continue;
          const dateStr = new Date(Number(ts)).toISOString().slice(0, 10);
          dayBuckets[dateStr] = (dayBuckets[dateStr] ?? 0) + liq;
        }
        const sortedDays = Object.keys(dayBuckets).sort();

        for (let i = 0; i < sortedDays.length; i++) {
          const date     = sortedDays[i];
          const dateIso  = `${date} 00:00:00`;
          const liq24h   = dayBuckets[date];

          // 7d = sum of last 7 days
          const liq7d = sortedDays.slice(Math.max(0, i - 6), i + 1).reduce((s, d) => s + (dayBuckets[d] ?? 0), 0);

          const runId24 = `backfill_cg_liq24_${sym}_${date}`;
          const runId7d = `backfill_cg_liq7d_${sym}_${date}`;

          insertRun.run(runId24, dateIso, dateIso, 1);
          insertFactor.run(runId24, `crypto.derivatives.${symL}.liquidation_24h`,
            normalizeLiqUsd(liq24h), String(Math.round(liq24h)),
            liq24h > 100e6 ? "bearish" : "neutral", null, dateIso);

          insertRun.run(runId7d, dateIso, dateIso, 1);
          insertFactor.run(runId7d, `crypto.derivatives.${symL}.liquidation_7d`,
            normalizeLiqUsd(liq7d), String(Math.round(liq7d)),
            liq7d > 500e6 ? "bearish" : "neutral", null, dateIso);
          written += 2;
        }
      }
    } catch (err) {
      console.error(`  [LIQ][${sym}] ERROR: ${err.message}`);
    }
    cursor = batchEnd;
    await sleep(1_200);
  }
  return written;
}

// ── ETF flow history ──────────────────────────────────────────────────────────
async function backfillEtfFlow(fromMs, toMs) {
  let written = 0, cursor = fromMs;
  console.log("\n[cg-deriv-backfill] === ETF flow ===");

  while (cursor < toMs) {
    const batchEnd = Math.min(cursor + 90 * 86400_000, toMs);
    try {
      const data = await cgFetch("/api/etf/bitcoin-etf/net-flow/chart", {
        startTime: cursor, endTime: batchEnd
      });
      const rows = Array.isArray(data) ? data : (data?.list ?? data?.data ?? []);
      console.log(`  [ETF] ${new Date(cursor).toISOString().slice(0,10)}: ${rows.length} rows`);

      if (!DRY_RUN) {
        // Need to aggregate into 7-day windows
        const dayBuckets = {};
        for (const row of rows) {
          const ts  = row.time ?? row.t ?? row.date;
          const net = parseFloat(row.netFlow ?? row.net_flow ?? row.net ?? row.n ?? NaN);
          if (!ts || !Number.isFinite(net)) continue;
          const dateStr = new Date(Number(ts)).toISOString().slice(0, 10);
          dayBuckets[dateStr] = (dayBuckets[dateStr] ?? 0) + net;
        }

        const sortedDays = Object.keys(dayBuckets).sort();
        for (let i = 0; i < sortedDays.length; i++) {
          const date    = sortedDays[i];
          const dateIso = `${date} 00:00:00`;
          const flow7d  = sortedDays.slice(Math.max(0, i - 6), i + 1).reduce((s, d) => s + (dayBuckets[d] ?? 0), 0);
          const runId   = `backfill_cg_etf_${date}`;
          const score   = normalizeEtfFlow(flow7d);
          const dir     = flow7d > 200e6 ? "bullish" : flow7d < -200e6 ? "bearish" : "neutral";

          insertRun.run(runId, dateIso, dateIso, 1);
          insertFactor.run(runId, "flows.etf_net_flow_7d", score, String(Math.round(flow7d)), dir,
            JSON.stringify({ source: "coinglass_vip" }), dateIso);
          written++;
        }
      }
    } catch (err) {
      console.error(`  [ETF] ERROR: ${err.message}`);
    }
    cursor = batchEnd;
    await sleep(1_200);
  }
  return written;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const fromMs  = new Date(FROM_ARG).getTime();
  const toMs    = TO_ARG ? new Date(TO_ARG).getTime() : Date.now();
  const symbols = SYM_FILTER ? [SYM_FILTER] : SYMBOLS;
  const types   = TYPE_FILTER === "all" ? ["oi", "lsr", "liq", "etf"] : [TYPE_FILTER];

  console.log(`[cg-deriv-backfill] DRY_RUN=${DRY_RUN}, CG_API_KEY=OK`);
  console.log(`[cg-deriv-backfill] Symbols: ${symbols.join(", ")}`);
  console.log(`[cg-deriv-backfill] Types: ${types.join(", ")}`);
  console.log(`[cg-deriv-backfill] Range: ${FROM_ARG} → ${TO_ARG ?? "now"}`);

  let total = 0;

  for (const sym of symbols) {
    console.log(`\n[cg-deriv-backfill] ===== ${sym} =====`);
    if (types.includes("oi"))  { total += await backfillOI(sym, fromMs, toMs);          await sleep(500); }
    if (types.includes("lsr")) { total += await backfillLSR(sym, fromMs, toMs);         await sleep(500); }
    if (types.includes("liq")) { total += await backfillLiquidation(sym, fromMs, toMs); await sleep(500); }
  }

  if (types.includes("etf")) {
    total += await backfillEtfFlow(fromMs, toMs);
  }

  console.log(`\n[cg-deriv-backfill] Done! Total written: ${total} rows${DRY_RUN ? " (DRY RUN)" : ""}`);
  console.log("[cg-deriv-backfill] 下一步：node backend/scripts/backfill-asset-comments.mjs");
  console.log("[cg-deriv-backfill] 然後：node backend/scripts/validation-runner.js --days=90");
}

main().catch(err => {
  console.error("[cg-deriv-backfill] Fatal:", err.message);
  process.exit(1);
});
