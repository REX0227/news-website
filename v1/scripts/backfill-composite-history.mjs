/**
 * backfill-composite-history.mjs
 *
 * 從 factor_snapshots 反推所有歷史 pipeline run 的 composite_score
 * 並寫入 composite_history 資料表。
 *
 * 只補寫「尚未存在」的 run_id，可安全重複執行。
 *
 * 用法：
 *   node v1/scripts/backfill-composite-history.mjs
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeCompositeScore } from "../src/lib/composite.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "..", "..", "backend", "gecko.db");

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

// 確保資料表存在（萬一是全新資料庫）
db.exec(`
  CREATE TABLE IF NOT EXISTS composite_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at TEXT NOT NULL,
    score REAL NOT NULL,
    label TEXT NOT NULL,
    coverage_pct REAL,
    factor_count INTEGER,
    run_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_composite_history_time ON composite_history(recorded_at);
`);

// 取得所有已在 composite_history 的 run_id（避免重複寫入）
const existing = new Set(
  db.prepare("SELECT run_id FROM composite_history WHERE run_id IS NOT NULL").all().map(r => r.run_id)
);

// 取得所有 pipeline_runs，由舊到新
const runs = db.prepare(`
  SELECT run_id, completed_at
  FROM pipeline_runs
  ORDER BY completed_at ASC
`).all();

console.log(`Total pipeline runs: ${runs.length}`);
console.log(`Already in composite_history: ${existing.size}`);
console.log(`To backfill: ${runs.length - existing.size}`);
console.log("---");

const insertStmt = db.prepare(`
  INSERT INTO composite_history (recorded_at, score, label, coverage_pct, factor_count, run_id)
  VALUES (?, ?, ?, ?, ?, ?)
`);

let inserted = 0;
let skipped = 0;
let failed = 0;

for (const run of runs) {
  if (existing.has(run.run_id)) {
    skipped++;
    continue;
  }

  // 取得這次 run 的所有 factor 分數
  const rows = db.prepare(`
    SELECT factor_key, normalized_score
    FROM factor_snapshots
    WHERE run_id = ?
  `).all(run.run_id);

  if (rows.length === 0) {
    failed++;
    continue;
  }

  // 重建 factorMap（符合 computeCompositeScore 的格式）
  const factorMap = {};
  for (const row of rows) {
    factorMap[row.factor_key] = { score: row.normalized_score };
  }

  const composite = computeCompositeScore(factorMap);
  if (!composite) {
    failed++;
    continue;
  }

  insertStmt.run(
    run.completed_at,
    composite.score,
    composite.label,
    Number.isFinite(composite.coverage_pct) ? composite.coverage_pct : null,
    Number.isFinite(composite.factor_count) ? composite.factor_count : null,
    run.run_id
  );
  inserted++;
}

console.log(`Done.`);
console.log(`  Inserted: ${inserted}`);
console.log(`  Skipped (already existed): ${skipped}`);
console.log(`  Failed (no factors): ${failed}`);
console.log(`\nTotal records in composite_history: ${db.prepare("SELECT COUNT(*) as cnt FROM composite_history").get().cnt}`);
console.log(`Date range: ${db.prepare("SELECT MIN(recorded_at) as s, MAX(recorded_at) as e FROM composite_history").get().s} → ${db.prepare("SELECT MAX(recorded_at) as e FROM composite_history").get().e}`);
