import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, "gecko.db");

export const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

export function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_data (
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS macro_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      date TEXT,
      country TEXT,
      importance TEXT,
      category TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crypto_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_type TEXT,
      value TEXT,
      change_7d TEXT,
      source TEXT,
      raw_json TEXT,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS update_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      collectors_ran INTEGER DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jin10_news (
      id TEXT PRIMARY KEY,
      published_at TEXT NOT NULL,
      content TEXT NOT NULL,
      link TEXT NOT NULL,
      direction TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      commentary TEXT NOT NULL,
      is_important INTEGER DEFAULT 1,
      saved_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jin10_published ON jin10_news(published_at DESC);
  `);

  console.log(`[database] Initialized SQLite at ${DB_PATH}`);
}

/**
 * Saves a JSON snapshot to the dashboard_data table.
 * @param {string} key - The snapshot key (e.g. "crypto_dashboard:latest")
 * @param {object} data - The data object to store as JSON
 */
export function saveSnapshot(key, data) {
  const value = JSON.stringify(data);
  const updatedAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO dashboard_data (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value, updatedAt);
}

/**
 * Retrieves a JSON snapshot from the dashboard_data table.
 * @param {string} key - The snapshot key
 * @returns {object|null} The parsed data or null if not found
 */
export function getSnapshot(key) {
  const row = db.prepare("SELECT value, updated_at FROM dashboard_data WHERE key = ?").get(key);

  if (!row) return null;

  try {
    return {
      data: JSON.parse(row.value),
      updatedAt: row.updated_at
    };
  } catch {
    return null;
  }
}

/**
 * Logs an update run to the update_log table.
 * @param {string} status - "success" or "error"
 * @param {number} collectorsRan - Number of collectors that ran
 * @param {string|null} errorMessage - Error message if status is "error"
 */
export function logUpdate(status, collectorsRan = 0, errorMessage = null) {
  db.prepare(`
    INSERT INTO update_log (status, collectors_ran, error_message, created_at)
    VALUES (?, ?, ?, ?)
  `).run(status, collectorsRan, errorMessage ?? null, new Date().toISOString());
}
