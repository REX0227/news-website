/**
 * signal-detector.js — Level 3 Event-Driven 進出場信號偵測器
 *
 * 每 5 分鐘讀取最新 factor_snapshots，評估多條件觸發規則。
 * 當條件組合滿足時寫入 signal_events，並廣播 SSE 事件到 /api/stream/signals。
 *
 * 觸發邏輯：
 *   - 每個 rule 有 N 個 conditions（AND 邏輯）
 *   - conditions 可用 >, <, >=, <=, abs> 運算子
 *   - 觸發後進入 cooldown_min 冷卻（防重複推播）
 *   - 記錄到 signal_events 並暴露給 SSE
 *
 * 執行：
 *   pm2 start backend/scripts/signal-detector.js --name signal-detector
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const DB_PATH = path.join(__dirname, "..", "gecko.db");
const POLL_MS = 5 * 60 * 1_000;  // 5 分鐘

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 10000");

// ── DB 初始化 ─────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS signal_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id    TEXT NOT NULL,
    label        TEXT NOT NULL,
    direction    TEXT NOT NULL,
    horizon      TEXT NOT NULL,
    confidence   REAL NOT NULL,
    triggered_at TEXT NOT NULL,
    factor_snapshot TEXT,
    resolved_at  TEXT,
    outcome_return REAL
  );
  CREATE INDEX IF NOT EXISTS idx_signal_triggered ON signal_events(triggered_at DESC);
  CREATE INDEX IF NOT EXISTS idx_signal_id ON signal_events(signal_id, triggered_at DESC);
`);

// ── 公共 EventEmitter（供 stream.js 訂閱）─────────────────────────────────────

export const signalEmitter = new EventEmitter();
signalEmitter.setMaxListeners(100);

// ── 觸發規則集（初始版本，待 backtest 優化）────────────────────────────────────

const RULES = [
  {
    id: "capitulation_buy",
    label: "恐慌清算底部",
    direction: "bullish",
    horizon: "24h",
    confidence: 0.62,
    cooldown_min: 240,  // 4h 冷卻
    conditions: [
      // 清算驟增（>1.5x 24h 均值）= 恐慌 flush
      { factor: "crypto.derivatives.BTC.liq_spike",               op: ">",  threshold: 0.35 },
      // FR zscore 偏負（空頭過熱或多頭已清洗）
      { factor: "crypto.derivatives.BTC.funding_rate_zscore",      op: "<",  threshold: 0.1 },
      // FR 動量向下（正在去槓桿）
      { factor: "crypto.derivatives.BTC.funding_rate_momentum",    op: "<",  threshold: 0.0 },
    ],
    notes: "清算放大 + FR 低位 + FR 方向向下 → 恐慌底部可能性"
  },
  {
    id: "overheating_exit",
    label: "槓桿過熱警示",
    direction: "bearish",
    horizon: "24h",
    confidence: 0.64,
    cooldown_min: 180,  // 3h 冷卻
    conditions: [
      // FR zscore 極高（多頭過熱）
      { factor: "crypto.derivatives.BTC.funding_rate_zscore",      op: "<",  threshold: -0.4 },
      // FR 動量仍在上升（過熱加劇）
      { factor: "crypto.derivatives.BTC.funding_rate_momentum",    op: "<",  threshold: -0.1 },
      // LSR 多頭佔比高（散戶做多擁擠）
      { factor: "crypto.derivatives.btc.lsr_momentum",             op: "<",  threshold: -0.0 },
    ],
    notes: "FR 過熱 + 繼續上升 + 多頭擁擠 → 潛在槓桿清洗"
  },
  {
    id: "squeeze_setup",
    label: "空頭軋倉設置",
    direction: "bullish",
    horizon: "12h",
    confidence: 0.60,
    cooldown_min: 120,
    conditions: [
      // 清算熱力圖上方空頭集中
      { factor: "crypto.derivatives.BTC.liq_heatmap_pressure",     op: ">",  threshold: 0.3 },
      // 買盤壓力偏多
      { factor: "crypto.orderbook.BTC.bid_ask_imbalance",          op: ">",  threshold: 0.2 },
      // CVD 動量正（買方主導）
      { factor: "crypto.derivatives.btc.cvd_momentum",             op: ">",  threshold: 0.1 },
    ],
    notes: "上方空頭集中 + 買盤主導 + CVD 正向 → 軋空潛力"
  },
  {
    id: "long_flush_warning",
    label: "多頭清洗風險",
    direction: "bearish",
    horizon: "12h",
    confidence: 0.60,
    cooldown_min: 120,
    conditions: [
      // 熱力圖下方多頭集中
      { factor: "crypto.derivatives.BTC.liq_heatmap_pressure",     op: "<",  threshold: -0.3 },
      // 賣盤壓力偏空
      { factor: "crypto.orderbook.BTC.bid_ask_imbalance",          op: "<",  threshold: -0.2 },
      // OI 快速收縮（去槓桿）
      { factor: "crypto.derivatives.btc.oi_momentum",              op: "<",  threshold: -0.15 },
    ],
    notes: "下方多頭集中 + 賣盤主導 + OI 收縮 → 多頭清洗風險"
  },
  {
    id: "momentum_breakout",
    label: "動量突破做多",
    direction: "bullish",
    horizon: "6h",
    confidence: 0.58,
    cooldown_min: 90,
    conditions: [
      // 買賣盤買方顯著主導
      { factor: "crypto.orderbook.BTC.bid_ask_imbalance",          op: ">",  threshold: 0.35 },
      // CVD 強勁
      { factor: "crypto.derivatives.btc.cvd_momentum",             op: ">",  threshold: 0.25 },
      // OI 擴張（有新多頭進場）
      { factor: "crypto.derivatives.btc.oi_momentum",              op: ">",  threshold: 0.15 },
    ],
    notes: "買盤強 + CVD 正 + OI 擴 → 短期動量突破"
  }
];

// ── Factor 讀取 ───────────────────────────────────────────────────────────────

function getLatestFactor(factorKey) {
  const row = db.prepare(`
    SELECT normalized_score, computed_at FROM factor_snapshots
    WHERE factor_key = ?
    ORDER BY computed_at DESC LIMIT 1
  `).get(factorKey);
  return row ?? null;
}

function checkCondition(score, op, threshold) {
  if (score === null || score === undefined) return false;
  switch (op) {
    case ">":   return score > threshold;
    case "<":   return score < threshold;
    case ">=":  return score >= threshold;
    case "<=":  return score <= threshold;
    case "abs>": return Math.abs(score) > threshold;
    default:    return false;
  }
}

// ── 冷卻狀態 ──────────────────────────────────────────────────────────────────

const lastFired = {};  // signalId → timestamp ms

function isInCooldown(rule) {
  const last = lastFired[rule.id];
  if (!last) return false;
  return Date.now() - last < rule.cooldown_min * 60_000;
}

// ── 插入 signal_events ────────────────────────────────────────────────────────

const insertSignal = db.prepare(`
  INSERT INTO signal_events
    (signal_id, label, direction, horizon, confidence, triggered_at, factor_snapshot)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// ── 主偵測迴圈 ────────────────────────────────────────────────────────────────

function runDetection() {
  const now = new Date();
  const triggeredSignals = [];

  for (const rule of RULES) {
    if (isInCooldown(rule)) continue;

    // 讀取每個 condition 的最新 factor 值
    const snapshot = {};
    let allPass = true;

    for (const cond of rule.conditions) {
      const row = getLatestFactor(cond.factor);
      const score = row?.normalized_score ?? null;
      snapshot[cond.factor] = { score, computed_at: row?.computed_at };

      if (!checkCondition(score, cond.op, cond.threshold)) {
        allPass = false;
        break;
      }
    }

    if (!allPass) continue;

    // 所有條件滿足 → 觸發
    lastFired[rule.id] = Date.now();
    const triggeredAt = now.toISOString().replace("T", " ").slice(0, 19);

    try {
      insertSignal.run(
        rule.id, rule.label, rule.direction, rule.horizon,
        rule.confidence, triggeredAt, JSON.stringify(snapshot)
      );
    } catch (err) {
      console.error(`[signal-detector] DB write error: ${err.message}`);
    }

    const event = {
      signal_id:    rule.id,
      label:        rule.label,
      direction:    rule.direction,
      horizon:      rule.horizon,
      confidence:   rule.confidence,
      triggered_at: triggeredAt,
      notes:        rule.notes,
      snapshot
    };

    triggeredSignals.push(event);
    signalEmitter.emit("signal", event);
    console.log(`[signal-detector] TRIGGERED: ${rule.id} (${rule.label}) @ ${triggeredAt}`);
  }

  if (triggeredSignals.length === 0 && process.env.DEBUG_SIGNALS) {
    console.log(`[signal-detector] ${now.toISOString().slice(0, 16)} — no signals`);
  }

  return triggeredSignals;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

console.log("[signal-detector] Starting Level 3 Event-Driven Signal Detector");
console.log(`[signal-detector] Rules: ${RULES.map(r => r.id).join(", ")}`);
console.log(`[signal-detector] Poll: every ${POLL_MS / 60_000} min`);

runDetection();
setInterval(runDetection, POLL_MS);

process.on("SIGINT",  () => { console.log("[signal-detector] exit"); process.exit(0); });
process.on("SIGTERM", () => { console.log("[signal-detector] exit"); process.exit(0); });
