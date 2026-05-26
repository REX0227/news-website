/**
 * coinglass-liq-poller.js — CoinGlass 即時清算資料 15 分鐘輪詢
 *
 * §1 修正：live 段從「自建 WS（僅 Binance）」升級為「CoinGlass（Binance+Bybit+OKX+Gate）」
 *
 * 架構：
 *   每 15 分鐘呼叫 CoinGlass API 拉最新 15m 清算桶
 *   → 寫入 liquidation_agg（source='coinglass_live'）
 *   → 接縫從 coinglass_15m → coinglass_live（全程 CoinGlass，覆蓋一致）
 *
 * 執行：
 *   node backend/scripts/coinglass-liq-poller.js
 *   或透過 PM2：pm2 start coinglass-liq-poller.js --name cg-liq-poller
 *
 * 注意：
 *   自建 WS 仍繼續跑，source='self_hosted'（作為 proprietary data 累積）
 *   API 預設回 coinglass_live（覆蓋完整）
 *   下游可用 ?source=self_hosted 指定自建資料
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
const POLL_MS    = 15 * 60 * 1_000;  // 15 分鐘

// 超過此時間的 bucket 永久凍結，禁止 Coinglass 事後覆寫
const LOCK_THRESHOLD_MS = 48 * 60 * 60 * 1_000;  // 48 小時

const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "TRX", "FIL", "LINK"];
const EXCHANGE_SET = "binance,bybit,okx,gate";

if (!CG_API_KEY) {
  console.error("[cg-poller] ERROR: COINGLASS_API_KEY not set in .env");
  process.exit(1);
}

// ── Database ──────────────────────────────────────────────────────────────────

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 10000");  // 10s 等待，避免 backfill 鎖衝突

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

  CREATE TABLE IF NOT EXISTS factor_snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL,
    factor_key      TEXT NOT NULL,
    factor_category TEXT NOT NULL,
    raw_value       REAL,
    normalized_score REAL,
    direction       TEXT,
    confidence      REAL,
    source_tier     INTEGER DEFAULT 1,
    extra_json      TEXT,
    computed_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_factor_key_time ON factor_snapshots(factor_key, computed_at);

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

// ── Layer 1+2: 時間鎖 upsert（清算資料）────────────────────────────────────────

const _selectExistingAgg = db.prepare(`
  SELECT total_usd, long_liq_usd, short_liq_usd
  FROM liquidation_agg
  WHERE symbol = ? AND bucket_start = ? AND bucket_size = '15m'
`);

const _insertAggNew = db.prepare(`
  INSERT OR IGNORE INTO liquidation_agg
    (symbol, bucket_start, bucket_size, total_usd, long_liq_usd, short_liq_usd,
     exchange_set, source, source_resolution, computed_at)
  VALUES (?, ?, '15m', ?, ?, ?, ?, 'coinglass_live', '15m', ?)
`);

const _updateAggRecent = db.prepare(`
  UPDATE liquidation_agg
  SET total_usd = ?, long_liq_usd = ?, short_liq_usd = ?, computed_at = ?
  WHERE symbol = ? AND bucket_start = ? AND bucket_size = '15m'
`);

const _insertRevision = db.prepare(`
  INSERT INTO data_revision_log
    (table_name, symbol, bucket_start, field_name, old_value, new_value, pct_change, action, detected_at, source)
  VALUES ('liquidation_agg', ?, ?, 'total_usd', ?, ?, ?, ?, ?, 'coinglass_live')
`);

/**
 * 時間鎖 upsert：
 *   - 新 bucket → INSERT
 *   - 48h 內有差異 → UPDATE 並寫 revision log（action=UPDATED）
 *   - 48h 外有差異 → 攔截並寫 revision log（action=BLOCKED_TIME_LOCKED），不覆寫
 *
 * @returns {'NEW'|'UPDATED'|'UNCHANGED'|'LOCKED'}
 */
function lockedUpsertLiq(symbol, bucketStart, tot, lng, sht, exchangeSet, computedAt) {
  const existing = _selectExistingAgg.get(symbol, bucketStart);
  const bucketAgeMs = Date.now() - new Date(bucketStart).getTime();

  if (!existing) {
    _insertAggNew.run(symbol, bucketStart, tot, lng, sht, exchangeSet, computedAt);
    return "NEW";
  }

  const oldTotal = existing.total_usd ?? 0;
  if (Math.abs(oldTotal - tot) <= 0.01) return "UNCHANGED";

  const pctChange = oldTotal !== 0 ? ((tot - oldTotal) / oldTotal * 100) : null;

  if (bucketAgeMs > LOCK_THRESHOLD_MS) {
    _insertRevision.run(symbol, bucketStart, oldTotal, tot, pctChange, "BLOCKED_TIME_LOCKED", computedAt);
    return "LOCKED";
  }

  _insertRevision.run(symbol, bucketStart, oldTotal, tot, pctChange, "UPDATED", computedAt);
  _updateAggRecent.run(tot, lng, sht, computedAt, symbol, bucketStart);
  return "UPDATED";
}

const insertFactor = db.prepare(`
  INSERT INTO factor_snapshots
    (run_id, factor_key, factor_category, raw_value, normalized_score, direction, confidence, source_tier, computed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ── z-score for coinglass_live data ──────────────────────────────────────────

function computeCgZscoreForSymbol(symbol, windowLabel) {
  const windowMsMap = { "1h": 3_600_000, "4h": 4 * 3_600_000, "24h": 24 * 3_600_000, "7d": 7 * 24 * 3_600_000 };
  const windowMs = windowMsMap[windowLabel];
  if (!windowMs) return { value: 0, score: 0, direction: "neutral", confidence: 0.4 };

  const nowMs   = Date.now();
  const cutoff  = new Date(nowMs - windowMs).toISOString();
  const hist30d = new Date(nowMs - 30 * 24 * 3_600_000).toISOString();

  // 用所有 CoinGlass 來源合計（含舊回灌 coinglass_backfill，確保足夠歷史樣本）
  const cur = db.prepare(`
    SELECT COALESCE(SUM(total_usd), 0) AS total
    FROM liquidation_agg
    WHERE symbol = ? AND bucket_start >= ?
      AND source IN ('coinglass_live', 'coinglass_15m', 'coinglass_daily', 'coinglass_backfill')
  `).get(symbol, cutoff);
  const currentVal = cur?.total ?? 0;

  // 歷史窗口樣本（以對應 bucket 聚合）
  const buckets = db.prepare(`
    SELECT
      CAST((JULIANDAY(bucket_start) * 86400000 - JULIANDAY(?) * 86400000) / ? AS INTEGER) AS bucket,
      SUM(total_usd) AS total
    FROM liquidation_agg
    WHERE symbol = ? AND bucket_start >= ? AND bucket_start < ?
      AND source IN ('coinglass_live', 'coinglass_15m', 'coinglass_daily', 'coinglass_backfill')
    GROUP BY bucket
  `).all(hist30d, windowMs, symbol, hist30d, cutoff);

  let score = 0, direction = "neutral", confidence = 0.4;
  if (buckets.length >= 5) {
    const vals = buckets.map(b => b.total);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const std  = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) + 1e-9;
    const z    = (currentVal - mean) / std;
    score     = -Math.tanh(z * 0.4);
    direction = score >= 0.15 ? "bullish" : score <= -0.15 ? "bearish" : "neutral";
    confidence = buckets.length >= 20 ? 0.90 : 0.70;  // CoinGlass 覆蓋更完整，confidence 較高
  }
  return { value: currentVal, score: Number(score.toFixed(4)), direction, confidence };
}

// ── CoinGlass API ─────────────────────────────────────────────────────────────

async function cgFetch(endpoint, params = {}) {
  const url = new URL(`${CG_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    headers: { "accept": "application/json", "CG-API-KEY": CG_API_KEY },
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) throw new Error(`CoinGlass HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== "0" && json.code !== 0) throw new Error(`CG code=${json.code}`);
  return json.data;
}

/**
 * 拉最近 2 個 15 分鐘桶的清算資料（避免漏掉邊界桶）
 */
async function pollSymbol(symbol, computedAt) {
  const endTime   = Date.now();
  const startTime = endTime - 35 * 60_000;  // 最近 35 分鐘（確保覆蓋最新 2 個完整桶）

  const rows = await cgFetch("/api/futures/liquidation/aggregated-history", {
    symbol,
    interval: "15m",
    startTime,
    endTime,
    exchange_list: EXCHANGE_SET
  });

  if (!Array.isArray(rows) || rows.length === 0) return { new: 0, updated: 0, locked: 0, unchanged: 0 };

  const counts = { new: 0, updated: 0, locked: 0, unchanged: 0 };
  for (const row of rows) {
    const ts  = row.t ?? row.time ?? row.openTime ?? row.createTime;
    const lng = parseFloat(row.longLiquidationUsd  ?? row.aggregated_long_liquidation_usd  ?? row.lls ?? row.buyLiquidationUsd  ?? 0);
    const sht = parseFloat(row.shortLiquidationUsd ?? row.aggregated_short_liquidation_usd ?? row.sls ?? row.sellLiquidationUsd ?? 0);
    const tot = lng + sht;
    if (!ts) continue;

    const action = lockedUpsertLiq(symbol, new Date(ts).toISOString(), tot, lng, sht, EXCHANGE_SET, computedAt);
    counts[action.toLowerCase()] = (counts[action.toLowerCase()] ?? 0) + 1;
  }
  return counts;
}

// ── 重算 z-score → factor_snapshots ──────────────────────────────────────────

const WINDOWS = ["1h", "4h", "24h", "7d"];

function updateFactors(computedAt) {
  let count = 0;
  for (const sym of SYMBOLS) {
    for (const win of WINDOWS) {
      try {
        const { value, score, direction, confidence } = computeCgZscoreForSymbol(sym, win);
        const key = `crypto.derivatives.${sym}.liquidation_${win}`;
        insertFactor.run("cg-liq-poller", key, "derivatives", value, score, direction, confidence, 1, computedAt);
        count++;
      } catch (err) {
        console.error(`[cg-poller] Factor error ${sym} ${win}: ${err.message}`);
      }
    }
  }
  return count;
}

// ── 主輪詢循環 ────────────────────────────────────────────────────────────────

async function runPoll() {
  const computedAt = new Date().toISOString();
  console.log(`[cg-poller] ${computedAt} — polling CoinGlass 15m...`);

  const totals = { new: 0, updated: 0, locked: 0, unchanged: 0 };
  for (const sym of SYMBOLS) {
    try {
      const counts = await pollSymbol(sym, computedAt);
      for (const [k, v] of Object.entries(counts)) totals[k] = (totals[k] ?? 0) + v;
    } catch (err) {
      console.error(`[cg-poller] Poll error ${sym}: ${err.message}`);
    }
    // 每個 symbol 間隔 300ms，避免 rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  const factorCount = updateFactors(computedAt);
  console.log(`[cg-poller] agg rows — new:${totals.new} updated:${totals.updated} locked:${totals.locked} unchanged:${totals.unchanged} | factors:${factorCount}`);
  if (totals.locked > 0) {
    console.warn(`[cg-poller] ⚠ Coinglass 嘗試竄改 ${totals.locked} 筆 48h 外歷史數據，已攔截並記錄 data_revision_log`);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

console.log(`[cg-poller] Starting CoinGlass live 15m poller — symbols: ${SYMBOLS.join(", ")}`);
console.log(`[cg-poller] Poll interval: ${POLL_MS / 60_000} min`);

// 啟動時立即跑一次
runPoll().catch(console.error);

// 定時輪詢
setInterval(() => runPoll().catch(console.error), POLL_MS);

process.on("SIGINT",  () => { console.log("[cg-poller] SIGINT — exiting."); process.exit(0); });
process.on("SIGTERM", () => { console.log("[cg-poller] SIGTERM — exiting."); process.exit(0); });
