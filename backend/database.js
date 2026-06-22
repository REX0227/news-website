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
db.exec("PRAGMA busy_timeout = 5000");

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
      saved_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'jin10'
    );
    CREATE INDEX IF NOT EXISTS idx_jin10_published ON jin10_news(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jin10_source ON jin10_news(source, published_at DESC);

    CREATE TABLE IF NOT EXISTS macro_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id TEXT UNIQUE NOT NULL,
      computed_at TEXT NOT NULL,
      macro_regime_label TEXT NOT NULL,
      macro_regime_confidence REAL NOT NULL,
      global_risk_level TEXT NOT NULL,
      global_risk_score REAL NOT NULL,
      narrative_headline TEXT NOT NULL,
      full_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_macro_comments_computed ON macro_comments(computed_at DESC);

    CREATE TABLE IF NOT EXISTS asset_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_class TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      computed_at TEXT NOT NULL,
      regime_label TEXT NOT NULL,
      regime_confidence REAL NOT NULL,
      score_short_term REAL,
      score_mid_term REAL,
      narrative_headline TEXT NOT NULL,
      full_json TEXT NOT NULL,
      UNIQUE(asset_class, snapshot_id)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_comments_computed ON asset_comments(asset_class, computed_at DESC);

    CREATE TABLE IF NOT EXISTS liquidation_raw (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      qty_usd REAL NOT NULL,
      price REAL NOT NULL,
      liquidated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_liq_raw_symbol_time ON liquidation_raw(symbol, liquidated_at DESC);

    CREATE TABLE IF NOT EXISTS liquidation_agg (
      symbol           TEXT NOT NULL,
      bucket_start     TEXT NOT NULL,
      bucket_size      TEXT NOT NULL DEFAULT '5m',
      total_usd        REAL NOT NULL DEFAULT 0,
      long_liq_usd     REAL NOT NULL DEFAULT 0,
      short_liq_usd    REAL NOT NULL DEFAULT 0,
      exchange_set     TEXT NOT NULL DEFAULT '',
      source           TEXT NOT NULL DEFAULT 'self_hosted',
      source_resolution TEXT NOT NULL DEFAULT '5m',
      computed_at      TEXT NOT NULL,
      PRIMARY KEY (symbol, bucket_start, bucket_size)
    );
    CREATE INDEX IF NOT EXISTS idx_liq_agg_symbol_time ON liquidation_agg(symbol, bucket_start DESC);

    -- ── §6 Memory & Knowledge Graph 表結構 ─────────────────────────────────────

    -- Layer 1: Episode Memory（重大市場事件 + 結果記錄）
    CREATE TABLE IF NOT EXISTS episodes (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      trigger_at   TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_entities TEXT NOT NULL DEFAULT '[]',
      context_json TEXT NOT NULL DEFAULT '{}',
      outcome_json TEXT NOT NULL DEFAULT '{}',
      category     TEXT NOT NULL DEFAULT '',
      severity     TEXT NOT NULL DEFAULT 'medium',
      tags         TEXT NOT NULL DEFAULT '[]',
      status       TEXT NOT NULL DEFAULT 'confirmed',
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_trigger ON episodes(trigger_at DESC);
    CREATE INDEX IF NOT EXISTS idx_episodes_type ON episodes(trigger_type);

    -- Layer 2: Pattern Memory（因子組合 → 結果統計）
    CREATE TABLE IF NOT EXISTS patterns (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      category     TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      signature    TEXT NOT NULL DEFAULT '{}',
      stats        TEXT NOT NULL DEFAULT '{}',
      confidence   REAL NOT NULL DEFAULT 0,
      is_active    INTEGER NOT NULL DEFAULT 1,
      updated_at   TEXT NOT NULL
    );

    -- Layer 4: Regime Transition Memory（每次 regime 切換的記錄 + 事後結果）
    CREATE TABLE IF NOT EXISTS regime_transitions (
      id              TEXT PRIMARY KEY,
      timestamp       TEXT NOT NULL,
      from_regime     TEXT NOT NULL,
      to_regime       TEXT NOT NULL,
      confidence      REAL NOT NULL DEFAULT 0,
      trigger_factors TEXT NOT NULL DEFAULT '[]',
      active_pattern  TEXT,
      regime_hint     TEXT,
      outcome_json    TEXT,
      outcome_filled_at TEXT,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_regime_trans_time ON regime_transitions(timestamp DESC);

    -- Layer 5: Classifier Context Memory（per-entity/category/event_type 準確率）
    CREATE TABLE IF NOT EXISTS classifier_accuracy (
      context_key     TEXT NOT NULL,
      classifier_ver  TEXT NOT NULL,
      direction       TEXT NOT NULL,
      total           INTEGER NOT NULL DEFAULT 0,
      hits            INTEGER NOT NULL DEFAULT 0,
      hit_rate        REAL NOT NULL DEFAULT 0,
      avg_forward_1h  REAL,
      avg_forward_24h REAL,
      updated_at      TEXT NOT NULL,
      PRIMARY KEY (context_key, classifier_ver, direction)
    );
    CREATE INDEX IF NOT EXISTS idx_cls_acc_key ON classifier_accuracy(context_key);

    -- Layer 3: Knowledge Graph（實體關係圖譜）
    CREATE TABLE IF NOT EXISTS kg_nodes (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      name        TEXT NOT NULL,
      aliases     TEXT NOT NULL DEFAULT '[]',
      metadata    TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON kg_nodes(type);
    CREATE INDEX IF NOT EXISTS idx_kg_nodes_name ON kg_nodes(name);

    CREATE TABLE IF NOT EXISTS kg_edges (
      id          TEXT PRIMARY KEY,
      from_id     TEXT NOT NULL,
      to_id       TEXT NOT NULL,
      relation    TEXT NOT NULL,
      weight      REAL NOT NULL DEFAULT 1.0,
      direction   TEXT NOT NULL DEFAULT '→',
      impact      TEXT NOT NULL DEFAULT 'neutral',
      metadata    TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL,
      FOREIGN KEY (from_id) REFERENCES kg_nodes(id),
      FOREIGN KEY (to_id)   REFERENCES kg_nodes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_kg_edges_from ON kg_edges(from_id);
    CREATE INDEX IF NOT EXISTS idx_kg_edges_to   ON kg_edges(to_id);
    CREATE INDEX IF NOT EXISTS idx_kg_edges_rel  ON kg_edges(relation);

    -- ── 資金費率歷史（多交易所，原生解析度）─────────────────────────────────
    CREATE TABLE IF NOT EXISTS funding_rate (
      symbol              TEXT NOT NULL,      -- 標準化代號：BTC / ETH / SOL…
      exchange            TEXT NOT NULL,      -- Binance / Bybit / OKX / Gate / Hyperliquid
      funding_rate        REAL NOT NULL,      -- 原始費率，如 0.0001 = 0.01%
      funding_interval_h  REAL NOT NULL DEFAULT 8, -- 結算週期（小時）：1h 或 8h
      funding_time        TEXT NOT NULL,      -- UTC 結算時間（ISO 8601）
      annualized_rate     REAL,               -- = rate * (8760/interval_h) * 100  (% p.a.)
      source              TEXT NOT NULL DEFAULT 'coinglass',
      computed_at         TEXT NOT NULL,
      PRIMARY KEY (symbol, exchange, funding_time)
    );
    CREATE INDEX IF NOT EXISTS idx_fr_sym_time  ON funding_rate(symbol, funding_time DESC);
    CREATE INDEX IF NOT EXISTS idx_fr_exch_time ON funding_rate(exchange, funding_time DESC);

    -- ── §新版架構：回測 / 事件研究 / 進階統計驗證 ──────────────────────────────

    -- 方法 B：逐筆虛擬倉位 P&L 紀錄
    CREATE TABLE IF NOT EXISTS backtest_results (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id         TEXT NOT NULL,
      period         TEXT NOT NULL,      -- 'dev' | 'test'
      timeframe      TEXT NOT NULL,      -- 'short_term'|'mid_term'|'long_term'
      entry_at       TEXT NOT NULL,
      score          REAL,
      direction      TEXT NOT NULL,      -- 'long'|'short'|'flat'
      entry_price    REAL,
      exit_price     REAL,
      period_min     REAL,               -- 持倉期間最低價（計算 MAE）
      period_max     REAL,               -- 持倉期間最高價
      forward_return REAL,               -- (exit-entry)/entry
      pnl            REAL,               -- 扣除方向後的 P&L
      mae            REAL,               -- Maximum Adverse Excursion
      quality_score  REAL,               -- direction_hit × (1 - MAE_ratio)
      method         TEXT DEFAULT 'score',
      computed_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bt_timeframe ON backtest_results(timeframe, period, entry_at);

    -- 方法 E：事件研究結果
    CREATE TABLE IF NOT EXISTS event_study_results (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      computed_at TEXT NOT NULL,
      event_type  TEXT NOT NULL,         -- e.g. 'regime→risk_on', 'leverage_flush'
      event_at    TEXT NOT NULL,
      entry_price REAL,
      return_1h   REAL,
      return_4h   REAL,
      return_24h  REAL,
      return_7d   REAL
    );
    CREATE INDEX IF NOT EXISTS idx_event_type ON event_study_results(event_type, event_at);

    -- 方法 C/D/F：滾動 IC、分位數分析、Monte Carlo 結果
    CREATE TABLE IF NOT EXISTS enhanced_validation (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      computed_at TEXT NOT NULL,
      window_days INTEGER,
      type        TEXT NOT NULL,         -- 'rolling_ic'|'quantile'|'monte_carlo'
      timeframe   TEXT,
      result_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ev_type_time ON enhanced_validation(type, computed_at DESC);

    -- ── §每日投資建議 ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS daily_advice (
      date               TEXT PRIMARY KEY,   -- YYYY-MM-DD
      headline           TEXT NOT NULL DEFAULT '',   -- 標題行
      what_happened      TEXT NOT NULL DEFAULT '',   -- 發生了什麼
      why_important      TEXT NOT NULL DEFAULT '',   -- 為什麼重要
      my_view            TEXT NOT NULL DEFAULT '',   -- 我的看法
      action_short       TEXT NOT NULL DEFAULT '',   -- 短線操作建議
      action_mid         TEXT NOT NULL DEFAULT '',   -- 中線操作建議
      action_long        TEXT NOT NULL DEFAULT '',   -- 長線操作建議
      watch_indicators   TEXT NOT NULL DEFAULT '',   -- 觀察指標
      overall_direction  TEXT NOT NULL DEFAULT 'neutral',  -- bullish/bearish/neutral/cautious
      regime_label       TEXT NOT NULL DEFAULT '',
      author             TEXT NOT NULL DEFAULT 'manual',
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_daily_advice_date ON daily_advice(date DESC);
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
