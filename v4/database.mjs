/**
 * database.mjs — SQLite setup using Node.js built-in node:sqlite
 * DB file: ../backend/gecko_v4.db (relative to v4/)
 */

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../backend/gecko_v4.db');

// Ensure backend directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db = null;

function getDb() {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH);
  }
  return _db;
}

export function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS source_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      category TEXT NOT NULL,
      source_name TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      status TEXT NOT NULL,
      data_json TEXT,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_source_id ON source_snapshots(source_id);

    CREATE TABLE IF NOT EXISTS collection_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at TEXT NOT NULL,
      total INTEGER,
      success INTEGER,
      failed INTEGER,
      skipped INTEGER
    );
  `);

  console.log(`[db] Initialized SQLite at ${DB_PATH}`);
}

/**
 * Save a snapshot for a source. Inserts a new row, then prunes rows
 * older than 48 hours (keeping at least the last 3 per source).
 */
export function saveSnapshot(sourceId, category, name, status, data, error) {
  const db = getDb();
  const fetchedAt = new Date().toISOString();
  const dataJson = data != null ? JSON.stringify(data) : null;
  const errorMsg = error != null ? String(error) : null;

  const insert = db.prepare(`
    INSERT INTO source_snapshots (source_id, category, source_name, fetched_at, status, data_json, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(sourceId, category, name, fetchedAt, status, dataJson, errorMsg);

  // Prune: delete rows older than 48h, but keep at least the 3 most recent per source
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const prune = db.prepare(`
    DELETE FROM source_snapshots
    WHERE source_id = ?
      AND fetched_at < ?
      AND id NOT IN (
        SELECT id FROM source_snapshots
        WHERE source_id = ?
        ORDER BY fetched_at DESC
        LIMIT 3
      )
  `);
  prune.run(sourceId, cutoff, sourceId);
}

/**
 * Get the latest snapshot for each source_id.
 */
export function getLatestSnapshots() {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT s.*
    FROM source_snapshots s
    INNER JOIN (
      SELECT source_id, MAX(fetched_at) AS max_fetched
      FROM source_snapshots
      GROUP BY source_id
    ) latest ON s.source_id = latest.source_id AND s.fetched_at = latest.max_fetched
    ORDER BY s.category, s.source_name
  `);
  return stmt.all();
}

/**
 * Log a collection run summary.
 */
export function logCollection(total, success, failed, skipped) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO collection_log (ran_at, total, success, failed, skipped)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(new Date().toISOString(), total, success, failed, skipped);
}
