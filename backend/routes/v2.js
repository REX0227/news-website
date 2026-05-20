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
import { getSnapshot, db } from "../database.js";
import { getLatestFactors, getLatestGates, getFactorHistory, getPipelineRuns, getPreviousRunFactors, getCompositeHistory } from "../../v1/src/lib/sqlite.js";
import { computeCompositeScore, computeFactorDelta } from "../../v1/src/lib/composite.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname_v2 = dirname(fileURLToPath(import.meta.url));

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

// ── GET /api/v2/snapshots  (§5.2 — lineage index) ────────────────────────────
// Lists recent pipeline snapshots for replay.
//
// ?limit=20   (default 20, max 100)
// ?before=ISO (pagination cursor — snapshots before this timestamp)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/snapshots", (req, res) => {
  const limit  = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const before = req.query.before || null;

  try {
    const rows = before
      ? db.prepare(`
          SELECT run_id, started_at, completed_at, factor_count, gate_count,
                 collectors_ok, collectors_failed
          FROM pipeline_runs WHERE started_at < ?
          ORDER BY started_at DESC LIMIT ?
        `).all(before, limit)
      : db.prepare(`
          SELECT run_id, started_at, completed_at, factor_count, gate_count,
                 collectors_ok, collectors_failed
          FROM pipeline_runs
          ORDER BY started_at DESC LIMIT ?
        `).all(limit);

    const snapshots = rows.map(r => {
      let ok = 0, failed = 0;
      try { ok     = JSON.parse(r.collectors_ok     || "[]").length; } catch (_) {}
      try { failed = JSON.parse(r.collectors_failed  || "[]").length; } catch (_) {}
      return {
        id:            r.run_id,
        started_at:    r.started_at,
        completed_at:  r.completed_at,
        factor_count:  r.factor_count,
        gate_count:    r.gate_count,
        collectors_ok: ok,
        collectors_failed: failed,
        replay_url:    `/api/v2/snapshot?id=${r.run_id}`
      };
    });

    res.json({
      generated_at: new Date().toISOString(),
      count:        snapshots.length,
      next_cursor:  snapshots.length === limit ? snapshots[snapshots.length - 1].started_at : null,
      snapshots
    });
  } catch (err) {
    console.error("[v2/snapshots] Error:", err.message);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

// ── GET /api/v2/snapshot ─────────────────────────────────────────
// ⚠️  DEPRECATED — 計畫於 2026-10-01 移除
// 建議替代：GET /api/v2/factors + GET /api/comment（並行）
//
// §5.2 Lineage: ?id={run_id} → replay any historical snapshot
router.get("/snapshot", (req, res) => {
  res.setHeader("Deprecation", 'date="2026-10-01T00:00:00Z"');
  res.setHeader("Sunset", "2026-10-01T00:00:00Z");
  res.setHeader("Link", '</api/v2/factors>; rel="successor-version"');
  res.setHeader("Warning", '299 - "Deprecated, use /api/v2/factors + /api/comment instead. Sunset 2026-10-01."');

  // §5.2 Lineage: ?id={run_id} replays a specific historical snapshot
  const runId = req.query.id || null;
  if (runId) {
    try {
      const run = db.prepare("SELECT * FROM pipeline_runs WHERE run_id = ?").get(runId);
      if (!run) {
        return res.status(404).json({ error: "Snapshot not found", run_id: runId });
      }
      const fRows = db.prepare(`
        SELECT factor_key, factor_category, normalized_score AS score, raw_value AS value,
               direction, confidence, source_tier, extra_json, computed_at
        FROM factor_snapshots WHERE run_id = ?
      `).all(runId);
      const gRows = db.prepare(`
        SELECT gate_key, gate_value AS value, gate_numeric AS numeric, contributing_factors,
               reason, confidence, computed_at
        FROM gate_conditions WHERE run_id = ?
      `).all(runId);

      const factors = {};
      for (const r of fRows) {
        const extra = r.extra_json ? (() => { try { return JSON.parse(r.extra_json); } catch { return {}; } })() : {};
        factors[r.factor_key] = { category: r.factor_category, score: r.score, value: r.value, direction: r.direction, confidence: r.confidence, source_tier: r.source_tier, computed_at: r.computed_at, ...extra };
      }
      const gates = {};
      for (const r of gRows) {
        const cf = r.contributing_factors ? (() => { try { return JSON.parse(r.contributing_factors); } catch { return []; } })() : [];
        gates[r.gate_key] = { value: r.value, numeric: r.numeric, contributing_factors: cf, reason: r.reason, confidence: r.confidence, computed_at: r.computed_at };
      }

      return res.json({
        replay: true,
        run_id: runId,
        started_at: run.started_at,
        computed_at: run.completed_at || run.started_at,
        factor_count: fRows.length,
        gate_count: gRows.length,
        factors,
        gates
      });
    } catch (err) {
      return res.status(500).json({ error: "Replay failed", detail: err.message });
    }
  }

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
// v2 升級：multi-key、resample、730 天上限
//
// ?key=macro.yield_10y                    (單 key，向下相容)
// ?keys=macro.yield_10y,macro.vix,macro.dxy  (multi-key，最多 10 個)
// ?days=30                                (1-730，預設 30)
// ?asset_class=crypto                     (篩選該 asset_class 的 key 前綴)
// ?resample=raw|1h|4h|1d                  (預設 raw；server 端降採樣)
router.get("/factors/history", (req, res) => {
  // ── 解析 key / keys ───────────────────────────────────────────
  const keysParam = req.query.keys || req.query.key || "";
  if (!keysParam) {
    return res.status(400).json({
      error: "Missing required query param: key or keys",
      example: "?keys=macro.yield_10y,macro.vix&days=30&resample=1h"
    });
  }

  const keys = keysParam.split(",").map(k => k.trim()).filter(Boolean).slice(0, 10);
  if (keys.length === 0) {
    return res.status(400).json({ error: "No valid keys provided" });
  }

  // ── 解析 days ─────────────────────────────────────────────────
  const daysNum = Math.min(Math.max(Number(req.query.days) || 30, 1), 730);
  const since = new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000).toISOString();

  // ── asset_class filter（prefix 篩選）──────────────────────────
  const assetClass = req.query.asset_class || null;

  // ── resample 參數 ─────────────────────────────────────────────
  const resample = ["raw", "1h", "4h", "1d"].includes(req.query.resample)
    ? req.query.resample : "raw";

  // ── 查詢 DB ───────────────────────────────────────────────────
  // 每個 key 各自查詢（避免 IN + 跨 key 交叉污染）
  const results = {};

  for (const factorKey of keys) {
    // asset_class filter：若指定則 key 必須以 asset_class 開頭
    if (assetClass && !factorKey.startsWith(assetClass + ".") && !factorKey.startsWith("macro.")) {
      results[factorKey] = { count: 0, history: [], filtered_by_asset_class: true };
      continue;
    }

    let rows;
    try {
      rows = db.prepare(`
        SELECT computed_at, normalized_score AS score, raw_value AS value,
               direction, confidence
        FROM factor_snapshots
        WHERE factor_key = ? AND computed_at >= ?
        ORDER BY computed_at ASC
      `).all(factorKey, since);
    } catch {
      rows = [];
    }

    // ── Resample ────────────────────────────────────────────────
    if (resample !== "raw" && rows.length > 0) {
      rows = resampleRows(rows, resample);
    }

    results[factorKey] = { count: rows.length, history: rows };
  }

  // ── 回應 ─────────────────────────────────────────────────────
  const isSingle = keys.length === 1 && !req.query.keys;
  if (isSingle) {
    // 向下相容：單 key 用舊格式
    const key = keys[0];
    const { count, history } = results[key] || { count: 0, history: [] };
    return res.json({ factor_key: key, days: daysNum, resample, count, history });
  }

  res.json({
    keys,
    days: daysNum,
    resample,
    asset_class: assetClass,
    results
  });
});

/**
 * resampleRows — 將 raw 5 分鐘資料降採樣到 1h / 4h / 1d
 * 每個 bucket 取 last（最新一筆），score 取 mean
 */
function resampleRows(rows, interval) {
  const bucketMs = interval === "1h" ? 3_600_000
    : interval === "4h" ? 4 * 3_600_000
    : 24 * 3_600_000; // 1d

  const buckets = new Map();

  for (const r of rows) {
    const ts = new Date(r.computed_at).getTime();
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    if (!buckets.has(bucket)) {
      buckets.set(bucket, { scores: [], values: [], last: r });
    }
    const b = buckets.get(bucket);
    if (r.score !== null) b.scores.push(r.score);
    b.values.push(r.value);
    b.last = r; // 最後一筆作為 direction/confidence 代表
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucket, b]) => ({
      computed_at: new Date(bucket).toISOString(),
      score: b.scores.length
        ? Number((b.scores.reduce((s, v) => s + v, 0) / b.scores.length).toFixed(4))
        : null,
      value: b.last.value,
      direction: b.last.direction,
      confidence: b.last.confidence
    }));
}

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

// ── GET /api/v2/news/validation ───────────────────────────────────
// 返回最新一次 validate-news-direction.mjs 執行結果（summary only）
// ?detail=1 同時返回逐筆 detail（可能較大）
router.get("/news/validation", (req, res) => {
  const filePath = join(__dirname_v2, "../../v1/data/direction-validation.json");
  if (!existsSync(filePath)) {
    return res.status(404).json({
      error: "驗證結果尚未生成。請執行：node v1/scripts/validate-news-direction.mjs"
    });
  }
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (req.query.detail === "1") {
      return res.json(data);
    }
    return res.json({ summary: data.summary });
  } catch (e) {
    return res.status(500).json({ error: "讀取驗證結果失敗", detail: e.message });
  }
});

// ── Bias helpers ──────────────────────────────────────────────────
// 中文 ↔ English 雙向對應（供 /signals bias 篩選 + 回應正規化使用）
const ZH_TO_EN = {
  "偏漲": "bullish", "偏多": "bullish", "做多": "bullish", "強烈看漲": "strong_bullish",
  "偏跌": "bearish", "偏空": "bearish", "做空": "bearish", "強烈看跌": "strong_bearish",
  "震盪": "neutral", "中性": "neutral",
};
const EN_TO_ZH = {
  bullish: ["偏漲", "偏多", "做多"],
  strong_bullish: ["強烈看漲"],
  bearish: ["偏跌", "偏空", "做空"],
  strong_bearish: ["強烈看跌"],
  neutral: ["震盪", "中性"],
};
const BIAS_SCORE = { bullish: 1, strong_bullish: 1, bearish: -1, strong_bearish: -1, neutral: 0 };

function normBiasEn(zhBias) {
  return ZH_TO_EN[zhBias] || zhBias || "unknown";
}
function normBiasScore(zhBias) {
  const en = normBiasEn(zhBias);
  return BIAS_SCORE[en] ?? null;
}

// ── GET /api/v2/signals ───────────────────────────────────────────
// ?category=flow&impact=high&since=2026-03-24T00:00:00Z
// ?bias=bullish|bearish|neutral  (English 或 中文均接受)
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
    // 支援 English（bullish/bearish/neutral）或直接輸入中文
    const biasLower = String(bias).toLowerCase();
    const zhValues = EN_TO_ZH[biasLower] || [bias];
    signals = signals.filter((s) => zhValues.includes(s.shortTermBias) || s.shortTermBias === bias);
  }

  const limitNum = Math.min(Number(limit) || 50, 200);
  signals = signals.slice(0, limitNum);

  // 回應加入 bias_en / bias_score 欄位，方便程式交易直接判讀
  const normalized = signals.map((s) => ({
    ...s,
    bias_en: normBiasEn(s.shortTermBias),
    bias_score: normBiasScore(s.shortTermBias),
  }));

  res.json({ count: normalized.length, signals: normalized });
});

// ── GET /api/v2/staleness ─────────────────────────────────────────
// ⚠️  DEPRECATED — 計畫於 2026-10-01 移除
// 建議替代：staleness 資訊已整合在 /api/v2/factors response 的 metadata 中
router.get("/staleness", (_req, res) => {
  res.setHeader("Deprecation", 'date="2026-10-01T00:00:00Z"');
  res.setHeader("Sunset", "2026-10-01T00:00:00Z");
  res.setHeader("Link", '</api/v2/factors>; rel="successor-version"');
  res.setHeader("Warning", '299 - "Deprecated, staleness is now in /api/v2/factors metadata. Sunset 2026-10-01."');
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

// ── GET /api/v2/sla  (§5.5) ──────────────────────────────────────────────────
// Per-collector SLA computed from pipeline_runs history.
//
// Query params:
//   ?days=7   lookback window (default 7, max 30)
//
// Response per collector:
//   total_runs, success_runs, failed_runs, sla_pct, last_success_at, last_failure_at
// ─────────────────────────────────────────────────────────────────────────────

router.get("/sla", (req, res) => {
  const days    = Math.min(Math.max(Number(req.query.days) || 7, 1), 30);
  const cutoff  = new Date(Date.now() - days * 24 * 3_600_000).toISOString();

  try {
    const runs = db.prepare(`
      SELECT started_at, completed_at, collectors_ok, collectors_failed
      FROM pipeline_runs WHERE started_at >= ?
      ORDER BY started_at ASC
    `).all(cutoff);

    // Aggregate per collector
    const stats = {};

    for (const run of runs) {
      const ts = run.completed_at || run.started_at;
      let ok = [], failed = [];
      try { ok     = JSON.parse(run.collectors_ok     || "[]"); } catch (_) {}
      try { failed = JSON.parse(run.collectors_failed  || "[]"); } catch (_) {}

      for (const name of ok) {
        if (!stats[name]) stats[name] = { total: 0, success: 0, failed: 0, last_success_at: null, last_failure_at: null };
        stats[name].total++;
        stats[name].success++;
        if (!stats[name].last_success_at || ts > stats[name].last_success_at) {
          stats[name].last_success_at = ts;
        }
      }
      for (const name of failed) {
        if (!stats[name]) stats[name] = { total: 0, success: 0, failed: 0, last_success_at: null, last_failure_at: null };
        stats[name].total++;
        stats[name].failed++;
        if (!stats[name].last_failure_at || ts > stats[name].last_failure_at) {
          stats[name].last_failure_at = ts;
        }
      }
    }

    const collectors = {};
    for (const [name, s] of Object.entries(stats)) {
      collectors[name] = {
        total_runs:      s.total,
        success_runs:    s.success,
        failed_runs:     s.failed,
        sla_pct:         s.total > 0 ? Number(((s.success / s.total) * 100).toFixed(1)) : null,
        last_success_at: s.last_success_at,
        last_failure_at: s.last_failure_at
      };
    }

    // Sort by sla_pct ascending so worst are first
    const sorted = Object.fromEntries(
      Object.entries(collectors).sort((a, b) => (a[1].sla_pct ?? 100) - (b[1].sla_pct ?? 100))
    );

    res.json({
      generated_at:   new Date().toISOString(),
      lookback_days:  days,
      total_runs:     runs.length,
      collectors:     sorted
    });
  } catch (err) {
    console.error("[v2/sla] Error:", err.message);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

// ── GET /api/v2/liquidations ─────────────────────────────────────────────────
// Returns aggregated liquidation data from the self-built WS aggregator.
// Reads from: factor_snapshots (for scores) + liquidation_raw (for raw totals)
//
// Query params:
//   ?symbol=BTC,ETH    (default: all tracked symbols)
//   ?window=1h,4h,24h,7d  (default: all windows)
//   ?format=factors    (return as flat factor-vector style; default: grouped)
// ─────────────────────────────────────────────────────────────────────────────

const LIQ_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "TRX", "FIL", "LINK"];
const LIQ_WINDOWS = ["1h", "4h", "24h", "7d"];

router.get("/liquidations", (req, res) => {
  const symParam = req.query.symbol;
  const winParam = req.query.window;
  const format   = req.query.format || "grouped";

  const symbols = symParam
    ? symParam.split(",").map(s => s.toUpperCase()).filter(s => LIQ_SYMBOLS.includes(s))
    : LIQ_SYMBOLS;

  const windows = winParam
    ? winParam.split(",").filter(w => LIQ_WINDOWS.includes(w))
    : LIQ_WINDOWS;

  if (symbols.length === 0 || windows.length === 0) {
    return res.status(400).json({ error: "Invalid symbol or window parameter" });
  }

  try {
    // Pull latest factor snapshot per key
    const placeholders = symbols.flatMap(s => windows.map(w => `crypto.derivatives.${s}.liquidation_${w}`));
    const inClause = placeholders.map(() => "?").join(",");

    // factor_snapshots uses: normalized_score, raw_value (not score/value)
    const rows = db.prepare(`
      SELECT factor_key, normalized_score AS score, raw_value AS value, direction, computed_at
      FROM factor_snapshots
      WHERE factor_key IN (${inClause})
      AND computed_at = (
        SELECT MAX(f2.computed_at) FROM factor_snapshots f2 WHERE f2.factor_key = factor_snapshots.factor_key
      )
    `).all(...placeholders);

    // Build a lookup map
    const lookup = {};
    for (const row of rows) {
      lookup[row.factor_key] = row;
    }

    // Check for data — if no factor snapshots exist yet (daemon just started), use raw sums
    const hasFactorData = rows.length > 0;

    if (format === "factors") {
      // Flat factor-vector style for downstream signal consumers
      const factors = {};
      for (const key of placeholders) {
        const r = lookup[key];
        factors[key] = r
          ? { score: r.score, value: r.value, direction: r.direction, computed_at: r.computed_at }
          : { score: 0, value: null, direction: "neutral", computed_at: null };
      }
      return res.json({
        generated_at: new Date().toISOString(),
        has_data: hasFactorData,
        factors
      });
    }

    // Grouped response
    const nowMs = Date.now();
    const windowMs = { "1h": 3_600_000, "4h": 14_400_000, "24h": 86_400_000, "7d": 604_800_000 };

    const result = {};
    for (const sym of symbols) {
      result[sym] = { symbol: sym, windows: {} };
      for (const win of windows) {
        const key = `crypto.derivatives.${sym}.liquidation_${win}`;
        const r   = lookup[key];

        // Fallback: compute raw sum directly if no factor snapshot yet
        // row aliased value = raw_value in factor_snapshots
        let rawUsd = r ? r.value : null;
        if (rawUsd === null) {
          const cutoff = new Date(nowMs - windowMs[win]).toISOString();
          const raw = db.prepare(`
            SELECT COALESCE(SUM(qty_usd), 0) AS total FROM liquidation_raw
            WHERE symbol = ? AND liquidated_at >= ?
          `).get(sym, cutoff);
          rawUsd = raw ? raw.total : 0;
        }

        // Side breakdown for the window
        const cutoff = new Date(nowMs - windowMs[win]).toISOString();
        const sides = db.prepare(`
          SELECT side, COALESCE(SUM(qty_usd), 0) AS total
          FROM liquidation_raw WHERE symbol = ? AND liquidated_at >= ?
          GROUP BY side
        `).all(sym, cutoff);

        const sideMap = {};
        for (const s of sides) sideMap[s.side] = s.total;

        result[sym].windows[win] = {
          total_usd:    rawUsd,
          long_liq_usd: sideMap["long_liq"]  ?? 0,
          short_liq_usd: sideMap["short_liq"] ?? 0,
          score:        r ? r.score     : 0,
          direction:    r ? r.direction : "neutral",
          computed_at:  r ? r.computed_at : null
        };
      }
    }

    const latestAt = rows.length > 0
      ? rows.reduce((m, r) => (r.computed_at > m ? r.computed_at : m), rows[0].computed_at)
      : null;

    res.json({
      generated_at:  new Date().toISOString(),
      data_as_of:    latestAt,
      has_data:      hasFactorData,
      aggregator_note: hasFactorData
        ? "factor scores available"
        : "aggregator starting up — raw sums only, scores unavailable until first 5-min cycle",
      symbols: result
    });

  } catch (err) {
    console.error("[v2/liquidations] Error:", err.message);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

// ── GET /api/v2/liquidations/history ─────────────────────────────────────────
// 從 liquidation_agg 讀取時序歷史，支援 resample。
// 資料來源：self_hosted（自建 WS aggregator 寫入的 5m buckets）
//
// Query 參數：
//   ?symbol=SOL         必填
//   ?from=ISO           起始時間（預設 30 天前）
//   ?to=ISO             結束時間（預設現在）
//   ?resample=1h        5m / 15m / 1h / 4h / 1d（預設 1h）
// ─────────────────────────────────────────────────────────────────────────────

const VALID_RESAMPLES = ["5m", "15m", "1h", "4h", "1d"];
const RESAMPLE_SEC    = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

router.get("/liquidations/history", (req, res) => {
  const symbol  = (req.query.symbol || "").toUpperCase();
  const fromRaw = req.query.from || new Date(Date.now() - 30 * 86_400_000).toISOString();
  const toRaw   = req.query.to   || new Date().toISOString();
  const resample = req.query.resample || "1h";

  if (!LIQ_SYMBOLS.includes(symbol)) {
    return res.status(400).json({ error: `symbol 必須是: ${LIQ_SYMBOLS.join(", ")}` });
  }
  if (!VALID_RESAMPLES.includes(resample)) {
    return res.status(400).json({ error: `resample 必須是: ${VALID_RESAMPLES.join(", ")}` });
  }

  const fromTs = Date.parse(fromRaw);
  const toTs   = Date.parse(toRaw);
  if (isNaN(fromTs) || isNaN(toTs) || fromTs >= toTs) {
    return res.status(400).json({ error: "from / to 格式錯誤或順序錯誤" });
  }

  try {
    const sec     = RESAMPLE_SEC[resample];
    const fromIso = new Date(fromTs).toISOString();
    const toIso   = new Date(toTs).toISOString();

    // ── CoinGlass 回灌段（1h + 1d bucket，只有 resample >= 1h 有意義）──────────
    // resample < 1h（5m/15m）：CoinGlass 無法細分，跳過（不做假精度插值）
    // resample >= 1d：優先用 1d bucket；resample >= 1h：用 1h bucket
    const cgBucketSize = sec >= 86400 ? "1d" : "1h";
    const cgRows = sec >= 3600
      ? db.prepare(`
          SELECT
            datetime(strftime('%s', bucket_start) / ? * ?, 'unixepoch') AS ts,
            SUM(total_usd)       AS total_usd,
            SUM(long_liq_usd)    AS long_liq_usd,
            SUM(short_liq_usd)   AS short_liq_usd,
            'coinglass_backfill' AS source,
            MAX(exchange_set)    AS exchange_set
          FROM liquidation_agg
          WHERE symbol = ? AND bucket_size = ? AND source = 'coinglass_backfill'
            AND bucket_start >= ? AND bucket_start < ?
          GROUP BY ts ORDER BY ts ASC
        `).all(sec, sec, symbol, cgBucketSize, fromIso, toIso)
      : [];

    // ── 自建段（bucket_size='5m'，任何 resample 都可聚合）────────────────────
    const shRows = db.prepare(`
      SELECT
        datetime(strftime('%s', bucket_start) / ? * ?, 'unixepoch') AS ts,
        SUM(total_usd)     AS total_usd,
        SUM(long_liq_usd)  AS long_liq_usd,
        SUM(short_liq_usd) AS short_liq_usd,
        'self_hosted'      AS source,
        MAX(exchange_set)  AS exchange_set
      FROM liquidation_agg
      WHERE symbol = ? AND bucket_size = '5m' AND source = 'self_hosted'
        AND bucket_start >= ? AND bucket_start < ?
      GROUP BY ts ORDER BY ts ASC
    `).all(sec, sec, symbol, fromIso, toIso);

    // ── 合併：同一時間戳優先使用自建資料（較高精度）──────────────────────────
    const merged = new Map();
    for (const row of cgRows) merged.set(row.ts, row);
    for (const row of shRows) merged.set(row.ts, row); // self_hosted 覆蓋 CoinGlass

    const history = [...merged.values()]
      .sort((a, b) => (a.ts < b.ts ? -1 : 1))
      .map(r => ({
        timestamp:     r.ts ? r.ts.replace(" ", "T") + "Z" : null,
        total_usd:     r.total_usd     ?? 0,
        long_liq_usd:  r.long_liq_usd  ?? 0,
        short_liq_usd: r.short_liq_usd ?? 0,
        source:        r.source,
        exchange_set:  r.exchange_set
      }));

    res.json({
      symbol,
      from:    fromIso,
      to:      toIso,
      resample,
      count:   history.length,
      resolution_available: {
        coinglass_backfill: sec >= 3600 ? "1h" : null,
        self_hosted:        "5m",
        note: sec < 3600
          ? "resample < 1h：只有自建段有資料（CoinGlass 無法細分至此精度）"
          : "resample >= 1h：CoinGlass 歷史段 + 自建段合併，自建段優先"
      },
      history
    });

  } catch (err) {
    console.error("[v2/liquidations/history] Error:", err.message);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

// ── GET /api/v2/comment/validation/* (§5) ────────────────────────────────────
// 自驗證系統：從 validation_results 表回傳最新驗證結果

function getLatestValidation(type) {
  try {
    const row = db.prepare(`
      SELECT result_json, computed_at, window_days
      FROM validation_results
      WHERE type = ?
      ORDER BY computed_at DESC LIMIT 1
    `).get(type);
    if (!row) return null;
    return { ...JSON.parse(row.result_json), _meta: { computed_at: row.computed_at, window_days: row.window_days } };
  } catch {
    return null;
  }
}

router.get("/comment/validation/summary", (_req, res) => {
  const summary = getLatestValidation("summary");
  if (!summary) {
    return res.status(404).json({
      error: "No validation data yet",
      hint: "Run: node backend/scripts/validation-runner.js"
    });
  }
  res.json(summary);
});

router.get("/comment/validation/regime", (_req, res) => {
  const data = getLatestValidation("regime");
  if (!data) return res.status(404).json({ error: "No validation data yet" });
  res.json(data);
});

router.get("/comment/validation/scores", (_req, res) => {
  const data = getLatestValidation("scores");
  if (!data) return res.status(404).json({ error: "No validation data yet" });
  res.json(data);
});

router.get("/comment/validation/factors", (_req, res) => {
  const data = getLatestValidation("factors");
  if (!data) return res.status(404).json({ error: "No validation data yet" });
  res.json(data);
});

router.get("/comment/validation/gates", (_req, res) => {
  const data = getLatestValidation("gates");
  if (!data) return res.status(404).json({ error: "No validation data yet" });
  res.json(data);
});

/**
 * GET /api/v2/comment/validation/composite
 * §5.5 複合驗證報告：整合所有驗證層 + score bucketing 統計
 *
 * 把 summary/regime/scores/factors/gates/news_direction 合入一個端點，
 * 並附上 asset_comments 的 score bucket 分佈（不需即時抓 BTC 價格）。
 */
router.get("/comment/validation/composite", (_req, res) => {
  const summary      = getLatestValidation("summary");
  if (!summary) {
    return res.status(404).json({
      error: "No validation data yet",
      hint: "Run: node backend/scripts/validation-runner.js"
    });
  }

  const regime       = getLatestValidation("regime");
  const scores       = getLatestValidation("scores");
  const factors      = getLatestValidation("factors");
  const gates        = getLatestValidation("gates");
  const newsDir      = getLatestValidation("news_direction");

  // ── Score bucketing from asset_comments ──────────────────────────────────
  // 按 score_short_term 分桶，統計各桶樣本數與 regime 分佈
  let scoreBuckets = null;
  try {
    const bucketRows = db.prepare(`
      SELECT score_short_term, regime_label, computed_at
      FROM asset_comments
      WHERE asset_class = 'crypto' AND score_short_term IS NOT NULL
      ORDER BY computed_at DESC LIMIT 500
    `).all();

    if (bucketRows.length >= 5) {
      const buckets = {
        "strong_bull (>0.5)":   { range: [0.5, 1.0],  count: 0, regimes: {} },
        "bull (0.1~0.5)":       { range: [0.1, 0.5],  count: 0, regimes: {} },
        "neutral (-0.1~0.1)":   { range: [-0.1, 0.1], count: 0, regimes: {} },
        "bear (-0.5~-0.1)":     { range: [-0.5, -0.1],count: 0, regimes: {} },
        "strong_bear (<-0.5)":  { range: [-1.0, -0.5],count: 0, regimes: {} },
      };

      for (const row of bucketRows) {
        const s = row.score_short_term;
        for (const [label, bucket] of Object.entries(buckets)) {
          if (s >= bucket.range[0] && s < bucket.range[1]) {
            bucket.count++;
            bucket.regimes[row.regime_label] = (bucket.regimes[row.regime_label] || 0) + 1;
            break;
          }
          // strong_bull 包含上界
          if (label === "strong_bull (>0.5)" && s >= 0.5) {
            bucket.count++;
            bucket.regimes[row.regime_label] = (bucket.regimes[row.regime_label] || 0) + 1;
            break;
          }
        }
      }

      scoreBuckets = Object.entries(buckets).map(([label, b]) => ({
        bucket: label,
        count:  b.count,
        pct:    Number((b.count / bucketRows.length * 100).toFixed(1)),
        top_regimes: Object.entries(b.regimes)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([regime, n]) => ({ regime, count: n }))
      }));
    }
  } catch { /* skip bucketing on error */ }

  // ── Signal reliability summary ────────────────────────────────────────────
  const reliability = {
    regime_spearman_rho:   regime?.spearman_rho  ?? null,
    regime_status:         regime?.status        ?? "UNKNOWN",
    scores_status:         scores?.status        ?? "UNKNOWN",
    gates_status:          gates?.status         ?? "UNKNOWN",
    news_direction_status: newsDir?.status       ?? "UNKNOWN",
    factor_top_useful:     (factors?.top_useful  ?? []).slice(0, 3).map(f => f.key ?? f),
    factor_top_useless:    (factors?.top_useless ?? []).slice(0, 3).map(f => f.key ?? f),
  };

  res.json({
    computed_at:      summary._meta?.computed_at  ?? null,
    data_window_days: summary._meta?.window_days  ?? null,
    overall_verdict:  summary.overall_verdict,
    priority_actions: summary.priority_actions    ?? [],
    reliability,
    score_buckets:    scoreBuckets,
    raw: { regime, scores, factors, gates, news_direction: newsDir }
  });
});

// ── GET /api/v2/funding-rates ─────────────────────────────────────────────────
// 資金費率歷史查詢
//
// ?symbol=BTC            (default: BTC)
// ?exchange=Binance      (可省略，省略則回傳所有交易所)
// ?days=7                (預設 7 天，最大 90 天)
// ?limit=200             (預設 200 筆，最大 2000 筆)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/funding-rates", (req, res) => {
  const symbol   = (req.query.symbol   || "BTC").toUpperCase();
  const exchange = req.query.exchange  || null;
  const days     = Math.min(Math.max(Number(req.query.days)  || 7,  1), 90);
  const limit    = Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000);

  const since = new Date(Date.now() - days * 24 * 3_600_000).toISOString();

  try {
    const rows = exchange
      ? db.prepare(`
          SELECT symbol, exchange, funding_rate, funding_interval_h,
                 funding_time, annualized_rate, source
          FROM funding_rate
          WHERE symbol = ? AND exchange = ? AND funding_time >= ?
          ORDER BY funding_time DESC LIMIT ?
        `).all(symbol, exchange, since, limit)
      : db.prepare(`
          SELECT symbol, exchange, funding_rate, funding_interval_h,
                 funding_time, annualized_rate, source
          FROM funding_rate
          WHERE symbol = ? AND funding_time >= ?
          ORDER BY exchange, funding_time DESC LIMIT ?
        `).all(symbol, since, limit);

    // 依交易所分組，方便前端消費
    const byExchange = {};
    for (const row of rows) {
      if (!byExchange[row.exchange]) byExchange[row.exchange] = [];
      byExchange[row.exchange].push({
        time:           row.funding_time,
        rate:           row.funding_rate,
        annualized_pct: row.annualized_rate != null
          ? Number(row.annualized_rate.toFixed(2))
          : null,
        interval_h:     row.funding_interval_h,
        source:         row.source
      });
    }

    res.json({
      generated_at: new Date().toISOString(),
      symbol,
      exchange:     exchange || "all",
      days,
      total_rows:   rows.length,
      by_exchange:  byExchange
    });
  } catch (err) {
    console.error("[v2/funding-rates] Error:", err.message);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

// ── GET /api/v2/funding-rates/latest ─────────────────────────────────────────
// 各交易所當前最新一筆資金費率
//
// ?symbol=BTC   (default: BTC；可用 all 取 7 個主幣種)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/funding-rates/latest", (req, res) => {
  const symParam = (req.query.symbol || "BTC").toUpperCase();
  const symbols  = symParam === "ALL"
    ? ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA"]
    : [symParam];

  try {
    const result = {};

    for (const sym of symbols) {
      const rows = db.prepare(`
        SELECT exchange, funding_rate, funding_interval_h,
               funding_time, annualized_rate
        FROM funding_rate
        WHERE symbol = ?
        GROUP BY exchange
        HAVING funding_time = MAX(funding_time)
        ORDER BY exchange
      `).all(sym);

      result[sym] = rows.map(r => ({
        exchange:       r.exchange,
        rate:           r.funding_rate,
        annualized_pct: r.annualized_rate != null
          ? Number(r.annualized_rate.toFixed(2))
          : null,
        interval_h:     r.funding_interval_h,
        time:           r.funding_time,
        // 方向判斷：正費率偏 bearish（多頭過熱），負費率偏 bullish（反轉）
        sentiment: r.funding_rate > 0.0003 ? "overheated_long"
          : r.funding_rate > 0.0001        ? "positive"
          : r.funding_rate < -0.0001       ? "negative_squeeze"
          : "neutral"
      }));
    }

    res.json({
      generated_at: new Date().toISOString(),
      data: symParam === "ALL" ? result : result[symParam]
    });
  } catch (err) {
    console.error("[v2/funding-rates/latest] Error:", err.message);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

// ── GET /api/v2/funding-rates/stats ──────────────────────────────────────────
// 資金費率統計摘要（z-score / 歷史百分位）
//
// ?symbol=BTC   (default: BTC)
// ?days=90      (統計窗口，預設 90 天)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/funding-rates/stats", (req, res) => {
  const symbol = (req.query.symbol || "BTC").toUpperCase();
  const days   = Math.min(Math.max(Number(req.query.days) || 90, 7), 180);

  const since = new Date(Date.now() - days * 24 * 3_600_000).toISOString();
  const since8h = new Date(Date.now() - 8 * 3_600_000).toISOString();

  try {
    // 取各交易所最新費率
    const latestRows = db.prepare(`
      SELECT exchange, funding_rate, funding_time, funding_interval_h
      FROM funding_rate
      WHERE symbol = ?
      GROUP BY exchange
      HAVING funding_time = MAX(funding_time)
    `).all(symbol);

    // 計算歷史均值序列（每個 8h 時段的多交易所均值）
    const histRows = db.prepare(`
      SELECT
        STRFTIME('%Y-%m-%dT', funding_time) ||
          PRINTF('%02d', CAST(STRFTIME('%H', funding_time) AS INTEGER) / 8 * 8) || ':00:00Z'
          AS period,
        AVG(funding_rate) AS avg_rate
      FROM funding_rate
      WHERE symbol = ? AND funding_time >= ? AND funding_interval_h = 8
      GROUP BY period
      ORDER BY period DESC
    `).all(symbol, since);

    let stats = { mean: null, std: null, current: null, zscore: null, percentile: null };

    if (histRows.length >= 5) {
      const vals   = histRows.map(r => r.avg_rate);
      const mean   = vals.reduce((s, v) => s + v, 0) / vals.length;
      const std    = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);

      // 取 Binance 最新費率作為 current（如無則取均值）
      const binRow  = latestRows.find(r => r.exchange === "Binance");
      const current = binRow?.funding_rate ?? latestRows[0]?.funding_rate ?? null;

      let zscore     = null;
      let percentile = null;

      if (current !== null && std > 1e-9) {
        zscore     = Number(((current - mean) / std).toFixed(2));
        const rank = vals.filter(v => v < current).length;
        percentile = Number(((rank / vals.length) * 100).toFixed(1));
      }

      stats = {
        mean:       Number(mean.toFixed(6)),
        std:        Number(std.toFixed(6)),
        min:        Number(Math.min(...vals).toFixed(6)),
        max:        Number(Math.max(...vals).toFixed(6)),
        current,
        zscore,
        percentile,
        sample_count: histRows.length,
        window_days: days
      };
    }

    res.json({
      generated_at:    new Date().toISOString(),
      symbol,
      latest_by_exchange: latestRows.map(r => ({
        exchange:   r.exchange,
        rate:       r.funding_rate,
        interval_h: r.funding_interval_h,
        time:       r.funding_time
      })),
      history_stats: stats
    });
  } catch (err) {
    console.error("[v2/funding-rates/stats] Error:", err.message);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

export default router;
