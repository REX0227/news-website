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

// 現有訊號端點門檻（維持 0.3 不變）
const ENTRY_THRESHOLD = 0.3;

// 三層策略門檻（降低至 0.15，回測驗證有效）
const STRATEGY_THRESHOLD = 0.15;

// ICIR / p-value 警戒值 → confidence 折扣
const ICIR_WARN   = 0.3;   // ICIR < 此值 → ×0.7
const PVAL_WARN   = 0.05;  // p-value ≥ 此值 → ×0.6

// 事件研究事實（方法 E，固定常數）
const REGIME_EVENT = {
  leverage_flush:       { block_long: true,  allow_short: true,  avg_24h: -0.0269, avg_7d: -0.0049, note: "清算爆發後 24h 繼續跌 -2.69%，不開新多單" },
  risk_off:             { contrarian_long: true,                  avg_24h: -0.0016, avg_7d:  0.0414, note: "確認空頭後 7d +4.14%，屬逆向做多機會" },
  risk_off_transition:  { caution: true,                          avg_7d: null,                       note: "空頭過渡中，減少倉位" },
  risk_on:              { favorable_long: true,                   avg_24h:  0.0002, avg_7d:  0.0055, note: "多頭確認，7d +0.55%" },
  risk_on_transition:   { favorable_long: true,                   avg_24h:  0.0002, avg_7d:  0.0064, note: "轉多訊號，7d +0.64%" },
  neutral_drift:        { caution: true,                          avg_7d: null,                       note: "中性漂移，建議減半倉位" },
  neutral:              { caution: true,                          avg_7d: null,                       note: "中性區間，方向不明" },
  bullish:              { favorable_long: true,                   avg_7d:  0.05,                      note: "多頭市場" },
  bearish:              { favorable_short: true,                  avg_7d:  0.0202,                    note: "空頭市場（相對 neutral 報酬較低）" }
};

// ── 快取 ─────────────────────────────────────────────────────────────────────

let _cache = null, _cacheTs = 0;
let _stratCache = null, _stratCacheTs = 0;
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
      // 相容新格式（{test:{ICIR}, all:{ICIR}}）與舊格式（{ICIR}）
      icirMap[row.timeframe] = parsed.test?.ICIR ?? parsed.all?.ICIR ?? parsed.ICIR ?? null;
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

// ── 三層策略端點 ──────────────────────────────────────────────────────────────

router.get("/strategy", (_req, res) => {
  try {
    if (_stratCache && Date.now() - _stratCacheTs < CACHE_TTL) {
      return res.json(_stratCache);
    }
    const payload = buildStrategy();
    _stratCache   = payload;
    _stratCacheTs = Date.now();
    return res.json(payload);
  } catch (e) {
    console.error("[strategy] 錯誤:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── 三層策略邏輯 ──────────────────────────────────────────────────────────────

function buildStrategy() {
  const now = new Date().toISOString();

  // ── 讀取最新 asset_comments ──────────────────────────────────────────────
  const latest = db.prepare(`
    SELECT computed_at, regime_label, regime_confidence,
           score_short_term, score_mid_term
    FROM asset_comments
    WHERE asset_class = 'crypto'
    ORDER BY computed_at DESC LIMIT 1
  `).get();

  if (!latest) {
    return { error: "尚無 asset_comments 資料", computed_at: now };
  }

  const midScore   = latest.score_mid_term   ?? null;
  const shortScore = latest.score_short_term ?? null;
  const regime     = latest.regime_label     ?? "unknown";
  const regConf    = latest.regime_confidence ?? null;

  // ── 讀取最新 MaxDD（test 期）──────────────────────────────────────────────
  const maxddRow = db.prepare(`
    SELECT timeframe, MAX(ABS(pnl)) as rough_max
    FROM backtest_results
    WHERE period = 'test' AND direction != 'flat'
    GROUP BY timeframe
  `).all();
  const maxDDMap = {};
  for (const r of maxddRow) maxDDMap[r.timeframe] = r.rough_max;

  // ── 讀取 test 期 ICIR（用於顯示品質）────────────────────────────────────
  const icirTestMap = {};
  try {
    const rows = db.prepare(`
      SELECT timeframe, result_json FROM enhanced_validation
      WHERE type='rolling_ic' ORDER BY computed_at DESC LIMIT 10
    `).all();
    const seen = new Set();
    for (const r of rows) {
      if (seen.has(r.timeframe)) continue;
      seen.add(r.timeframe);
      const p = JSON.parse(r.result_json);
      icirTestMap[r.timeframe] = p.test?.ICIR ?? p.all?.ICIR ?? p.ICIR ?? null;
    }
  } catch { /* ignore */ }

  // ════════════════════════════════════════════════════════════════════════
  // Layer 1 — 方向決策（mid_term score，最可靠）
  // ════════════════════════════════════════════════════════════════════════

  let l1Direction = "FLAT";
  if (midScore !== null) {
    if (midScore >  STRATEGY_THRESHOLD) l1Direction = "LONG";
    if (midScore < -STRATEGY_THRESHOLD) l1Direction = "SHORT";
  }

  const l1AbsScore = midScore !== null ? Math.abs(midScore) : 0;
  const l1Strength =
    l1AbsScore >= 0.5 ? "strong" :
    l1AbsScore >= 0.3 ? "moderate" :
    l1AbsScore >= 0.15 ? "weak" : "flat";

  // 倉位比例：0.15→50%，0.30→75%，0.50+→100%
  const l1PositionPct = l1Direction === "FLAT" ? 0 :
    Math.min(Math.round((l1AbsScore - STRATEGY_THRESHOLD) / (0.5 - STRATEGY_THRESHOLD) * 50 + 50), 100);

  const layer1 = {
    name: "方向決策（mid_term）",
    score_mid_term: midScore !== null ? +midScore.toFixed(4) : null,
    icir_test: icirTestMap["mid_term"] ?? null,
    direction: l1Direction,
    strength: l1Strength,
    suggested_position_pct: l1PositionPct,
    note: midScore === null ? "mid_term score 不可用"
      : l1Direction === "FLAT" ? `score ${midScore.toFixed(3)} 介於 ±${STRATEGY_THRESHOLD}，不持倉`
      : `score ${midScore.toFixed(3)}，${l1Direction === "LONG" ? "偏多" : "偏空"}（強度=${l1Strength}）`
  };

  // ════════════════════════════════════════════════════════════════════════
  // Layer 2 — 進場時機（Regime 過濾 + short_term 對齊）
  // ════════════════════════════════════════════════════════════════════════

  const regInfo = REGIME_EVENT[regime] ?? {};

  // Regime 過濾
  let regimeAction = "allow";
  let regimeNote = regInfo.note ?? `regime=${regime}，無特殊規則`;

  if (l1Direction === "LONG" && regInfo.block_long) {
    regimeAction = "block_long";
  } else if (l1Direction === "LONG" && regInfo.caution) {
    regimeAction = "caution";
  } else if (l1Direction === "LONG" && regInfo.contrarian_long) {
    regimeAction = "contrarian_opportunity";
  }

  // short_term 時機判斷
  let timingSignal = "neutral";
  let timingNote   = "";
  const ST_ALIGN   = 0.05;  // short_term 同向門檻

  if (l1Direction === "SHORT") {
    if (shortScore !== null && shortScore > ST_ALIGN) {
      timingSignal = "wait_bounce";  // 反彈中，等反彈用盡再做空
      timingNote   = `short_term 正在反彈（${shortScore.toFixed(3)}），等回落至 ${ST_ALIGN} 以下再入場做空，品質更高`;
    } else {
      timingSignal = "enter";
      timingNote   = shortScore !== null
        ? `short_term 同向（${shortScore.toFixed(3)} ≤ ${ST_ALIGN}），可做空`
        : "short_term 不可用，謹慎入場";
    }
  } else if (l1Direction === "LONG") {
    if (regimeAction === "block_long") {
      timingSignal = "blocked";
      timingNote   = `Regime=${regime} 阻擋做多（${regimeNote}）`;
    } else if (shortScore !== null && shortScore < -ST_ALIGN) {
      timingSignal = "wait_pullback";  // 回調中，等回調用盡再做多
      timingNote   = `short_term 正在回調（${shortScore.toFixed(3)}），等回升至 -${ST_ALIGN} 以上再入場做多`;
    } else {
      timingSignal = "enter";
      timingNote   = shortScore !== null
        ? `short_term 同向（${shortScore.toFixed(3)} ≥ -${ST_ALIGN}），可做多`
        : "short_term 不可用，謹慎入場";
    }
  } else {
    timingSignal = "flat";
    timingNote   = "Layer 1 方向為 FLAT，不進場";
  }

  const layer2 = {
    name: "進場時機（Regime + short_term）",
    regime,
    regime_confidence: regConf !== null ? +regConf.toFixed(3) : null,
    regime_action: regimeAction,
    regime_note: regimeNote,
    score_short_term: shortScore !== null ? +shortScore.toFixed(4) : null,
    icir_test: icirTestMap["short_term"] ?? null,
    timing: timingSignal,
    timing_note: timingNote,
    short_term_warning: "⚠️ short_term Monte Carlo p=0.80（不顯著），僅作時機參考，勿單獨決策"
  };

  // ════════════════════════════════════════════════════════════════════════
  // Layer 3 — 停損保護
  // ════════════════════════════════════════════════════════════════════════

  // MaxDD 參考（來自 mid_term test 期回測）
  const midMaxDD = 0.232;   // test 期實測最大回撤 23.2%（long_term）
  const stopLossPct = 5.0;  // 單筆停損 = MAE_NORM（5%）

  // 實際倉位（考慮 Layer 2 阻擋）
  const finalPositionPct = (regimeAction === "block_long" || timingSignal === "blocked")
    ? 0 : l1PositionPct;

  const layer3 = {
    name: "停損保護",
    stop_loss_pct: stopLossPct,
    effective_position_pct: finalPositionPct,
    max_drawdown_ref_pct: +(midMaxDD * 100).toFixed(1),
    note: `單筆停損 ${stopLossPct}%；mid/long_term test 期 MaxDD=${+(midMaxDD*100).toFixed(1)}%；倉位 ${finalPositionPct}%`
  };

  // ════════════════════════════════════════════════════════════════════════
  // Final — 綜合行動建議
  // ════════════════════════════════════════════════════════════════════════

  let finalAction, finalZh, finalReason;

  if (l1Direction === "FLAT") {
    finalAction = "NO_POSITION";
    finalZh     = "不持倉";
    finalReason = `mid_term score=${midScore?.toFixed(3)} 在中性區間 ±${STRATEGY_THRESHOLD}`;
  } else if (timingSignal === "blocked") {
    finalAction = "HOLD_FLAT";
    finalZh     = "觀望（Regime 阻擋）";
    finalReason = `方向 ${l1Direction} 但 ${regimeNote}`;
  } else if (timingSignal === "wait_bounce" || timingSignal === "wait_pullback") {
    finalAction = "WAIT_ENTRY";
    finalZh     = `等待更好進場點（${timingSignal === "wait_bounce" ? "等反彈結束" : "等回調結束"}）`;
    finalReason = timingNote;
  } else if (timingSignal === "enter") {
    finalAction = l1Direction === "LONG" ? "ENTER_LONG" : "ENTER_SHORT";
    finalZh     = l1Direction === "LONG" ? `做多（倉位 ${finalPositionPct}%）` : `做空（倉位 ${finalPositionPct}%）`;
    finalReason = `${timingNote}；停損 ${stopLossPct}%`;
  } else {
    finalAction = "NO_POSITION";
    finalZh     = "不持倉";
    finalReason = "條件未達標";
  }

  return {
    layer1,
    layer2,
    layer3,
    final: {
      action: finalAction,
      zh: finalZh,
      reason: finalReason
    },
    disclaimer: "⚠️ 測試期樣本 22-26 筆，2026-09 後達 100 筆再提高倉位信心",
    data_freshness: latest.computed_at,
    computed_at: now
  };
}

export default router;
