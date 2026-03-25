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
import { getLatestFactors, getLatestGates, getFactorHistory, getPipelineRuns } from "../../v1/src/lib/sqlite.js";

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

// ── GET /api/v2/snapshot ─────────────────────────────────────────
// 一次取回所有 factors + gates + staleness（交易系統主要入口）
router.get("/snapshot", (_req, res) => {
  const factorRows = getLatestFactors();
  const gateRows = getLatestGates();

  if (factorRows.length === 0) {
    return res.status(404).json({
      error: "No factor data available. Run the update script first.",
      hint: "node v1/scripts/update-data.mjs"
    });
  }

  const factors = rowsToFactorMap(factorRows);
  const gates = rowsToGateMap(gateRows);
  const staleness = getStalenessByDomain(factors);

  const computed_at = factorRows[0]?.computed_at || null;

  res.json({
    computed_at,
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

export default router;
