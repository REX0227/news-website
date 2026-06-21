/**
 * signal.js — 投資訊號 API（方法 G）
 *
 * GET /api/v2/investment-signal
 *
 * 彙整現有 regime + score（方法 A/B）+ 回測品質（方法 B 彙整）+
 * 訊號穩定性（方法 D ICIR）+ 統計顯著性（方法 F Monte Carlo）
 * → 輸出短/中/長期投資方向（做多/做空/不持倉）+ confidence
 *
 * ⚠️  不改動任何現有路由，僅新增此端點
 */

import { Router } from "express";
import { db } from "../database.js";

const router = Router();

// 做多/空門檻（與 backtest-engine.mjs 同步）
const ENTRY_THRESHOLD = 0.3;

// ICIR / p-value 警戒值 → confidence 折扣
const ICIR_WARN   = 0.3;   // ICIR < 此值 → ×0.7
const PVAL_WARN   = 0.05;  // p-value ≥ 此值 → ×0.6

// ── 快取（60 秒避免重複讀 DB）────────────────────────────────────────────────

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 60_000;

// ── 主路由 ────────────────────────────────────────────────────────────────────

router.get("/investment-signal", async (_req, res) => {
  try {
    if (_cache && Date.now() - _cacheTs < CACHE_TTL) {
      return res.json(_cache);
    }

    const payload = buildSignal();
    _cache   = payload;
    _cacheTs = Date.now();
    return res.json(payload);
  } catch (e) {
    console.error("[signal] 錯誤:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── 歷史訊號列表（最近 30 筆 asset_comments）──────────────────────────────────

router.get("/investment-signal/history", (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT computed_at, regime_label, regime_confidence, score_short_term, score_mid_term
      FROM asset_comments
      WHERE asset_class = 'crypto'
      ORDER BY computed_at DESC
      LIMIT 30
    `).all();

    const history = rows.map(r => ({
      computed_at: r.computed_at,
      regime: r.regime_label,
      short_term: scoreToSignal(r.score_short_term, null, null),
      mid_term:   scoreToSignal(r.score_mid_term,   null, null)
    }));

    return res.json({ history });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── 回測彙整摘要 ──────────────────────────────────────────────────────────────

router.get("/investment-signal/backtest-summary", (_req, res) => {
  try {
    const summary = buildBacktestSummary();
    return res.json(summary);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── 核心邏輯 ──────────────────────────────────────────────────────────────────

function buildSignal() {
  const now = new Date().toISOString();

  // 1. 最新 asset_comments
  const latest = db.prepare(`
    SELECT computed_at, regime_label, regime_confidence, score_short_term, score_mid_term, full_json
    FROM asset_comments
    WHERE asset_class = 'crypto'
    ORDER BY computed_at DESC
    LIMIT 1
  `).get();

  // 2. 最新 enhanced_validation（rolling_ic）→ ICIR per timeframe
  const icirMap = {};
  try {
    const icRows = db.prepare(`
      SELECT timeframe, result_json
      FROM enhanced_validation
      WHERE type = 'rolling_ic'
      ORDER BY computed_at DESC
      LIMIT 10
    `).all();

    const seen = new Set();
    for (const row of icRows) {
      if (seen.has(row.timeframe)) continue;
      seen.add(row.timeframe);
      const parsed = JSON.parse(row.result_json);
      icirMap[row.timeframe] = parsed.ICIR ?? null;
    }
  } catch { /* table may not exist yet */ }

  // 3. 最新 monte_carlo → p-value per timeframe
  const mcMap = {};
  try {
    const mcRows = db.prepare(`
      SELECT timeframe, result_json
      FROM enhanced_validation
      WHERE type = 'monte_carlo'
      ORDER BY computed_at DESC
      LIMIT 10
    `).all();

    const seen = new Set();
    for (const row of mcRows) {
      if (seen.has(row.timeframe)) continue;
      seen.add(row.timeframe);
      const parsed = JSON.parse(row.result_json);
      mcMap[row.timeframe] = parsed.p_value ?? null;
    }
  } catch { /* table may not exist yet */ }

  // 4. 回測品質（test 期）
  const btQuality = buildBacktestSummary();

  // 5. 組合訊號
  const shortScore = latest?.score_short_term ?? null;
  const midScore   = latest?.score_mid_term   ?? null;
  // long_term 暫用 mid 分數（長期 factor 計算待擴充）
  const longScore  = midScore;

  const shortIcir  = icirMap["short_term"]  ?? null;
  const midIcir    = icirMap["mid_term"]    ?? null;
  const longIcir   = icirMap["long_term"]   ?? icirMap["mid_term"] ?? null;

  const shortPval  = mcMap["short_term"]    ?? null;
  const midPval    = mcMap["mid_term"]      ?? null;
  const longPval   = mcMap["long_term"]     ?? mcMap["mid_term"]   ?? null;

  const shortSharpe = btQuality?.by_timeframe?.short_term?.test?.sharpe ?? null;
  const midSharpe   = btQuality?.by_timeframe?.mid_term?.test?.sharpe   ?? null;

  // 提取 long_term score（若 full_json 有的話）
  let longScoreRaw = longScore;
  if (latest?.full_json) {
    try {
      const fj = JSON.parse(latest.full_json);
      if (fj.scores?.long_term?.direction !== undefined) {
        longScoreRaw = fj.scores.long_term.direction;
      }
    } catch { /* ignore */ }
  }

  return {
    signal: {
      short_term: scoreToSignal(shortScore, shortIcir, shortPval),
      mid_term:   scoreToSignal(midScore,   midIcir,   midPval),
      long_term:  scoreToSignal(longScoreRaw, longIcir, longPval)
    },
    regime: latest?.regime_label ?? null,
    regime_confidence: latest?.regime_confidence ?? null,
    quality: {
      short_term: {
        icir:    shortIcir,
        monte_carlo_pvalue: shortPval,
        significant: shortPval !== null ? shortPval < PVAL_WARN : null,
        sharpe_test: shortSharpe
      },
      mid_term: {
        icir:    midIcir,
        monte_carlo_pvalue: midPval,
        significant: midPval !== null ? midPval < PVAL_WARN : null,
        sharpe_test: midSharpe
      },
      long_term: {
        icir:    longIcir,
        monte_carlo_pvalue: longPval,
        significant: longPval !== null ? longPval < PVAL_WARN : null
      }
    },
    data_freshness: latest?.computed_at ?? null,
    computed_at: now,
    note: !latest ? "⚠️ 尚無 asset_comments 資料，請先執行 regime-heartbeat.js" : null
  };
}

/**
 * score → { direction, confidence, score }
 * direction: 'long' | 'short' | 'flat'
 */
function scoreToSignal(score, icir, pvalue) {
  if (score === null || score === undefined) {
    return { direction: "flat", confidence: null, score: null };
  }

  let direction = "flat";
  if (score > ENTRY_THRESHOLD)  direction = "long";
  if (score < -ENTRY_THRESHOLD) direction = "short";

  // base confidence = |score| clamped [0,1]
  let confidence = Math.min(Math.abs(score) * 2, 1);

  // ICIR 折扣
  if (icir !== null && icir < ICIR_WARN) confidence *= 0.7;

  // Monte Carlo 折扣
  if (pvalue !== null && pvalue >= PVAL_WARN) confidence *= 0.6;

  return {
    direction,
    confidence: +confidence.toFixed(3),
    score: +score.toFixed(4)
  };
}

/**
 * 從 backtest_results 計算彙整指標（Sharpe / Win Rate）
 */
function buildBacktestSummary() {
  let rows;
  try {
    rows = db.prepare(`
      SELECT timeframe, period, pnl, mae, quality_score, direction
      FROM backtest_results
      WHERE direction != 'flat'
    `).all();
  } catch {
    return { by_timeframe: {} };
  }

  if (!rows.length) return { by_timeframe: {} };

  const byTF = {};
  for (const row of rows) {
    if (!byTF[row.timeframe]) byTF[row.timeframe] = { dev: [], test: [] };
    const arr = row.period === "dev" ? byTF[row.timeframe].dev : byTF[row.timeframe].test;
    arr.push(row);
  }

  const result = { by_timeframe: {} };
  const HOLD_DAYS = { short_term: 3, mid_term: 7, long_term: 14 };

  for (const [tf, periods] of Object.entries(byTF)) {
    result.by_timeframe[tf] = {};
    for (const [period, trades] of Object.entries(periods)) {
      if (!trades.length) continue;
      const pnls = trades.map(t => t.pnl);
      const hits = trades.filter(t => t.pnl > 0).length;
      const m = pnls.reduce((s, v) => s + v, 0) / pnls.length;
      const variance = pnls.reduce((s, v) => s + (v - m) ** 2, 0) / (pnls.length - 1);
      const s = Math.sqrt(variance) || 1e-9;
      const holdD = HOLD_DAYS[tf] ?? 7;
      const sharpe = (m / s) * Math.sqrt(365 / holdD);
      const avgQ   = trades.filter(t => t.quality_score !== null).reduce((s, t) => s + t.quality_score, 0) /
                     (trades.filter(t => t.quality_score !== null).length || 1);

      result.by_timeframe[tf][period] = {
        n: trades.length,
        sharpe: +sharpe.toFixed(3),
        win_rate: +(hits / trades.length).toFixed(3),
        avg_quality_score: +avgQ.toFixed(3)
      };
    }
  }

  return result;
}

export default router;
