/**
 * ob-ws.js — Level 2 Order Book Imbalance（Binance WebSocket）
 *
 * 即時訂閱 BTC/ETH order book depth，計算買賣盤不平衡指數，
 * 每 5 分鐘將 30 分鐘滾動平均寫入 factor_snapshots。
 *
 * Factor keys：
 *   crypto.orderbook.BTC.bid_ask_imbalance  — 買方 vs 賣方壓力（-1 偏空 / +1 偏多）
 *   crypto.orderbook.ETH.bid_ask_imbalance
 *
 * 計算：
 *   imbalance = (bid_volume - ask_volume) / (bid_volume + ask_volume)
 *   取前 10 檔掛單量加權
 *   每 5 分鐘寫入 30 分鐘滾動均值（過濾高頻噪音）
 *
 * 執行：
 *   node backend/scripts/ob-ws.js
 *   pm2 start backend/scripts/ob-ws.js --name ob-ws
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const DB_PATH  = path.join(__dirname, "..", "gecko.db");
const WRITE_MS = 5 * 60 * 1_000;   // 每 5 分鐘寫入
const WINDOW_MS = 30 * 60 * 1_000; // 30 分鐘滾動視窗

// Bybit WebSocket（Binance 在 GCP US IP 封鎖 HTTP 451）
const BYBIT_WS_URL = "wss://stream.bybit.com/v5/public/linear";
const STREAMS = [
  { symbol: "BTC", topic: "orderbook.10.BTCUSDT" },
  { symbol: "ETH", topic: "orderbook.10.ETHUSDT" },
];

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 10000");

const insertFactor = db.prepare(`
  INSERT OR REPLACE INTO factor_snapshots
    (run_id, factor_key, factor_category, raw_value, normalized_score,
     direction, confidence, source_tier, extra_json, computed_at)
  VALUES (?, ?, 'derivatives', ?, ?, ?, 0.82, 1, ?, ?)
`);

function clamp(v, min = -1, max = 1) { return Math.max(min, Math.min(max, v)); }

// ── 滾動視窗狀態 ──────────────────────────────────────────────────────────────

const state = {};
for (const { symbol } of STREAMS) {
  state[symbol] = { readings: [] }; // { ts, imbalance }
}

function addReading(symbol, imbalance) {
  const now = Date.now();
  const s = state[symbol];
  s.readings.push({ ts: now, imbalance });
  // 清理超過視窗的資料
  s.readings = s.readings.filter(r => now - r.ts <= WINDOW_MS);
}

function getWindowAvg(symbol) {
  const readings = state[symbol]?.readings ?? [];
  if (readings.length === 0) return null;
  const sum = readings.reduce((acc, r) => acc + r.imbalance, 0);
  return sum / readings.length;
}

// ── WebSocket 連線（Bybit）───────────────────────────────────────────────────

let sharedWs = null;
let reconnectTimer = null;
const subscribedTopics = new Set();

function connectBybit() {
  sharedWs = new WebSocket(BYBIT_WS_URL);

  sharedWs.on("open", () => {
    console.log("[ob-ws] Connected to Bybit WebSocket");
    // 訂閱所有 topics
    const topics = STREAMS.map(s => s.topic);
    sharedWs.send(JSON.stringify({ op: "subscribe", args: topics }));
    topics.forEach(t => subscribedTopics.add(t));
  });

  sharedWs.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (!data.topic || !data.data) return;

      // Bybit orderbook: { topic: "orderbook.10.BTCUSDT", data: { b: [[price,qty],...], a: [[price,qty],...] } }
      const stream = STREAMS.find(s => data.topic.includes(s.symbol + "USDT"));
      if (!stream) return;

      const bids = data.data.b ?? [];
      const asks = data.data.a ?? [];
      if (bids.length === 0 || asks.length === 0) return;

      const bidVol = bids.slice(0, 10).reduce((s, [, q]) => s + parseFloat(q), 0);
      const askVol = asks.slice(0, 10).reduce((s, [, q]) => s + parseFloat(q), 0);
      const total  = bidVol + askVol;
      if (total <= 0) return;

      addReading(stream.symbol, (bidVol - askVol) / total);
    } catch { /* skip bad frame */ }
  });

  sharedWs.on("error", (err) => {
    console.error(`[ob-ws] WebSocket error: ${err.message}`);
  });

  sharedWs.on("close", () => {
    console.log("[ob-ws] Disconnected, reconnecting in 5s…");
    subscribedTopics.clear();
    reconnectTimer = setTimeout(connectBybit, 5_000);
  });

  // Bybit ping every 20s
  const pingTimer = setInterval(() => {
    if (sharedWs?.readyState === 1) {
      sharedWs.send(JSON.stringify({ op: "ping" }));
    }
  }, 20_000);

  sharedWs.on("close", () => clearInterval(pingTimer));
}

function connectStream(_ignored) { /* no-op, use connectBybit instead */ }


// ── 定期寫入 DB ───────────────────────────────────────────────────────────────

function writeFactors() {
  const now = new Date();
  const computedAt = now.toISOString().replace("T", " ").slice(0, 19);
  const runId = `ob_ws_${now.toISOString().slice(0, 16).replace(/[T:]/g, "_")}`;
  let written = 0;

  for (const { symbol } of STREAMS) {
    const avg = getWindowAvg(symbol);
    if (avg === null) continue;

    // 正值 = 買方更多 = bullish；負值 = 賣方更多 = bearish
    const score = clamp(avg / 0.15);  // ±15% imbalance = ±1.0
    const dir   = score > 0.2 ? "bullish" : score < -0.2 ? "bearish" : "neutral";
    const n     = state[symbol].readings.length;

    insertFactor.run(
      runId,
      `crypto.orderbook.${symbol}.bid_ask_imbalance`,
      Number(avg.toFixed(6)), score, dir,
      JSON.stringify({ window_min: 30, n_readings: n }),
      computedAt
    );
    written++;
  }

  if (written > 0) {
    console.log(`[ob-ws] ${computedAt} — wrote ${written} orderbook factors`);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

console.log("[ob-ws] Starting Order Book Imbalance WebSocket (Bybit)");
console.log(`[ob-ws] Topics: ${STREAMS.map(s => s.topic).join(", ")}`);

connectBybit();

// 每 5 分鐘寫入 DB
setInterval(writeFactors, WRITE_MS);

// 立即寫一次（若有初始資料）
setTimeout(writeFactors, 10_000);

process.on("SIGINT",  () => { if (reconnectTimer) clearTimeout(reconnectTimer); sharedWs?.close(); process.exit(0); });
process.on("SIGTERM", () => { if (reconnectTimer) clearTimeout(reconnectTimer); sharedWs?.close(); process.exit(0); });
