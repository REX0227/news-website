/**
 * coinglass-liq-backfill.js — CoinGlass 歷史清算資料回灌
 *
 * §1 修正：liquidation 接縫問題
 *   原問題：CoinGlass 回灌（Binance+Bybit+OKX+Gate）→ 自建 WS（僅 Binance）
 *           → 接縫處 total_usd 大幅跳降 → z-score 不連續 → 假訊號
 *
 *   修正後：
 *     段 1：2024-01-01 → 2025-03-01（daily，source: coinglass_daily）
 *     段 2：2025-03-01 → now（15m，source: coinglass_15m）
 *
 * 執行方式：
 *   node backend/scripts/coinglass-liq-backfill.js [--dry-run]
 *   node backend/scripts/coinglass-liq-backfill.js --from=2025-03-01 --to=2025-04-01 --resolution=15m
 *
 * 注意事項：
 *   - CoinGlass VIP Standard：15m 資料有時間深度限制，daily 無限制
 *   - Rate limit：建議每批次間隔 2s（避免 429）
 *   - 回灌完成後重算 z-score：在 liquidation-ws.js 的 runAggregation 中處理
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const DB_PATH = path.join(__dirname, "..", "gecko.db");
const CG_API_KEY = process.env.COINGLASS_API_KEY;
const CG_BASE    = "https://open-api-v4.coinglass.com";

if (!CG_API_KEY) {
  console.error("[backfill] ERROR: COINGLASS_API_KEY not set in .env");
  process.exit(1);
}

// CLI args
const args = process.argv.slice(2);
const DRY_RUN   = args.includes("--dry-run");
const FROM_ARG  = args.find(a => a.startsWith("--from="))?.split("=")[1];
const TO_ARG    = args.find(a => a.startsWith("--to="))?.split("=")[1];
const RES_ARG   = args.find(a => a.startsWith("--resolution="))?.split("=")[1];

const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "TRX", "FIL", "LINK"];

// ── Database ──────────────────────────────────────────────────────────────────

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 10000");  // 10s 等待，避免多程序鎖衝突

// Ensure liquidation_agg schema is up to date
db.exec(`
  CREATE TABLE IF NOT EXISTS liquidation_agg (
    symbol            TEXT NOT NULL,
    bucket_start      TEXT NOT NULL,
    bucket_size       TEXT NOT NULL DEFAULT '5m',
    total_usd         REAL NOT NULL DEFAULT 0,
    long_liq_usd      REAL NOT NULL DEFAULT 0,
    short_liq_usd     REAL NOT NULL DEFAULT 0,
    exchange_set      TEXT NOT NULL DEFAULT '',
    source            TEXT NOT NULL DEFAULT 'self_hosted',
    source_resolution TEXT NOT NULL DEFAULT '5m',
    computed_at       TEXT NOT NULL,
    PRIMARY KEY (symbol, bucket_start, bucket_size)
  );
  CREATE INDEX IF NOT EXISTS idx_liq_agg_symbol_time ON liquidation_agg(symbol, bucket_start DESC);

  CREATE TABLE IF NOT EXISTS data_revision_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name   TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    bucket_start TEXT NOT NULL,
    field_name   TEXT NOT NULL,
    old_value    REAL,
    new_value    REAL,
    pct_change   REAL,
    action       TEXT NOT NULL,
    detected_at  TEXT NOT NULL,
    source       TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_rev_log_detected ON data_revision_log(detected_at DESC);
  CREATE INDEX IF NOT EXISTS idx_rev_log_sym_time ON data_revision_log(symbol, bucket_start);
`);

// INSERT OR IGNORE：保留首次入庫的原始數據，不允許 Coinglass 事後竄改歷史基線
const insertAgg = db.prepare(`
  INSERT OR IGNORE INTO liquidation_agg
    (symbol, bucket_start, bucket_size, total_usd, long_liq_usd, short_liq_usd,
     exchange_set, source, source_resolution, computed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ── CoinGlass API ─────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cgFetch(endpoint, params = {}) {
  const url = new URL(`${CG_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url.toString(), {
    headers: { "accept": "application/json", "CG-API-KEY": CG_API_KEY },
    signal: AbortSignal.timeout(20_000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CoinGlass HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.code !== "0" && json.code !== 0) {
    throw new Error(`CoinGlass API error code=${json.code} msg=${json.msg}`);
  }
  return json.data;
}

/**
 * 拉取 CoinGlass 清算歷史（aggregated-history 端點）
 *
 * @param {string} symbol    — 'BTC'
 * @param {string} interval  — '1d' | '1h' | '15m'
 * @param {number} startTime — Unix ms
 * @param {number} endTime   — Unix ms
 */
async function fetchLiqHistory(symbol, interval, startTime, endTime, exchangeList = "Binance,Bybit,OKX,Gate") {
  // CoinGlass V4: /api/futures/liquidation/aggregated-history
  // 回傳：[{ t: ms, longLiquidationUsd, shortLiquidationUsd, ... }]
  const data = await cgFetch("/api/futures/liquidation/aggregated-history", {
    symbol,
    interval,
    startTime,
    endTime,
    exchange_list: exchangeList
  });
  return Array.isArray(data) ? data : (data?.list ?? []);
}

// ── 回灌邏輯 ─────────────────────────────────────────────────────────────────

/**
 * 將一段時間範圍分批拉取並寫入 liquidation_agg
 *
 * @param {string} symbol
 * @param {string} resolution   — '1d' | '1h' | '15m'
 * @param {string} source       — 'coinglass_daily' | 'coinglass_15m'
 * @param {Date}   fromDate
 * @param {Date}   toDate
 */
async function backfillSegment(symbol, resolution, source, fromDate, toDate) {
  // CoinGlass API 每次最多回傳 ~500 筆，分批處理
  // 每批時間跨度（依 resolution 決定）
  const batchMs = {
    "1d":  90 * 24 * 3_600_000,  // 90 天
    "1h":  14 * 24 * 3_600_000,  // 14 天
    "15m":  7 * 24 * 3_600_000,  //  7 天
  }[resolution] ?? 7 * 24 * 3_600_000;

  const bucketSize = resolution === "1d" ? "1d"
    : resolution === "1h" ? "1h"
    : "15m";

  // exchange_set：CoinGlass 覆蓋 Binance+Bybit+OKX+Gate（Standard VIP）
  const exchangeSet = "binance,bybit,okx,gate";

  let cursor = fromDate.getTime();
  const endMs = toDate.getTime();
  let inserted = 0;
  let skipped  = 0;  // 已存在（受時間鎖保護），不覆寫

  while (cursor < endMs) {
    const batchEnd = Math.min(cursor + batchMs, endMs);
    const computedAt = new Date().toISOString();

    try {
      const rows = await fetchLiqHistory(symbol, resolution, cursor, batchEnd, exchangeSet);

      if (!DRY_RUN) {
        for (const row of rows) {
          const ts  = row.t ?? row.time ?? row.openTime ?? row.createTime;
          const lng = parseFloat(row.longLiquidationUsd  ?? row.aggregated_long_liquidation_usd  ?? row.lls ?? row.buyLiquidationUsd  ?? 0);
          const sht = parseFloat(row.shortLiquidationUsd ?? row.aggregated_short_liquidation_usd ?? row.sls ?? row.sellLiquidationUsd ?? 0);
          const tot = lng + sht;

          if (!ts) continue;  // tot=0 是合法資料（無清算時段），保留入庫

          const bucketStart = new Date(ts).toISOString();
          const info = insertAgg.run(
            symbol, bucketStart, bucketSize,
            tot, lng, sht,
            exchangeSet, source, resolution, computedAt
          );
          if (info.changes > 0) inserted++;
          else skipped++;
        }
      }

      const label = DRY_RUN ? " [DRY]" : ` inserted:${inserted} skipped(locked):${skipped}`;
      console.log(`  [${symbol}][${resolution}] ${new Date(cursor).toISOString().slice(0,10)} → ${new Date(batchEnd).toISOString().slice(0,10)}: ${rows.length} rows${label}`);
    } catch (err) {
      console.error(`  [${symbol}][${resolution}] ERROR at ${new Date(cursor).toISOString()}: ${err.message}`);
    }

    cursor = batchEnd;
    await sleep(1_200); // rate limit buffer
  }

  if (skipped > 0) {
    console.log(`  [${symbol}][${resolution}] ⚠ ${skipped} 筆已存在（時間鎖保護），保留原始數據未覆寫`);
  }
  return inserted;
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[backfill] Starting CoinGlass liquidation backfill`);
  console.log(`[backfill] DRY_RUN=${DRY_RUN}, CG_API_KEY=${CG_API_KEY ? "OK" : "MISSING"}`);
  console.log(`[backfill] Symbols: ${SYMBOLS.join(", ")}`);

  // 根據 CLI 參數或預設時間段設定
  const customFrom = FROM_ARG ? new Date(FROM_ARG) : null;
  const customTo   = TO_ARG   ? new Date(TO_ARG)   : null;
  const resolution = RES_ARG  || null;

  const segments = [];

  if (customFrom && customTo && resolution) {
    // 單一指定段
    const source = resolution === "1d" ? "coinglass_daily" : `coinglass_${resolution.replace("m","min")}`;
    segments.push({ symbol: "ALL", resolution, source, from: customFrom, to: customTo });
  } else {
    // 預設雙段：段 1 = daily 遠期；段 2 = 15m 近期
    const seg1From = new Date("2024-01-01");
    const seg1To   = new Date("2025-03-01");
    const seg2From = new Date("2025-03-01");
    const seg2To   = customTo || new Date();

    segments.push({ symbol: "ALL", resolution: "1d",  source: "coinglass_daily", from: seg1From, to: seg1To  });
    segments.push({ symbol: "ALL", resolution: "15m", source: "coinglass_15m",   from: seg2From, to: seg2To  });
  }

  let totalWritten = 0;

  for (const seg of segments) {
    const syms = seg.symbol === "ALL" ? SYMBOLS : [seg.symbol];
    console.log(`\n[backfill] === Segment: ${seg.resolution} (${seg.source}) ===`);
    console.log(`[backfill]   Period: ${seg.from.toISOString().slice(0,10)} → ${seg.to.toISOString().slice(0,10)}`);

    for (const sym of syms) {
      console.log(`\n[backfill] Processing ${sym}...`);
      const written = await backfillSegment(sym, seg.resolution, seg.source, seg.from, seg.to);
      totalWritten += written;
      await sleep(500);
    }
  }

  console.log(`\n[backfill] Done! Written ${totalWritten} rows total${DRY_RUN ? " (DRY RUN)" : ""}`);

  if (!DRY_RUN && totalWritten > 0) {
    console.log(`\n[backfill] Note: z-score 將在 liquidation-ws.js 的下一次 runAggregation() 中自動重算`);
    console.log(`[backfill] 或重啟 liquidation-ws 服務立即生效`);
  }
}

main().catch(err => {
  console.error("[backfill] Fatal:", err.message);
  process.exit(1);
});
