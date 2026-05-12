

/**
 * stream.js — Server-Sent Events (SSE) 推播端點
 *
 * 解決 polling 5 分鐘延遲問題：高衝擊事件（CPI/FOMC/Fed 緊急聲明）
 * 必須即時推播，否則下游交易系統會在這 5 分鐘內被掃倉。
 *
 * 端點（三個 Stage 全部實作）：
 *   GET /api/stream/events
 *     → 高衝擊宏觀事件（importance=high）+ 高相關非中性新聞
 *     → 每天估計 < 20 條
 *
 *   GET /api/stream/news
 *     → ?direction=bullish,bearish&relevance_min=0.5（預設）
 *     → 過濾後的非中性新聞即時推播
 *
 *   GET /api/stream/comment
 *     → ?asset_class=crypto（預設）
 *     → 只在 regime label 改變時推播（每天 < 5 條）
 *
 * SSE 協定：
 *   Content-Type: text/event-stream
 *   每 25 秒發一次 keep-alive comment（防 proxy 斷線）
 *   連線建立立刻發 connected 事件
 *
 * 架構：
 *   - 單一 30 秒全域輪詢（shared broadcaster），所有連線共用一次 DB 查詢
 *   - 不依賴外部 message broker
 *   - 連線斷開後自動從 client list 移除
 */

import { Router } from "express";
import { db } from "../database.js";
import { getLatestFactors } from "../../v1/src/lib/sqlite.js";

const router = Router();

// ── Classifier（從 api.js 複製核心邏輯，避免跨模組依賴）──────────

function scoreRelevance(content = "") {
  let score = 0;
  if (/(bitcoin|btc|ethereum|eth|crypto|blockchain|defi|stablecoin|usdt|usdc|比特幣|以太坊|加密貨幣|穩定幣)/i.test(content)) score += 0.5;
  if (/(etf.*(crypto|bitcoin|btc)|bitcoin.*etf|比特幣.*etf)/i.test(content)) score += 0.3;
  if (/(fed\b|fomc|federal reserve|rate cut|rate hike|美聯儲|聯準會|降息|加息)/i.test(content)) score += 0.25;
  if (/(cpi\b|ppi\b|nfp\b|inflation|core pce|unemployment|非農|通膨|通脹)/i.test(content)) score += 0.2;
  if (/(liquidat|funding rate|open interest|清算|資金費率|爆倉)/i.test(content)) score += 0.2;
  if (/(s&p|spx|nasdaq|ndx|美股|標普)/i.test(content)) score += 0.15;
  if (/(dxy\b|dollar index|美元指數)/i.test(content)) score += 0.15;
  if (/(geopolit|war\b|sanction|地緣|戰爭|制裁)/i.test(content)) score += 0.1;
  if (/(乙二醇|甲醇|橡膠|螺紋鋼|豆粕|焦炭|鐵礦石)/i.test(content)) score -= 0.4;
  if (/(點擊查看|點擊解鎖|訂閱查看|click to unlock)/i.test(content)) score -= 0.3;
  return Math.max(0, Math.min(1, score));
}

function extractEntities(content = "") {
  const checks = [
    [/\bFed\b|Federal Reserve|美聯儲|聯準會/i, "Fed"],
    [/\bFOMC\b/i, "FOMC"], [/Powell|鮑威爾/i, "Powell"],
    [/\bCPI\b/i, "CPI"], [/\bNFP\b|非農就業/i, "NFP"],
    [/\bPPI\b/i, "PPI"], [/\bPCE\b/i, "PCE"], [/\bGDP\b/i, "GDP"],
    [/\bBTC\b|Bitcoin|比特幣/i, "BTC"], [/\bETH\b|Ethereum|以太坊/i, "ETH"],
    [/\bETF\b/i, "ETF"], [/\bSEC\b/i, "SEC"],
    [/Iran|伊朗/i, "Iran"], [/Israel|以色列/i, "Israel"],
    [/Tariff|關稅/i, "Tariff"], [/\bBOJ\b|日銀/i, "BOJ"], [/\bECB\b/i, "ECB"],
  ];
  return checks.filter(([rx]) => rx.test(content)).map(([, name]) => name);
}

function classifyDirection(content = "") {
  const tl = content.toLowerCase();
  const BEAR = ["爆倉","清算","暴跌","崩盤","liquidat","crash","加息","鷹派","hawkish","制裁","ban","crackdown","戰爭","war","衰退","recession","流出","outflow"];
  const BULL = ["降息","寬鬆","鴿派","dovish","rate cut","批准","approved","流入","inflow","暴漲","rally","surge","減半","halving"];
  const b = BEAR.filter(k => tl.includes(k)).length;
  const u = BULL.filter(k => tl.includes(k)).length;
  if (b === 0 && u === 0) return "neutral";
  if (b > u) return "bearish";
  if (u > b) return "bullish";
  return "ambiguous";
}

function classifyEventType(content = "", entities = []) {
  const ent = new Set(entities);
  if (/(liquidat|清算|爆倉).{0,80}(\d|million|billion|億)/i.test(content)) return "liquidation_event";
  if ((ent.has("ETF") || /\betf\b/i.test(content)) && /(flow|inflow|outflow|billion|流入|流出)/i.test(content)) return "etf_flow";
  if ((ent.has("CPI") || ent.has("NFP") || ent.has("PPI") || ent.has("PCE") || ent.has("GDP")) && /(\d|%|公布|發布|release|beat|miss)/i.test(content)) return "data_release";
  if (ent.has("Tariff") || /(tariff|trade war|關稅)/i.test(content)) return "trade_policy";
  if ((ent.has("Fed") || ent.has("FOMC") || ent.has("Powell")) && /(speak|warn|said|speech|表示|聲明|講話|稱|：)/i.test(content)) return "fed_speech";
  if ((ent.has("BOJ") || ent.has("ECB")) && /(rate|decision|利率|決議)/i.test(content)) return "central_bank";
  if ((ent.has("Iran") || ent.has("Israel") || /伊朗|以色列|胡塞/i.test(content)) && /(war|attack|missile|conflict|戰爭|攻擊|導彈)/i.test(content)) return "geopolitical_shock";
  if (ent.has("Powell") || ent.has("FOMC")) return "fed_speech";
  if (ent.has("CPI") || ent.has("NFP") || ent.has("PCE")) return "data_release";
  return "general";
}

// 新聞的「重要性」判斷（用於 /api/stream/events 篩選）
function isHighImpact(enriched) {
  const HIGH_EVENT_TYPES = ["fed_speech", "data_release", "liquidation_event", "geopolitical_shock", "trade_policy"];
  if (HIGH_EVENT_TYPES.includes(enriched.event_type) && enriched.relevance_crypto >= 0.4) return true;
  if (enriched.relevance_crypto >= 0.7 && enriched.direction_en !== "neutral") return true;
  return false;
}

function enrichRow(row) {
  const entities = extractEntities(row.content);
  return {
    id: row.id,
    source: "jin10",
    published_at: row.published_at,
    saved_at: row.saved_at,
    content: row.content,
    relevance_crypto: Number(scoreRelevance(row.content).toFixed(3)),
    direction_en: classifyDirection(row.content),
    event_type: classifyEventType(row.content, entities),
    entities,
    confidence: row.confidence,
    is_important: !!row.is_important,
  };
}

// ── Macro regime 追蹤（comment stream 用）────────────────────────

function safeScore(factors, key) {
  const f = factors[key];
  return (f && f.score != null) ? f.score : null;
}

function toFactorMap(rows) {
  const map = {};
  for (const r of rows) map[r.factor_key] = { score: r.normalized_score, value: r.raw_value };
  return map;
}

function getCurrentCryptoRegime() {
  try {
    const rows = getLatestFactors();
    if (!rows.length) return null;
    const f = toFactorMap(rows);
    const fg    = safeScore(f, "sentiment.fear_greed");
    const bias  = safeScore(f, "signals.crypto_bias");
    const liq   = safeScore(f, "derivatives.liquidation_7d");
    const liqV  = f["derivatives.liquidation_7d"]?.value;
    const stab  = safeScore(f, "liquidity.stablecoin_change_7d");
    const reg   = safeScore(f, "risk.regulatory_bias");

    if (liqV > 500_000_000 && liq !== null && liq < -0.2) return "leverage_flush";

    let s = 0, w = 0;
    if (fg   !== null) { s += fg   * 2.0; w += 2.0; }
    if (bias !== null) { s += bias * 3.0; w += 3.0; }
    if (stab !== null) { s += stab * 1.5; w += 1.5; }
    if (reg  !== null) { s += reg  * 1.0; w += 1.0; }
    const avg = w > 0 ? s / w : 0;

    if (avg > 0.35)  return "risk_on";
    if (avg > 0.12)  return "risk_on_transition";
    if (avg > -0.12) return "neutral_drift";
    if (avg > -0.35) return "risk_off_transition";
    return "risk_off";
  } catch { return null; }
}

// ── 全域 broadcaster ──────────────────────────────────────────────

const POLL_INTERVAL_MS   = 30_000;  // 30 秒輪詢 DB
const KEEPALIVE_MS       = 25_000;  // 25 秒 keep-alive comment
const MAX_CLIENTS        = 200;     // 最多同時連線數（防 DoS）

// 四類 client list
const eventsClients  = new Set();  // /api/stream/events
const newsClients    = new Set();  // /api/stream/news
const commentClients = new Set();  // /api/stream/comment
const signalClients  = new Set();  // /api/stream/signals (Level 3)

let lastNewsCheck    = new Date().toISOString();
let lastCommentCheck = { crypto: null }; // asset_class → last regime label
let lastSignalCheck  = new Date().toISOString();

// ── SSE 工具函式 ──────────────────────────────────────────────────

function sseWrite(res, eventType, data, id = null) {
  try {
    if (id) res.write(`id: ${id}\n`);
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch { /* client disconnected */ }
}

function sendKeepAlive(res) {
  try { res.write(`: keep-alive\n\n`); } catch { /* ignore */ }
}

// ── 30 秒全域輪詢 ─────────────────────────────────────────────────

function startBroadcaster() {
  setInterval(() => {
    const now = new Date().toISOString();

    // ── 1. 查新聞（events + news clients 都需要）─────────────────
    if (eventsClients.size > 0 || newsClients.size > 0) {
      try {
        const rows = db.prepare(`
          SELECT * FROM jin10_news
          WHERE saved_at > ?
          ORDER BY saved_at ASC
          LIMIT 50
        `).all(lastNewsCheck);

        for (const row of rows) {
          const item = enrichRow(row);

          // /api/stream/events：高衝擊過濾
          if (eventsClients.size > 0 && isHighImpact(item) && item.direction_en !== "neutral") {
            const payload = { type: "news", ...item };
            for (const res of eventsClients) {
              sseWrite(res, "news", payload, item.id);
            }
          }

          // /api/stream/news：依各 client 設定的 filter 推播
          if (newsClients.size > 0) {
            for (const client of newsClients) {
              const { res, directions, relevanceMin } = client;
              if (item.relevance_crypto < relevanceMin) continue;
              if (!directions.includes(item.direction_en)) continue;
              sseWrite(res, "news", { type: "news", ...item }, item.id);
            }
          }
        }

        if (rows.length > 0) {
          lastNewsCheck = rows[rows.length - 1].saved_at;
        }
      } catch (e) {
        console.warn("[stream] news poll error:", e.message);
      }
    }

    // ── 2. 宏觀事件（events clients 需要）────────────────────────
    if (eventsClients.size > 0) {
      try {
        const snap = db.prepare(`SELECT value FROM dashboard_data WHERE key = 'crypto_dashboard:latest'`).get();
        if (snap) {
          const data = JSON.parse(snap.value);
          const macroEvents = data.macroEvents || [];
          const upcoming = macroEvents.filter(ev => {
            if (ev.importance !== "high") return false;
            const dt = new Date(ev.datetime || ev.scheduled_at || "");
            const hoursAway = (dt - Date.now()) / 3_600_000;
            return hoursAway >= 0 && hoursAway <= 1; // 1 小時內即將發生
          });
          for (const ev of upcoming) {
            const payload = {
              type: "macro_event",
              id: ev.id,
              title: ev.title,
              country: ev.country,
              scheduled_at: ev.datetime || ev.scheduled_at,
              importance: ev.importance,
              impact_hint: ev.impactHint || null,
              event_type: ev.eventType || null,
            };
            for (const res of eventsClients) {
              sseWrite(res, "macro_event", payload, ev.id);
            }
          }
        }
      } catch (e) {
        console.warn("[stream] macro poll error:", e.message);
      }
    }

    // ── 3. Comment regime 轉換（comment clients 需要）────────────
    if (commentClients.size > 0) {
      for (const client of commentClients) {
        const { res, assetClass } = client;
        if (assetClass !== "crypto") continue;
        try {
          const currentRegime = getCurrentCryptoRegime();
          if (!currentRegime) continue;
          const prev = lastCommentCheck[assetClass];
          if (prev && prev !== currentRegime) {
            sseWrite(res, "regime_change", {
              type: "regime_change",
              asset_class: assetClass,
              from: prev,
              to: currentRegime,
              changed_at: now,
            });
          }
          lastCommentCheck[assetClass] = currentRegime;
        } catch (e) {
          console.warn("[stream] comment poll error:", e.message);
        }
      }
    }
  }, POLL_INTERVAL_MS);
}

// 伺服器啟動時初始化 lastCommentCheck
try {
  lastCommentCheck.crypto = getCurrentCryptoRegime();
} catch { /* ignore startup errors */ }

// ── Signal broadcaster（polling signal_events 表）────────────────

function startSignalBroadcaster() {
  setInterval(() => {
    if (signalClients.size === 0) return;
    try {
      // signal_events 由 signal-detector.js 寫入
      const rows = db.prepare(`
        SELECT * FROM signal_events
        WHERE triggered_at > ?
        ORDER BY triggered_at ASC LIMIT 20
      `).all(lastSignalCheck);

      for (const row of rows) {
        const payload = {
          type:         "signal",
          signal_id:    row.signal_id,
          label:        row.label,
          direction:    row.direction,
          horizon:      row.horizon,
          confidence:   row.confidence,
          triggered_at: row.triggered_at,
          snapshot:     row.factor_snapshot ? JSON.parse(row.factor_snapshot) : null
        };
        for (const client of signalClients) {
          sseWrite(client.res, "signal", payload, String(row.id));
        }
      }

      if (rows.length > 0) {
        lastSignalCheck = rows[rows.length - 1].triggered_at;
        console.log(`[stream/signals] Broadcast ${rows.length} signal(s)`);
      }
    } catch (e) {
      // signal_events table may not exist yet (before signal-detector starts)
      if (!e.message?.includes("no such table")) {
        console.warn("[stream] signal poll error:", e.message);
      }
    }
  }, POLL_INTERVAL_MS);
}

startBroadcaster();
startSignalBroadcaster();

// ── SSE 連線建立 helper ───────────────────────────────────────────

function openSSE(req, res, clientSet, clientEntry) {
  if (clientSet.size >= MAX_CLIENTS) {
    return res.status(503).json({ error: "Too many SSE connections" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // 關閉 Nginx 緩衝
  res.flushHeaders();

  // 立刻發 connected 事件
  sseWrite(res, "connected", {
    type: "connected",
    server_time: new Date().toISOString(),
    poll_interval_seconds: POLL_INTERVAL_MS / 1000,
    message: "SSE connection established. Events will be pushed as they occur."
  });

  const entry = { res, ...clientEntry };
  clientSet.add(entry);

  // Keep-alive timer
  const ka = setInterval(() => sendKeepAlive(res), KEEPALIVE_MS);

  // 清理
  req.on("close", () => {
    clearInterval(ka);
    clientSet.delete(entry);
  });
}

// ════════════════════════════════════════════════════════════════════
// GET /api/stream/events
// 高衝擊事件 stream：importance=high 宏觀事件 + 非中性高相關新聞
// 每天估計 < 20 條推播
// ════════════════════════════════════════════════════════════════════

router.get("/events", (req, res) => {
  openSSE(req, res, eventsClients, {});
});

// ════════════════════════════════════════════════════════════════════
// GET /api/stream/news
// 非中性新聞 stream，可自訂 filter
// ?direction=bullish,bearish（預設）
// ?relevance_min=0.5（預設）
// ════════════════════════════════════════════════════════════════════

router.get("/news", (req, res) => {
  const dirParam = req.query.direction || "bullish,bearish";
  const directions = dirParam.split(",").map(d => d.trim().toLowerCase());
  const relevanceMin = Math.max(0, Math.min(1, Number(req.query.relevance_min ?? 0.5)));

  openSSE(req, res, newsClients, { directions, relevanceMin });
});

// ════════════════════════════════════════════════════════════════════
// GET /api/stream/comment
// Regime 轉換 stream（只在 regime label 改變時推播）
// ?asset_class=crypto（目前只支援 crypto）
// 每天估計 < 5 條推播
// ════════════════════════════════════════════════════════════════════

router.get("/comment", (req, res) => {
  const assetClass = req.query.asset_class || "crypto";
  const supported = ["crypto"];
  if (!supported.includes(assetClass)) {
    return res.status(400).json({ error: `asset_class not yet supported: ${assetClass}`, supported });
  }

  openSSE(req, res, commentClients, { assetClass });
});

// ════════════════════════════════════════════════════════════════════
// GET /api/stream/signals
// Level 3 進出場信號 stream（signal-detector.js 觸發後即時推播）
// 每天估計 < 10 條推播（有冷卻機制）
// ════════════════════════════════════════════════════════════════════

router.get("/signals", (req, res) => {
  openSSE(req, res, signalClients, {});

  // 連線建立時送最近 5 條歷史信號（供 client 初始化）
  try {
    const recent = db.prepare(`
      SELECT * FROM signal_events ORDER BY triggered_at DESC LIMIT 5
    `).all();
    for (const row of recent.reverse()) {
      sseWrite(res, "signal_history", {
        type:         "signal",
        signal_id:    row.signal_id,
        label:        row.label,
        direction:    row.direction,
        horizon:      row.horizon,
        confidence:   row.confidence,
        triggered_at: row.triggered_at
      });
    }
  } catch { /* signal_events may not exist yet */ }
});

// ── GET /api/stream/signals/recent（REST 查詢用）───────────────────

router.get("/signals/recent", (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM signal_events ORDER BY triggered_at DESC LIMIT 20
    `).all();
    res.json({ signals: rows.map(r => ({
      ...r,
      snapshot: r.factor_snapshot ? JSON.parse(r.factor_snapshot) : null
    })) });
  } catch {
    res.json({ signals: [] });
  }
});

// ── GET /api/stream/status（監控用）──────────────────────────────

router.get("/status", (_req, res) => {
  res.json({
    connections: {
      events:  eventsClients.size,
      news:    newsClients.size,
      comment: commentClients.size,
      signals: signalClients.size,
      total:   eventsClients.size + newsClients.size + commentClients.size + signalClients.size
    },
    poll_interval_seconds: POLL_INTERVAL_MS / 1000,
    last_news_check: lastNewsCheck,
    last_signal_check: lastSignalCheck,
    current_regime: { crypto: lastCommentCheck.crypto }
  });
});

export default router;
