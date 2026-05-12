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

const STREAMS = [
  { symbol: "BTC", stream: "btcusdt@depth10@1000ms" },
  { symbol: "ETH", stream: "ethusdt@depth10@1000ms" },
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

// ── WebSocket 連線 ────────────────────────────────────────────────────────────

function connectStream({ symbol, stream }) {
  const url = `wss://stream.binance.com:9443/ws/${stream}`;
  let ws = null;
  let reconnectTimer = null;

  function connect() {
    ws = new WebSocket(url);

    ws.on("open", () => {
      console.log(`[ob-ws] Connected: ${stream}`);
    });

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        // depth10: { bids: [[price, qty], ...], asks: [[price, qty], ...] }
        const bids = data.bids ?? [];
        const asks = data.asks ?? [];

        if (bids.length === 0 || asks.length === 0) return;

        // 取前 10 檔，用量加權
        const bidVol = bids.slice(0, 10).reduce((s, [, q]) => s + parseFloat(q), 0);
        const askVol = asks.slice(0, 10).reduce((s, [, q]) => s + parseFloat(q), 0);
        const total  = bidVol + askVol;
        if (total <= 0) return;

        const imbalance = (bidVol - askVol) / total;
        addReading(symbol, imbalance);
      } catch { /* skip bad frame */ }
    });

    ws.on("error", (err) => {
      console.error(`[ob-ws] Error ${symbol}: ${err.message}`);
    });

    ws.on("close", () => {
      console.log(`[ob-ws] Disconnected ${symbol}, reconnecting in 5s…`);
      reconnectTimer = setTimeout(connect, 5_000);
    });
  }

  connect();

  return {
    close: () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    }
  };
}

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

console.log("[ob-ws] Starting Order Book Imbalance WebSocket (Binance)");

const connections = STREAMS.map(connectStream);

// 每 5 分鐘寫入 DB
setInterval(writeFactors, WRITE_MS);

// 立即寫一次（若有初始資料）
setTimeout(writeFactors, 10_000);

process.on("SIGINT",  () => { connections.forEach(c => c.close()); process.exit(0); });
process.on("SIGTERM", () => { connections.forEach(c => c.close()); process.exit(0); });
