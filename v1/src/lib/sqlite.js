/**
 * sqlite.js — V1 pipeline 的 SQLite 寫入層
 *
 * 資料表：
 *   dashboard_data    — 最新儀表板快照（給 V1 前端，向後相容）
 *   update_log        — pipeline run 稽核紀錄
 *   factor_snapshots  — 每次 run 每個 factor 存一筆（時序，給交易系統回測）
 *   gate_conditions   — 每次 run 每個 gate 存一筆（時序）
 *   pipeline_runs     — 每次 run 的執行摘要
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.resolve(__dirname, "..", "..", "..", "backend", "gecko.db");

let _db = null;

function getDb() {
  if (_db) return _db;

  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");

  _db.exec(`
    -- 原有表格（向後相容）
    CREATE TABLE IF NOT EXISTS dashboard_data (
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS update_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      collectors_ran INTEGER DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL
    );

    -- 新增：pipeline run 執行摘要
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      run_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      collectors_ok TEXT,
      collectors_failed TEXT,
      factor_count INTEGER DEFAULT 0,
      gate_count INTEGER DEFAULT 0
    );

    -- 新增：factor 時序（每次 run 每個 factor 存一筆）
    CREATE TABLE IF NOT EXISTS factor_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      factor_key TEXT NOT NULL,
      factor_category TEXT NOT NULL,
      raw_value REAL,
      normalized_score REAL,
      direction TEXT,
      confidence REAL,
      source_tier INTEGER,
      extra_json TEXT,
      computed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_factor_key_time ON factor_snapshots(factor_key, computed_at);

    -- 新增：gate 時序（每次 run 每個 gate 存一筆）
    CREATE TABLE IF NOT EXISTS gate_conditions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      gate_key TEXT NOT NULL,
      gate_value TEXT NOT NULL,
      gate_numeric REAL,
      contributing_factors TEXT,
      reason TEXT,
      confidence REAL,
      computed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gate_key_time ON gate_conditions(gate_key, computed_at);
  `);

  return _db;
}

// ── 原有函數（向後相容）─────────────────────────────────────────────

export async function saveToSQLite(data) {
  try {
    const db = getDb();
    const value = JSON.stringify(data);
    const updatedAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO dashboard_data (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run("crypto_dashboard:latest", value, updatedAt);

    console.log(`[sqlite] Saved dashboard snapshot at ${updatedAt}`);
    return { ok: true, savedAt: updatedAt };
  } catch (err) {
    console.error("[sqlite] Failed to save dashboard snapshot:", err.message);
    return { ok: false, error: err.message };
  }
}

export async function logUpdateToSQLite(status, collectorsRan = 0, errorMessage = null) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO update_log (status, collectors_ran, error_message, created_at)
      VALUES (?, ?, ?, ?)
    `).run(status, collectorsRan, errorMessage ?? null, new Date().toISOString());

    console.log(`[sqlite] Logged update: status=${status}, collectors=${collectorsRan}`);
  } catch (err) {
    console.error("[sqlite] Failed to log update:", err.message);
  }
}

// ── 新增：Factor / Gate 時序儲存 ────────────────────────────────────

/**
 * 從 factorKey 推斷 category（macro / sentiment / liquidity / flows / derivatives / signals / risk / event）
 */
function inferCategory(factorKey) {
  const prefix = factorKey.split(".")[0];
  const map = {
    macro: "macro",
    sentiment: "sentiment",
    liquidity: "liquidity",
    flows: "flows",
    derivatives: "derivatives",
    signals: "signals",
    risk: "risk",
    event: "event"
  };
  return map[prefix] || "other";
}

/**
 * 儲存一次 pipeline run 的 factor vector 和 gate conditions
 *
 * @param {object} factorVector - buildFactorVector() 的輸出
 * @param {object} gateConditions - computeGates() 的輸出
 * @param {object} opts - { startedAt?: string, collectorsOk?: string[], collectorsFailed?: string[] }
 * @returns {{ ok: boolean, runId: string }}
 */
export async function saveFactorsAndGates(factorVector, gateConditions, opts = {}) {
  const runId = randomUUID();
  const completedAt = new Date().toISOString();
  const startedAt = opts.startedAt || completedAt;

  try {
    const db = getDb();

    // 寫入 pipeline_runs
    db.prepare(`
      INSERT INTO pipeline_runs (run_id, started_at, completed_at, collectors_ok, collectors_failed, factor_count, gate_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId, startedAt, completedAt,
      JSON.stringify(opts.collectorsOk || []),
      JSON.stringify(opts.collectorsFailed || []),
      Object.keys(factorVector).length,
      Object.keys(gateConditions).length
    );

    // 寫入 factor_snapshots（每個 factor 一筆）
    const factorStmt = db.prepare(`
      INSERT INTO factor_snapshots
        (run_id, factor_key, factor_category, raw_value, normalized_score, direction, confidence, source_tier, extra_json, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [key, f] of Object.entries(factorVector)) {
      const extra = {};
      if (f.unit !== undefined) extra.unit = f.unit;
      if (f.label !== undefined) extra.label = f.label;
      if (f.change_7d_pct !== undefined) extra.change_7d_pct = f.change_7d_pct;
      if (f.source_detail !== undefined) extra.source_detail = f.source_detail;
      if (f.bull_count !== undefined) extra.bull_count = f.bull_count;
      if (f.bear_count !== undefined) extra.bear_count = f.bear_count;
      if (f.events !== undefined) extra.events = f.events;

      factorStmt.run(
        runId, key, inferCategory(key),
        typeof f.value === "boolean" ? (f.value ? 1 : 0) : (Number.isFinite(f.value) ? f.value : null),
        Number.isFinite(f.score) ? f.score : null,
        f.direction || null,
        Number.isFinite(f.confidence) ? f.confidence : null,
        f.source_tier ?? null,
        Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
        f.computed_at || completedAt
      );
    }

    // 寫入 gate_conditions（每個 gate 一筆）
    const gateStmt = db.prepare(`
      INSERT INTO gate_conditions
        (run_id, gate_key, gate_value, gate_numeric, contributing_factors, reason, confidence, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [key, g] of Object.entries(gateConditions)) {
      gateStmt.run(
        runId, key,
        String(g.value),
        Number.isFinite(g.numeric) ? g.numeric : null,
        Array.isArray(g.contributing_factors) ? JSON.stringify(g.contributing_factors) : null,
        g.reason || null,
        Number.isFinite(g.confidence) ? g.confidence : null,
        g.computed_at || completedAt
      );
    }

    console.log(`[sqlite] Saved ${Object.keys(factorVector).length} factors, ${Object.keys(gateConditions).length} gates (run_id: ${runId})`);
    return { ok: true, runId };
  } catch (err) {
    console.error("[sqlite] Failed to save factors/gates:", err.message);
    return { ok: false, runId, error: err.message };
  }
}

/**
 * 取得某個 factor 的時序（供 /api/v2/factors/history 使用）
 *
 * @param {string} factorKey
 * @param {number} limitDays - 往前幾天
 * @returns {Array<{ computed_at, normalized_score, raw_value, direction, confidence }>}
 */
export function getFactorHistory(factorKey, limitDays = 30) {
  try {
    const db = getDb();
    const since = new Date(Date.now() - limitDays * 24 * 60 * 60 * 1000).toISOString();
    return db.prepare(`
      SELECT computed_at, normalized_score, raw_value, direction, confidence, extra_json
      FROM factor_snapshots
      WHERE factor_key = ? AND computed_at >= ?
      ORDER BY computed_at ASC
    `).all(factorKey, since);
  } catch (err) {
    console.error("[sqlite] getFactorHistory error:", err.message);
    return [];
  }
}

/**
 * 取得最新一次 pipeline run 的所有 factors
 */
export function getLatestFactors() {
  try {
    const db = getDb();
    const latestRun = db.prepare(`
      SELECT run_id FROM pipeline_runs ORDER BY completed_at DESC LIMIT 1
    `).get();
    if (!latestRun) return [];

    return db.prepare(`
      SELECT factor_key, factor_category, raw_value, normalized_score, direction, confidence, source_tier, extra_json, computed_at
      FROM factor_snapshots
      WHERE run_id = ?
      ORDER BY factor_category, factor_key
    `).all(latestRun.run_id);
  } catch (err) {
    console.error("[sqlite] getLatestFactors error:", err.message);
    return [];
  }
}

/**
 * 取得最新一次 pipeline run 的所有 gates
 */
export function getLatestGates() {
  try {
    const db = getDb();
    const latestRun = db.prepare(`
      SELECT run_id FROM pipeline_runs ORDER BY completed_at DESC LIMIT 1
    `).get();
    if (!latestRun) return [];

    return db.prepare(`
      SELECT gate_key, gate_value, gate_numeric, contributing_factors, reason, confidence, computed_at
      FROM gate_conditions
      WHERE run_id = ?
      ORDER BY gate_key
    `).all(latestRun.run_id);
  } catch (err) {
    console.error("[sqlite] getLatestGates error:", err.message);
    return [];
  }
}

/**
 * 取得最近 N 次 pipeline runs 的摘要
 */
export function getPipelineRuns(limit = 10) {
  try {
    const db = getDb();
    return db.prepare(`
      SELECT run_id, started_at, completed_at, factor_count, gate_count, collectors_ok, collectors_failed
      FROM pipeline_runs
      ORDER BY completed_at DESC
      LIMIT ?
    `).all(limit);
  } catch (err) {
    console.error("[sqlite] getPipelineRuns error:", err.message);
    return [];
  }
}
