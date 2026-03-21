/**
 * sqlite.js — Direct SQLite writer for the v1 data pipeline.
 *
 * Uses Node.js built-in node:sqlite (available in Node.js v22.5+) to write
 * directly to the backend database (backend/gecko.db).
 * Called from update-data.mjs after the Upstash write so that a local copy
 * of each payload is always persisted.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the shared SQLite database (relative: v1/src/lib/ → backend/)
const DB_PATH = path.resolve(__dirname, "..", "..", "..", "backend", "gecko.db");

let _db = null;

function getDb() {
  if (_db) return _db;

  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode = WAL");

  // Ensure the tables exist (idempotent)
  _db.exec(`
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
  `);

  return _db;
}

/**
 * Saves the dashboard payload to SQLite.
 * @param {object} data - The full payload object (same as written to Upstash)
 * @returns {{ ok: boolean, savedAt: string }}
 */
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

    console.log(`[sqlite] Saved dashboard snapshot to ${DB_PATH} at ${updatedAt}`);
    return { ok: true, savedAt: updatedAt };
  } catch (err) {
    console.error("[sqlite] Failed to save dashboard snapshot:", err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Logs an update run to the update_log table.
 * @param {string} status - "success" or "error"
 * @param {number} collectorsRan - How many collectors completed
 * @param {string|null} errorMessage - Error detail if status is "error"
 */
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
