/**
 * momentum-detector.js — Level 1 Rate-of-Change Factor 計算器
 *
 * 每 5 分鐘從 factor_snapshots 讀取歷史值，計算動量/加速度 factor，
 * 寫回 factor_snapshots 作為獨立 factor key，供 computeCryptoScores 使用。
 *
 * 新增 factor keys：
 *   crypto.derivatives.{SYM}.funding_rate_momentum  — FR zscore 8h 變化率
 *   crypto.derivatives.{SYM}.lsr_momentum           — LSR 8h 方向變化
 *   crypto.derivatives.{SYM}.oi_momentum            — OI 4h 變化加速度
 *   crypto.derivatives.BTC.liq_spike                — 清算突然放大倍數（contrarian 底部信號）
 *   crypto.derivatives.{SYM}.cvd_momentum           — Taker CVD 4h 動量
 *
 * 執行：
 *   node backend/scripts/momentum-detector.js
 *   pm2 start backend/scripts/momentum-detector.js --name momentum-detector
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const DB_PATH = path.join(__dirname, "..", "gecko.db");
const POLL_MS = 5 * 60 * 1_000;  // 5 分鐘

const SYMBOLS = ["BTC", "ETH", "SOL", "XRP", "ADA", "BNB", "DOGE"];

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 10000");

const insertFactor = db.prepare(`
  INSERT OR REPLACE INTO factor_snapshots
    (run_id, factor_key, factor_category, raw_value, normalized_score,
     direction, confidence, source_tier, extra_json, computed_at)
  VALUES (?, ?, 'derivatives', ?, ?, ?, ?, 2, ?, ?)
`);

// ── 工具函式 ──────────────────────────────────────────────────────────────────

function clamp(v, min = -1, max = 1) { return Math.max(min, Math.min(max, v)); }

/**
 * 讀取某 factor_key 在 N 小時前的 normalized_score
 */
function getScoreNHoursAgo(factorKey, hoursAgo) {
  const cutoff = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  const row = db.prepare(`
    SELECT normalized_score FROM factor_snapshots
    WHERE factor_key = ? AND computed_at <= ?
    ORDER BY computed_at DESC LIMIT 1
  `).get(factorKey, cutoff);
  return row?.normalized_score ?? null;
}

function getLatestScore(factorKey) {
  const row = db.prepare(`
    SELECT normalized_score, raw_value FROM factor_snapshots
    WHERE factor_key = ?
    ORDER BY computed_at DESC LIMIT 1
  `).get(factorKey);
  return row ?? null;
}

function getAvgScore(factorKey, hoursBack) {
  const cutoff = new Date(Date.now() - hoursBack * 3_600_000).toISOString();
  const row = db.prepare(`
    SELECT AVG(normalized_score) as avg_score, COUNT(*) as n FROM factor_snapshots
    WHERE factor_key = ? AND computed_at >= ?
  `).get(factorKey, cutoff);
  return row?.n > 0 ? row.avg_score : null;
}

// ── Momentum 計算邏輯 ─────────────────────────────────────────────────────────

/**
 * Funding Rate Momentum（8h 變化方向）
 * 當 FR zscore 快速上升（多頭過熱加劇）→ bearish 加速訊號
 * 當 FR zscore 快速下降（多頭去槓桿）→ bullish 反轉訊號
 */
function computeFrMomentum(sym) {
  const key = `crypto.derivatives.${sym}.funding_rate_zscore`;
  const cur = getLatestScore(key);
  if (!cur || cur.normalized_score === null) return null;

  const prev8h = getScoreNHoursAgo(key, 8);
  if (prev8h === null) return null;

  const delta = cur.normalized_score - prev8h;
  // delta > 0 means FR getting more negative (bearish) → score negative
  // delta < 0 means FR dropping (unwinding) → contrarian bullish
  const score = clamp(-delta / 0.4);  // ±0.4 change = ±1.0 score
  const dir = score > 0.15 ? "bullish" : score < -0.15 ? "bearish" : "neutral";

  return { score, raw: delta.toFixed(4), dir, confidence: 0.75 };
}

/**
 * LSR Momentum（8h 方向）
 * 多空比快速上升（散戶加速做多）→ contrarian bearish
 * 多空比快速下降（散戶砍多/加空）→ contrarian bullish
 */
function computeLsrMomentum(sym) {
  const key = `crypto.derivatives.${sym.toLowerCase()}.long_short_ratio`;
  const cur = getLatestScore(key);
  if (!cur || cur.normalized_score === null) return null;

  const prev8h = getScoreNHoursAgo(key, 8);
  if (prev8h === null) return null;

  const delta = cur.normalized_score - prev8h;
  // LSR score is already inverse-normalized; rising LSR score = LSR falling = bearish unwind
  // delta in score space: positive delta means score rising = LSR inverse rising = LSR falling
  const score = clamp(delta / 0.3);
  const dir = score > 0.15 ? "bullish" : score < -0.15 ? "bearish" : "neutral";

  return { score, raw: delta.toFixed(4), dir, confidence: 0.70 };
}

/**
 * OI Momentum（4h 加速度）
 * OI 快速擴張 + 方向上漲 → bullish 動力增強
 * OI 快速收縮 → 去槓桿，bearish 或底部信號
 */
function computeOiMomentum(sym) {
  const key = `crypto.derivatives.${sym.toLowerCase()}.open_interest`;
  const cur = getLatestScore(key);
  if (!cur || cur.normalized_score === null) return null;

  const prev4h = getScoreNHoursAgo(key, 4);
  if (prev4h === null) return null;

  const delta = cur.normalized_score - prev4h;
  const score = clamp(delta / 0.4);
  const dir = score > 0.15 ? "bullish" : score < -0.15 ? "bearish" : "neutral";

  return { score, raw: delta.toFixed(4), dir, confidence: 0.65 };
}

/**
 * Liquidation Spike（底部 contrarian 信號）
 * 近 1h 清算量 vs 過去 24h 平均的倍數
 * 倍數 > 2x → 可能是恐慌底部（contrarian bullish）
 * 倍數 < 0.5x → 清算壓力解除（neutral to bullish）
 */
function computeLiqSpike(sym) {
  const key1h = `crypto.derivatives.${sym}.liquidation_1h`;
  const keyLow = `crypto.derivatives.${sym.toLowerCase()}.liquidation_1h`;

  let cur = getLatestScore(key1h) ?? getLatestScore(keyLow);
  if (!cur || cur.normalized_score === null) return null;

  // 24h 平均
  const avg24h = getAvgScore(key1h, 24) ?? getAvgScore(keyLow, 24);
  if (avg24h === null || avg24h === 0) return null;

  const spikeMult = Math.abs(cur.normalized_score) / (Math.abs(avg24h) + 0.01);

  // spike > 3x → extreme → contrarian bullish (capitulation)
  // spike 1-2x → elevated → caution
  let score, dir;
  if (spikeMult > 3.0) {
    score = 0.8;
    dir = "bullish";  // capitulation
  } else if (spikeMult > 1.8) {
    score = 0.4;
    dir = "bullish";  // elevated liq = potential flush
  } else if (spikeMult < 0.3) {
    score = 0.2;
    dir = "neutral";  // quiet
  } else {
    score = 0;
    dir = "neutral";
  }

  return { score, raw: spikeMult.toFixed(3), dir, confidence: 0.80 };
}

/**
 * CVD Momentum（4h 買賣壓力）
 * 讀取 taker_cvd 因子的短期動量
 */
function computeCvdMomentum(sym) {
  const key = `crypto.derivatives.${sym.toLowerCase()}.taker_cvd`;
  const cur = getLatestScore(key);
  if (!cur || cur.normalized_score === null) return null;

  const prev4h = getScoreNHoursAgo(key, 4);
  if (prev4h === null) {
    // 無歷史，用當前值作為動量近似
    const score = clamp(cur.normalized_score);
    return { score, raw: cur.normalized_score.toFixed(4), dir: score > 0.1 ? "bullish" : score < -0.1 ? "bearish" : "neutral", confidence: 0.55 };
  }

  const delta = cur.normalized_score - prev4h;
  const score = clamp(delta / 0.5);
  const dir = score > 0.15 ? "bullish" : score < -0.15 ? "bearish" : "neutral";

  return { score, raw: delta.toFixed(4), dir, confidence: 0.72 };
}

// ── 主輪詢 ────────────────────────────────────────────────────────────────────

function runDetection() {
  const now = new Date();
  const computedAt = now.toISOString().replace("T", " ").slice(0, 19);
  const runId = `momentum_${now.toISOString().slice(0, 16).replace(/[T:]/g, "_")}`;
  let written = 0;

  for (const sym of SYMBOLS) {
    const symL = sym.toLowerCase();

    const toWrite = [
      { key: `crypto.derivatives.${sym}.funding_rate_momentum`, fn: () => computeFrMomentum(sym) },
      { key: `crypto.derivatives.${symL}.lsr_momentum`,         fn: () => computeLsrMomentum(sym) },
      { key: `crypto.derivatives.${symL}.oi_momentum`,          fn: () => computeOiMomentum(sym) },
      { key: `crypto.derivatives.${sym}.liq_spike`,             fn: () => computeLiqSpike(sym) },
      { key: `crypto.derivatives.${symL}.cvd_momentum`,         fn: () => computeCvdMomentum(sym) },
    ];

    for (const { key, fn } of toWrite) {
      try {
        const result = fn();
        if (!result || result.score === null || !Number.isFinite(result.score)) continue;

        insertFactor.run(
          runId, key, result.raw !== undefined ? parseFloat(result.raw) : null,
          result.score, result.dir, result.confidence, null, computedAt
        );
        written++;
      } catch (err) {
        // silent skip per factor
      }
    }
  }

  if (written > 0) {
    console.log(`[momentum-detector] ${computedAt} — wrote ${written} momentum factors`);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

console.log("[momentum-detector] Starting Level 1 rate-of-change factor detector");
console.log(`[momentum-detector] Symbols: ${SYMBOLS.join(", ")}`);
console.log(`[momentum-detector] Poll: every ${POLL_MS / 60_000} min`);

runDetection();
setInterval(runDetection, POLL_MS);

process.on("SIGINT",  () => { console.log("[momentum-detector] exit"); process.exit(0); });
process.on("SIGTERM", () => { console.log("[momentum-detector] exit"); process.exit(0); });
