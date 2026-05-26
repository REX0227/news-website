/**
 * coinglass-fr-poller.js — CoinGlass 資金費率即時輪詢
 *
 * 架構：
 *   每 30 分鐘輪詢一次，拉取各交易所最新 2 個結算週期的資金費率
 *   → 寫入 funding_rate（source='coinglass_live'）
 *   → 自動計算 z-score，寫入 factor_snapshots
 *
 * 交易所原生結算週期：
 *   Binance / Bybit / OKX / Gate → 8h
 *   Hyperliquid                  → 1h（最小解析度）
 *
 * 執行：
 *   node backend/scripts/coinglass-fr-poller.js
 *   pm2 start backend/scripts/coinglass-fr-poller.js --name cg-fr-poller
 *
 * Factor keys 寫入 factor_snapshots：
 *   crypto.derivatives.{SYM}.funding_rate_zscore  — 90d z-score（多交易所均值）
 * （funding_rate_latest 已移除 — 絕對值 normalized 無預測力）
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
const POLL_MS    = 30 * 60 * 1_000;  // 30 分鐘

// 超過此時間的資金費率記錄永久凍結，禁止 Coinglass 事後覆寫
const LOCK_THRESHOLD_MS = 8 * 60 * 60 * 1_000;  // 8 小時

if (!CG_API_KEY) {
  console.error("[fr-poller] ERROR: COINGLASS_API_KEY not set in .env");
  process.exit(1);
}

// ── 交易所設定 ────────────────────────────────────────────────────────────────
const EXCHANGE_CONFIGS = [
  {
    exchange: "Binance",
    interval: "8h",
    interval_h: 8,
    symbols: {
      BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT",
      BNB: "BNBUSDT", XRP: "XRPUSDT", DOGE: "DOGEUSDT", ADA: "ADAUSDT"
    }
  },
  {
    exchange: "Bybit",
    interval: "8h",
    interval_h: 8,
    symbols: {
      BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT",
      BNB: "BNBUSDT", XRP: "XRPUSDT", DOGE: "DOGEUSDT", ADA: "ADAUSDT"
    }
  },
  {
    exchange: "OKX",
    interval: "8h",
    interval_h: 8,
    symbols: {
      BTC: "BTC-USDT-SWAP", ETH: "ETH-USDT-SWAP", SOL: "SOL-USDT-SWAP",
      XRP: "XRP-USDT-SWAP", DOGE: "DOGE-USDT-SWAP"
    }
  },
  {
    exchange: "Gate",
    interval: "8h",
    interval_h: 8,
    symbols: {
      BTC: "BTC_USDT", ETH: "ETH_USDT", SOL: "SOL_USDT",
      XRP: "XRP_USDT", DOGE: "DOGE_USDT", ADA: "ADA_USDT"
    }
  },
  {
    exchange: "Hyperliquid",
    interval: "1h",
    interval_h: 1,
    symbols: {
      BTC: "BTC", ETH: "ETH", SOL: "SOL"
    }
  }
];

// 所有需要計算 factor 的主要幣種（以 Binance 為基準）
const FACTOR_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA"];

// ── Database ──────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 10000");

db.exec(`
  CREATE TABLE IF NOT EXISTS funding_rate (
    symbol              TEXT NOT NULL,
    exchange            TEXT NOT NULL,
    funding_rate        REAL NOT NULL,
    funding_interval_h  REAL NOT NULL DEFAULT 8,
    funding_time        TEXT NOT NULL,
    annualized_rate     REAL,
    source              TEXT NOT NULL DEFAULT 'coinglass',
    computed_at         TEXT NOT NULL,
    PRIMARY KEY (symbol, exchange, funding_time)
  );
  CREATE INDEX IF NOT EXISTS idx_fr_sym_time  ON funding_rate(symbol, funding_time DESC);
  CREATE INDEX IF NOT EXISTS idx_fr_exch_time ON funding_rate(exchange, funding_time DESC);

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

// ── Layer 1+2: 時間鎖 upsert（資金費率）────────────────────────────────────────

const _selectExistingFr = db.prepare(`
  SELECT funding_rate
  FROM funding_rate
  WHERE symbol = ? AND exchange = ? AND funding_time = ?
`);

const _insertFrNew = db.prepare(`
  INSERT OR IGNORE INTO funding_rate
    (symbol, exchange, funding_rate, funding_interval_h, funding_time, annualized_rate, source, computed_at)
  VALUES (?, ?, ?, ?, ?, ?, 'coinglass_live', ?)
`);

const _updateFrRecent = db.prepare(`
  UPDATE funding_rate
  SET funding_rate = ?, annualized_rate = ?, computed_at = ?
  WHERE symbol = ? AND exchange = ? AND funding_time = ?
`);

const _insertFrRevision = db.prepare(`
  INSERT INTO data_revision_log
    (table_name, symbol, bucket_start, field_name, old_value, new_value, pct_change, action, detected_at, source)
  VALUES ('funding_rate', ?, ?, 'funding_rate', ?, ?, ?, ?, ?, ?)
`);

/**
 * 時間鎖 upsert：
 *   - 新記錄 → INSERT
 *   - 48h 內有差異 → UPDATE 並寫 revision log（action=UPDATED）
 *   - 48h 外有差異 → 攔截並寫 revision log（action=BLOCKED_TIME_LOCKED），不覆寫
 *
 * @returns {'NEW'|'UPDATED'|'UNCHANGED'|'LOCKED'}
 */
function lockedUpsertFr(symbol, exchange, rate, intervalH, fundingTime, annualizedRate, computedAt) {
  const existing = _selectExistingFr.get(symbol, exchange, fundingTime);
  const bucketAgeMs = Date.now() - new Date(fundingTime).getTime();

  if (!existing) {
    _insertFrNew.run(symbol, exchange, rate, intervalH, fundingTime, annualizedRate, computedAt);
    return "NEW";
  }

  const oldRate = existing.funding_rate ?? 0;
  if (Math.abs(oldRate - rate) <= 1e-8) return "UNCHANGED";

  const pctChange = oldRate !== 0 ? ((rate - oldRate) / Math.abs(oldRate) * 100) : null;
  const sourceLabel = `${exchange}/coinglass_live`;

  if (bucketAgeMs > LOCK_THRESHOLD_MS) {
    _insertFrRevision.run(symbol, fundingTime, oldRate, rate, pctChange, "BLOCKED_TIME_LOCKED", computedAt, sourceLabel);
    return "LOCKED";
  }

  _insertFrRevision.run(symbol, fundingTime, oldRate, rate, pctChange, "UPDATED", computedAt, sourceLabel);
  _updateFrRecent.run(rate, annualizedRate, computedAt, symbol, exchange, fundingTime);
  return "UPDATED";
}

const insertFactor = db.prepare(`
  INSERT INTO factor_snapshots
    (run_id, factor_key, factor_category, raw_value, normalized_score, direction, confidence, source_tier, extra_json, computed_at)
  VALUES (?, ?, 'derivatives', ?, ?, ?, ?, 2, ?, ?)
`);

// ── CoinGlass API ─────────────────────────────────────────────────────────────
async function cgFetch(endpoint, params = {}) {
  const url = new URL(`${CG_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    headers: { "accept": "application/json", "CG-API-KEY": CG_API_KEY },
    signal: AbortSignal.timeout(15_000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== "0" && json.code !== 0) throw new Error(`CG code=${json.code}`);
  return json.data;
}

function parseRow(row) {
  const ts   = row.t ?? row.time ?? row.createTime ?? row.openTime;
  const rate = parseFloat(
    row.fundingRate ?? row.c ?? row.close ?? row.f ?? row.rate ?? row.value ?? NaN
  );
  if (!ts || !Number.isFinite(rate)) return null;
  return { ts: Number(ts), rate };
}

/**
 * 拉取最近 2 個結算週期的資料
 * 用 lookback = 3 * interval_h 小時確保覆蓋最新完整週期
 */
async function pollExchangeSymbol(exchange, canonicalSymbol, nativeSymbol, interval, interval_h, computedAt) {
  const endTime   = Date.now();
  const lookbackMs = 3 * interval_h * 3_600_000;
  const startTime  = endTime - lookbackMs;

  const rows = await cgFetch("/api/futures/funding-rate/history", {
    exchange,
    symbol: nativeSymbol,
    interval,
    startTime,
    endTime
  });

  if (!Array.isArray(rows) || rows.length === 0) return { new: 0, updated: 0, locked: 0, unchanged: 0 };

  const counts = { new: 0, updated: 0, locked: 0, unchanged: 0 };
  for (const row of rows) {
    const parsed = parseRow(row);
    if (!parsed) continue;

    const fundingTime    = new Date(parsed.ts).toISOString();
    const annualizedRate = parsed.rate * (8760 / interval_h) * 100;

    const action = lockedUpsertFr(
      canonicalSymbol, exchange, parsed.rate, interval_h,
      fundingTime, annualizedRate, computedAt
    );
    counts[action.toLowerCase()] = (counts[action.toLowerCase()] ?? 0) + 1;
  }
  return counts;
}

// ── Factor 計算（z-score）────────────────────────────────────────────────────

/**
 * 計算某幣種當前資金費率的 z-score（相對 90 天歷史，多交易所均值）
 *
 * 邏輯：
 *   1. 取最新 8h 週期各交易所費率均值 → current_rate
 *   2. 取 90 天歷史每個 8h 週期的多交易所均值 → hist[]
 *   3. z-score = (current - mean(hist)) / std(hist)
 *   4. score = tanh(z * 0.5)
 *      正費率（多頭付空頭）偏看空；z-score 高 → 多頭過熱 → bearish
 */
function computeFrZscore(canonicalSymbol) {
  const nowMs    = Date.now();
  const cutoff8h = new Date(nowMs - 8 * 3_600_000).toISOString();    // 最近 8h（當前週期）
  const hist90d  = new Date(nowMs - 90 * 24 * 3_600_000).toISOString();

  // 最新費率（各交易所平均，只取 8h 週期交易所）
  const cur = db.prepare(`
    SELECT AVG(funding_rate) AS avg_rate, COUNT(*) AS cnt
    FROM funding_rate
    WHERE symbol = ? AND funding_time >= ?
      AND funding_interval_h = 8
  `).get(canonicalSymbol, cutoff8h);

  const currentRate = cur?.avg_rate ?? null;
  if (currentRate === null || cur.cnt === 0) {
    return { value: null, score: 0, direction: "neutral", confidence: 0.3 };
  }

  // 歷史 8h 週期均值序列（每個 8h 窗口取各交易所平均，作為一個數據點）
  const hist = db.prepare(`
    SELECT
      STRFTIME('%Y-%m-%dT', funding_time) ||
        PRINTF('%02d', CAST(STRFTIME('%H', funding_time) AS INTEGER) / 8 * 8) || ':00:00Z'
        AS period,
      AVG(funding_rate) AS avg_rate
    FROM funding_rate
    WHERE symbol = ? AND funding_time >= ? AND funding_time < ?
      AND funding_interval_h = 8
    GROUP BY period
    ORDER BY period DESC
  `).all(canonicalSymbol, hist90d, cutoff8h);

  let score = 0, direction = "neutral", confidence = 0.4;

  if (hist.length >= 10) {
    const vals = hist.map(r => r.avg_rate);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const std  = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) + 1e-9;
    const z    = (currentRate - mean) / std;

    // 正費率偏看空（多頭過熱），z-score 高 → bearish
    score     = -Math.tanh(z * 0.5);
    direction = score >= 0.15 ? "bullish" : score <= -0.15 ? "bearish" : "neutral";
    confidence = hist.length >= 60 ? 0.85 : 0.65;
  }

  return {
    value: Number(currentRate.toFixed(6)),
    score: Number(score.toFixed(4)),
    direction,
    confidence,
    annualized_pct: Number((currentRate * (8760 / 8) * 100).toFixed(2))
  };
}

/**
 * 計算最新費率（相對 1 BPS = 0.01% 基準的 normalized score）
 * 用於展示用，不做 z-score
 */
function computeFrLatest(canonicalSymbol, exchangeFilter = "Binance") {
  const row = db.prepare(`
    SELECT funding_rate, funding_interval_h, funding_time, annualized_rate
    FROM funding_rate
    WHERE symbol = ? AND exchange = ?
    ORDER BY funding_time DESC LIMIT 1
  `).get(canonicalSymbol, exchangeFilter);

  if (!row) return null;

  const rate   = row.funding_rate;
  // 正費率 = 多頭付空頭，越高越 bearish（過熱）
  // 以 0.01% (0.0001) = 基準；0.03% 以上算高；-0.01% 以下算很低
  const NEUTRAL_BAND = 0.0001;   // ±0.01%
  const HIGH_THRESH  = 0.0003;   // +0.03%
  const LOW_THRESH   = -0.0001;  // -0.01%

  let score;
  if (Math.abs(rate) < NEUTRAL_BAND) {
    score = 0;
  } else if (rate > 0) {
    score = -Math.min(rate / HIGH_THRESH, 1.0);  // bearish（多頭過熱）
  } else {
    score = Math.min(-rate / Math.abs(LOW_THRESH), 1.0);  // bullish（空頭過熱，反轉訊號）
  }

  const direction = score >= 0.15 ? "bullish" : score <= -0.15 ? "bearish" : "neutral";

  return {
    value: rate,
    score: Number(score.toFixed(4)),
    direction,
    confidence: 0.80,
    funding_time: row.funding_time,
    annualized_pct: Number(row.annualized_rate?.toFixed(2) ?? 0)
  };
}

// ── 輪詢主程序 ────────────────────────────────────────────────────────────────
async function runPoll() {
  const computedAt = new Date().toISOString();
  console.log(`[fr-poller] ${computedAt} — polling CoinGlass funding rates...`);

  const totals = { new: 0, updated: 0, locked: 0, unchanged: 0 };

  for (const cfg of EXCHANGE_CONFIGS) {
    for (const [canonicalSym, nativeSym] of Object.entries(cfg.symbols)) {
      try {
        const counts = await pollExchangeSymbol(
          cfg.exchange, canonicalSym, nativeSym,
          cfg.interval, cfg.interval_h, computedAt
        );
        for (const [k, v] of Object.entries(counts)) totals[k] = (totals[k] ?? 0) + v;
      } catch (err) {
        console.error(`[fr-poller] Error ${cfg.exchange}/${canonicalSym}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`[fr-poller] fr rows — new:${totals.new} updated:${totals.updated} locked:${totals.locked} unchanged:${totals.unchanged}`);
  if (totals.locked > 0) {
    console.warn(`[fr-poller] ⚠ Coinglass 嘗試竄改 ${totals.locked} 筆 48h 外歷史費率，已攔截並記錄 data_revision_log`);
  }

  // 計算 factor scores，寫入 factor_snapshots
  let factorCount = 0;
  const runId = `cg-fr-poller-${Date.now()}`;

  for (const sym of FACTOR_SYMBOLS) {
    try {
      // Factor 1: 多交易所 z-score（90天歷史）
      const zResult = computeFrZscore(sym);
      if (zResult.value !== null) {
        const extraZ = JSON.stringify({
          annualized_pct: zResult.annualized_pct,
          data_source: "coinglass_multi_exchange_8h"
        });
        insertFactor.run(
          runId,
          `crypto.derivatives.${sym}.funding_rate_zscore`,
          zResult.value, zResult.score, zResult.direction, zResult.confidence,
          extraZ, computedAt
        );
        factorCount++;
      }

      // Factor 2 (funding_rate_latest) 已移除 — 絕對值 normalized 永遠偏空，無預測力
    } catch (err) {
      console.error(`[fr-poller] Factor error ${sym}: ${err.message}`);
    }
  }

  console.log(`[fr-poller] factors written: ${factorCount}`);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
console.log(`[fr-poller] Starting CoinGlass funding rate poller`);
console.log(`[fr-poller] Exchanges: ${EXCHANGE_CONFIGS.map(c => `${c.exchange}(${c.interval})`).join(", ")}`);
console.log(`[fr-poller] Poll interval: ${POLL_MS / 60_000} min`);

runPoll().catch(console.error);
setInterval(() => runPoll().catch(console.error), POLL_MS);

process.on("SIGINT",  () => { console.log("[fr-poller] SIGINT — exiting."); process.exit(0); });
process.on("SIGTERM", () => { console.log("[fr-poller] SIGTERM — exiting."); process.exit(0); });
