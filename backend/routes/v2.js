/**
 * v2.js — /api/v2/ 路由
 *
 * 交易系統消息面來源 API：
 *   GET /api/v2/snapshot        — factors + gates 合併快照（主要入口）
 *   GET /api/v2/factors         — 完整 factor vector
 *   GET /api/v2/gates           — 當前 gate conditions
 *   GET /api/v2/gates/summary   — 精簡版 gates（純 key-value）
 *   GET /api/v2/factors/history — 單一 factor 歷史時序
 *   GET /api/v2/signals         — 訊號列表（支援篩選）
 *   GET /api/v2/staleness       — 各 domain 新鮮度狀態
 *   GET /api/v2/pipeline/runs   — 最近 N 次 pipeline 執行紀錄
 *
 * 不破壞現有 /api/ V1 路由。
 */

import { Router } from "express";
import { getSnapshot } from "../database.js";
import { getLatestFactors, getLatestGates, getFactorHistory, getPipelineRuns, getPreviousRunFactors, getCompositeHistory } from "../../v1/src/lib/sqlite.js";
import { computeCompositeScore, computeFactorDelta } from "../../v1/src/lib/composite.js";

// 注意：getLatestFactors/getLatestGates 讀取的是 v1 pipeline 寫入的 factor_snapshots / gate_conditions 表
// backend/gecko.db 是共用資料庫，v1 pipeline 與 backend server 共用同一個 DB 檔案

const router = Router();

// ── Helper ────────────────────────────────────────────────────────

function rowsToFactorMap(rows) {
  const map = {};
  for (const row of rows) {
    const extra = row.extra_json ? (() => { try { return JSON.parse(row.extra_json); } catch { return {}; } })() : {};
    map[row.factor_key] = {
      category: row.factor_category,
      score: row.normalized_score,
      value: row.raw_value,
      direction: row.direction,
      confidence: row.confidence,
      source_tier: row.source_tier,
      computed_at: row.computed_at,
      ...extra
    };
  }
  return map;
}

function rowsToGateMap(rows) {
  const map = {};
  for (const row of rows) {
    const contributing = row.contributing_factors
      ? (() => { try { return JSON.parse(row.contributing_factors); } catch { return []; } })()
      : [];
    map[row.gate_key] = {
      value: row.gate_value === "true" ? true : row.gate_value === "false" ? false : row.gate_value,
      numeric: row.gate_numeric,
      contributing_factors: contributing,
      reason: row.reason,
      confidence: row.confidence,
      computed_at: row.computed_at
    };
  }
  return map;
}

function getStalenessByDomain(factorMap) {
  const domains = {};
  for (const [key, f] of Object.entries(factorMap)) {
    const category = key.split(".")[0];
    if (!domains[category]) {
      domains[category] = { latest_computed_at: f.computed_at, factor_count: 0 };
    }
    if (f.computed_at > domains[category].latest_computed_at) {
      domains[category].latest_computed_at = f.computed_at;
    }
    domains[category].factor_count++;
  }

  const now = Date.now();
  const result = {};
  for (const [cat, info] of Object.entries(domains)) {
    const ageMs = now - new Date(info.latest_computed_at).getTime();
    const ageHours = ageMs / 3_600_000;
    result[cat] = {
      latest_computed_at: info.latest_computed_at,
      age_hours: Number(ageHours.toFixed(2)),
      factor_count: info.factor_count,
      is_stale: ageHours > 6  // 超過 6 小時視為過期
    };
  }
  return result;
}

// ── Stale guard ───────────────────────────────────────────────────
const STALE_HOURS = 8;

function dataAgeHours(computed_at) {
  if (!computed_at) return Infinity;
  return (Date.now() - new Date(computed_at).getTime()) / 3_600_000;
}

// ── GET /api/v2/snapshot ─────────────────────────────────────────
// 一次取回所有 factors + gates + staleness（交易系統主要入口）
// 若資料超過 STALE_HOURS 小時未更新，回傳 503。
// 回應 header 永遠附帶 X-Data-Age-Hours。
router.get("/snapshot", (_req, res) => {
  const factorRows = getLatestFactors();
  const gateRows = getLatestGates();

  if (factorRows.length === 0) {
    return res.status(404).json({
      error: "No factor data available. Run the update script first.",
      hint: "node v1/scripts/update-data.mjs"
    });
  }

  const computed_at = factorRows[0]?.computed_at || null;
  const ageHours = dataAgeHours(computed_at);

  res.setHeader("X-Data-Age-Hours", ageHours.toFixed(2));

  if (ageHours > STALE_HOURS) {
    return res.status(503).json({
      error: "Data is stale",
      computed_at,
      age_hours: Number(ageHours.toFixed(2)),
      stale_threshold_hours: STALE_HOURS,
      hint: "node v1/scripts/update-data.mjs"
    });
  }

  const factors = rowsToFactorMap(factorRows);
  const gates = rowsToGateMap(gateRows);
  const staleness = getStalenessByDomain(factors);
  const composite_score = computeCompositeScore(factors);
  const previousRows = getPreviousRunFactors();
  const factor_delta = computeFactorDelta(factors, previousRows);

  res.json({
    computed_at,
    age_hours: Number(ageHours.toFixed(2)),
    composite_score,
    factor_delta,
    factor_count: Object.keys(factors).length,
    gate_count: Object.keys(gates).length,
    factors,
    gates,
    staleness
  });
});

// ── GET /api/v2/factors ───────────────────────────────────────────
router.get("/factors", (_req, res) => {
  const rows = getLatestFactors();
  if (rows.length === 0) {
    return res.status(404).json({ error: "No factor data available." });
  }
  const factors = rowsToFactorMap(rows);
  res.json({ computed_at: rows[0]?.computed_at, count: Object.keys(factors).length, factors });
});

// ── GET /api/v2/factors/history ───────────────────────────────────
// ?key=macro.yield_10y&days=30
router.get("/factors/history", (req, res) => {
  const { key, days } = req.query;
  if (!key) {
    return res.status(400).json({ error: "Missing required query param: key (e.g. ?key=macro.yield_10y)" });
  }
  const daysNum = Number(days) || 30;
  if (daysNum < 1 || daysNum > 365) {
    return res.status(400).json({ error: "days must be between 1 and 365" });
  }

  const rows = getFactorHistory(key, daysNum);
  res.json({
    factor_key: key,
    days: daysNum,
    count: rows.length,
    history: rows.map((r) => ({
      computed_at: r.computed_at,
      score: r.normalized_score,
      value: r.raw_value,
      direction: r.direction,
      confidence: r.confidence
    }))
  });
});

// ── GET /api/v2/gates ─────────────────────────────────────────────
router.get("/gates", (_req, res) => {
  const rows = getLatestGates();
  if (rows.length === 0) {
    return res.status(404).json({ error: "No gate data available." });
  }
  const gates = rowsToGateMap(rows);
  res.json({ computed_at: rows[0]?.computed_at, count: Object.keys(gates).length, gates });
});

// ── GET /api/v2/gates/summary ─────────────────────────────────────
// 純 key-value，給交易程式直接判斷
router.get("/gates/summary", (_req, res) => {
  const rows = getLatestGates();
  if (rows.length === 0) {
    return res.status(404).json({ error: "No gate data available." });
  }
  const gates = rowsToGateMap(rows);
  const summary = Object.fromEntries(Object.entries(gates).map(([k, v]) => [k, v.value]));
  res.json({ computed_at: rows[0]?.computed_at, summary });
});

// ── GET /api/v2/signals ───────────────────────────────────────────
// ?category=flow&impact=high&since=2026-03-24T00:00:00Z&bias=偏漲
router.get("/signals", (req, res) => {
  const snapshot = getSnapshot("crypto_dashboard:latest");
  if (!snapshot) {
    return res.status(404).json({ error: "No data available." });
  }

  let signals = snapshot.data.cryptoSignals || [];
  const { category, impact, since, bias, limit } = req.query;

  if (category) {
    signals = signals.filter((s) => String(s.category || "").toLowerCase() === String(category).toLowerCase());
  }
  if (impact) {
    signals = signals.filter((s) => String(s.impact || "").toLowerCase() === String(impact).toLowerCase());
  }
  if (since) {
    signals = signals.filter((s) => s.time && s.time >= since);
  }
  if (bias) {
    signals = signals.filter((s) => s.shortTermBias === bias);
  }

  const limitNum = Math.min(Number(limit) || 50, 200);
  signals = signals.slice(0, limitNum);

  res.json({ count: signals.length, signals });
});

// ── GET /api/v2/staleness ─────────────────────────────────────────
router.get("/staleness", (_req, res) => {
  const rows = getLatestFactors();
  if (rows.length === 0) {
    return res.status(404).json({ error: "No factor data available." });
  }
  const factors = rowsToFactorMap(rows);
  res.json({ staleness: getStalenessByDomain(factors) });
});

// ── GET /api/v2/pipeline/runs ─────────────────────────────────────
router.get("/pipeline/runs", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  const runs = getPipelineRuns(limit);
  res.json({ count: runs.length, runs });
});

// ── GET /api/v2/trade/signal ──────────────────────────────────────
// 整合 composite + momentum + gates → 統一進出場訊號
// 供程式交易系統直接讀取，不需要理解底層 factors
router.get("/trade/signal", (_req, res) => {
  const factorRows = getLatestFactors();
  const gateRows   = getLatestGates();
  const histRows   = getCompositeHistory(12); // 最近 12 筆 ≈ 1 小時

  if (factorRows.length === 0) {
    return res.status(404).json({ error: "No factor data. Run update-data.mjs first." });
  }

  const computed_at = factorRows[0]?.computed_at || null;
  const ageHours    = dataAgeHours(computed_at);
  res.setHeader("X-Data-Age-Hours", ageHours.toFixed(2));

  if (ageHours > STALE_HOURS) {
    return res.status(503).json({
      error: "Data is stale",
      computed_at,
      age_hours: Number(ageHours.toFixed(2)),
      stale_threshold_hours: STALE_HOURS
    });
  }

  const factors   = rowsToFactorMap(factorRows);
  const gates     = rowsToGateMap(gateRows);
  const composite = computeCompositeScore(factors);
  if (!composite) {
    return res.status(503).json({ error: "Composite score unavailable." });
  }

  // ── 1. 動能（Momentum）───────────────────────────────────────────
  // 比較最近 3 筆 vs 前 3 筆的平均分數差
  let momentum = "flat";
  let momentum_delta = 0;
  if (histRows.length >= 6) {
    const recent = histRows.slice(0, 3).map(r => r.score);
    const prev   = histRows.slice(3, 6).map(r => r.score);
    const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
    const avgPrev   = prev.reduce((a, b) => a + b, 0) / prev.length;
    momentum_delta  = Number((avgRecent - avgPrev).toFixed(4));
    momentum = momentum_delta > 0.03 ? "rising" : momentum_delta < -0.03 ? "falling" : "flat";
  }

  // ── 2. 方向（Direction）─────────────────────────────────────────
  const score          = composite.score;
  const bullishGate    = gates["direction.bullish_bias"]?.value === true;
  const bearishGate    = gates["direction.bearish_bias"]?.value === true;
  let direction = "neutral";
  if      (score >= 0.15 && bullishGate)  direction = "long";
  else if (score <= -0.15 && bearishGate) direction = "short";
  else if (score >= 0.15)                 direction = "long_weak";   // score 看多但 gate 未確認
  else if (score <= -0.15)                direction = "short_weak";

  // ── 3. Gate 風險評估 ─────────────────────────────────────────────
  const blocking = [];
  if (gates["macro.favorable"]?.value        === false) blocking.push("macro.favorable");
  if (gates["liquidity.adequate"]?.value     === false) blocking.push("liquidity.adequate");
  if (gates["risk.leverage_overextended"]?.value === true) blocking.push("risk.leverage_overextended");
  if (gates["event.blackout_window"]?.value  === true)  blocking.push("event.blackout_window");
  if (gates["risk.yield_curve_inverted"]?.value === true) blocking.push("risk.yield_curve_inverted");
  const regLevel = gates["risk.regulatory_level"]?.value;
  if (regLevel === "high") blocking.push("risk.regulatory_level:high");

  const riskLevel = blocking.length === 0 ? "low"
    : blocking.length <= 1 ? "medium"
    : "high";

  // ── 4. 倉位乘數（0.0 ~ 1.0）─────────────────────────────────────
  // 強度 = abs(score)，覆蓋品質加成，動能折扣，Gate 折扣
  const rawStrength   = Math.min(Math.abs(score) / 0.5, 1.0); // 0.5 以上視為滿強度
  const coverageBonus = (composite.coverage_pct || 0) / 100;
  const strength      = Number((rawStrength * 0.7 + coverageBonus * 0.3).toFixed(3));

  const momentumMult  = momentum === "rising" ? 1.1 : momentum === "falling" ? 0.75 : 1.0;
  const gateMult      = blocking.length === 0 ? 1.0
    : blocking.length === 1 ? 0.6
    : blocking.length === 2 ? 0.3
    : 0.0;

  const position_size_mult = Number(Math.min(strength * momentumMult * gateMult, 1.0).toFixed(3));

  // ── 5. 行動建議（Action）────────────────────────────────────────
  let action = "wait";
  if (gates["event.blackout_window"]?.value === true) {
    action = "wait"; // 重大事件前一律等待
  } else if (blocking.includes("risk.leverage_overextended")) {
    action = "reduce"; // 槓桿過熱 → 降倉
  } else if (gateMult === 0.0) {
    action = "wait"; // 多個 gate 同時封鎖
  } else if (direction === "long" && momentum !== "falling") {
    action = "enter_long";
  } else if (direction === "short" && momentum !== "rising") {
    action = "enter_short";
  } else if (direction === "long" && momentum === "falling") {
    action = "hold_long"; // 方向看多但動能轉弱，不加碼
  } else if (direction === "short" && momentum === "rising") {
    action = "hold_short";
  } else {
    action = "neutral";
  }

  res.json({
    computed_at,
    age_hours: Number(ageHours.toFixed(2)),

    // ── 主要訊號（程式交易直接用這區）
    signal: {
      action,            // enter_long | enter_short | hold_long | hold_short | reduce | neutral | wait
      direction,         // long | long_weak | short | short_weak | neutral
      position_size_mult // 0.0 ~ 1.0，倉位建議乘數
    },

    // ── Composite 詳情
    composite: {
      score:          composite.score,
      label:          composite.label,
      coverage_pct:   composite.coverage_pct,
      strength,
      momentum,        // rising | falling | flat
      momentum_delta   // 動能數值（正=升溫，負=降溫）
    },

    // ── Gate 風險歸因
    gates: {
      risk_level: riskLevel,  // low | medium | high
      blocking,        // 觸發中的風險 gates（空陣列=全通過）
      all_clear: blocking.length === 0,
      detail: {
        macro_favorable:         gates["macro.favorable"]?.value ?? null,
        liquidity_adequate:      gates["liquidity.adequate"]?.value ?? null,
        blackout_window:         gates["event.blackout_window"]?.value ?? null,
        leverage_overextended:   gates["risk.leverage_overextended"]?.value ?? null,
        yield_curve_inverted:    gates["risk.yield_curve_inverted"]?.value ?? null,
        regulatory_level:        regLevel ?? null
      }
    }
  });
});

export default router;
