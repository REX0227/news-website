import { Router } from "express";
import { db, saveSnapshot, getSnapshot, logUpdate } from "../database.js";

// ── 金十分析（inline，避免跨版本 import）────────────────────────────
const JIN10_API = "https://flash-api.jin10.com/get_flash_list";
const JIN10_HEADERS = { "x-app-id": "bVBF4FyRTn5NJF5n", "x-version": "1.0.0", "accept": "application/json" };
const CRYPTO_RELEVANT = /bitcoin|btc|eth|ethereum|crypto|blockchain|defi|stablecoin|etf|fed\b|fomc|rate cut|rate hike|inflation|tariff|dollar\b|dxy|risk asset|liquidity|比特幣|加密貨幣|以太坊|美聯儲|聯準會|降息|加息|關稅|風險資產|流動性|穩定幣|比特|以太|美联储|联储|关税|流动性|稳定币|清算|风险资产|通胀|通膨|利率|联邦|鲍威尔|Powell|黄金|oil|原油|石油|霍尔木兹|制裁|sanctions|bonds|treasury|殖利率|公債|期货|期貨|trump|川普|特朗普|middle east|中東|中东|israel|以色列|iran|伊朗|gaza|加沙|lebanon|黎巴嫩|hamas|胡塞|houthi|strait of hormuz|战争|戰爭|war|conflict|衝突|冲突|missile|导弹|導彈|airstrike|空袭|空襲|nuclear|核武|geopolit|地緣|地缘|oil supply|供油|能源危機|能源危机/i;

function jin10Direction(content = "") {
  const t = content.toLowerCase();
  const bull = /(rate cut|easing|dovish|approved|approval|inflow|institutional buy|pivot|降息|寬鬆|批准|流入|買入|利好|支持|注資)/i.test(t);
  const bear = /(rate hike|hawkish|ban|crackdown|outflow|liquidat|seizure|halt|sanction|加息|收緊|禁止|打壓|流出|清算|賣出|暫停|制裁|利空)/i.test(t);
  if (bull && !bear) return "做多";
  if (bear) return "做空";
  return "中性";
}
function jin10Confidence(isImportant, direction, content = "") {
  let s = isImportant ? 4 : 2;
  if (/(fed\b|fomc|bitcoin|btc|rate|美聯儲|比特幣|加息|降息)/i.test(content)) s = Math.min(s + 1, 5);
  if (direction === "中性") s = Math.max(s - 1, 1);
  return s;
}
function jin10Commentary(content = "", direction) {
  const t = content.toLowerCase();
  if (direction === "做多") {
    if (/(rate cut|降息)/i.test(t))  return "降息預期升溫，對加密市場偏利多。";
    if (/(inflow|流入)/i.test(t))    return "資金流入訊號，短線情緒偏多。";
    if (/(approval|批准)/i.test(t))  return "監管利好訊號，市場情緒可能轉正。";
    return "宏觀訊號偏多，關注後續量能確認。";
  }
  if (direction === "做空") {
    if (/(rate hike|加息)/i.test(t))  return "加息預期升溫，風險資產短線承壓。";
    if (/(ban|禁止|crackdown)/i.test(t)) return "監管收緊訊號，市場情緒偏謹慎。";
    if (/(liquidat|清算)/i.test(t))   return "清算事件發生，注意連鎖槓桿風險。";
    if (/(tariff|關稅)/i.test(t))     return "關稅政策衝擊全球風險資產，偏空。";
    if (/(war|戰爭|战争|missile|導彈|导弹|airstrike|空襲|空袭|nuclear|核武)/i.test(t)) return "地緣軍事衝突升溫，市場避險情緒上升，風險資產短線承壓。";
    if (/(middle east|中東|中东|iran|伊朗|israel|以色列|houthi|胡塞|hormuz)/i.test(t)) return "中東局勢緊張，油價與避險需求同步上升，加密市場短線偏空。";
    if (/(trump|川普|特朗普)/i.test(t)) return "川普政策聲明影響市場預期，需留意突發政策風險。";
    return "宏觀訊號偏空，建議謹慎控制倉位。";
  }
  return "消息面中性，等待更多數據確認方向。";
}
function normalizeJin10Item(item) {
  const content = String(item.data?.content || "").trim();
  const direction = jin10Direction(content);
  const confidence = jin10Confidence(Boolean(item.important), direction, content);
  const commentary = jin10Commentary(content, direction);
  const link = item.data?.link || `https://flash.jin10.com/detail/${item.id}`;
  let published_at;
  try { published_at = new Date(String(item.time).replace(" ", "T") + "+08:00").toISOString(); }
  catch { published_at = new Date().toISOString(); }
  return { id: String(item.id), published_at, content, link, direction, confidence, commentary, is_important: item.important ? 1 : 0 };
}

const router = Router();

// GET /api/health
router.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// GET /api/dashboard - returns latest dashboard snapshot
router.get("/dashboard", (_req, res) => {
  const snapshot = getSnapshot("crypto_dashboard:latest");

  if (!snapshot) {
    return res.status(404).json({
      error: "No dashboard data available. Run the update script first."
    });
  }

  res.json(snapshot.data);
});

// GET /api/dashboard/updated - returns last update timestamp
router.get("/dashboard/updated", (_req, res) => {
  const snapshot = getSnapshot("crypto_dashboard:latest");

  if (!snapshot) {
    return res.status(404).json({ lastUpdated: null });
  }

  res.json({ lastUpdated: snapshot.updatedAt });
});

// GET /api/macro-events - optional ?country=US&days=7
router.get("/macro-events", (req, res) => {
  const snapshot = getSnapshot("crypto_dashboard:latest");

  if (!snapshot) {
    return res.status(404).json({ error: "No data available." });
  }

  let events = snapshot.data.macroEvents || [];

  const { country, days } = req.query;

  if (country) {
    events = events.filter((e) => String(e.country || "").toUpperCase() === String(country).toUpperCase());
  }

  if (days) {
    const daysNum = parseInt(days, 10);
    if (Number.isFinite(daysNum) && daysNum > 0) {
      const cutoff = new Date(Date.now() + daysNum * 24 * 60 * 60 * 1000).toISOString();
      const past = new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000).toISOString();
      events = events.filter((e) => {
        const dt = e.datetime || "";
        return dt >= past && dt <= cutoff;
      });
    }
  }

  res.json({ events, count: events.length });
});

// GET /api/signals - returns crypto signals
router.get("/signals", (_req, res) => {
  const snapshot = getSnapshot("crypto_dashboard:latest");

  if (!snapshot) {
    return res.status(404).json({ error: "No data available." });
  }

  const signals = snapshot.data.cryptoSignals || [];
  res.json({ signals, count: signals.length });
});

// GET /api/update-log - returns last 10 update log entries
router.get("/update-log", (_req, res) => {
  const rows = db
    .prepare("SELECT id, status, collectors_ran, error_message, created_at FROM update_log ORDER BY id DESC LIMIT 10")
    .all();
  res.json({ log: rows });
});

// POST /api/dashboard - saves new dashboard data
router.post("/dashboard", (req, res) => {
  const body = req.body;

  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Invalid request body. Expected JSON object." });
  }

  try {
    saveSnapshot("crypto_dashboard:latest", body);

    const collectorsRan = Array.isArray(body.macroEvents) ? 1 : 0;
    logUpdate("success", collectorsRan, null);

    res.json({
      ok: true,
      savedAt: new Date().toISOString(),
      macroEventCount: (body.macroEvents || []).length,
      signalCount: (body.cryptoSignals || []).length
    });
  } catch (err) {
    logUpdate("error", 0, String(err.message));
    res.status(500).json({ error: "Failed to save dashboard data.", detail: err.message });
  }
});

// GET /api/jin10 — 即時 proxy（前端每 60 秒輪詢）
router.get("/jin10", async (_req, res) => {
  try {
    const url = new URL(JIN10_API);
    url.searchParams.set("channel", "-8200");
    url.searchParams.set("vip", "1");
    const upstream = await fetch(url.toString(), {
      headers: JIN10_HEADERS,
      signal: AbortSignal.timeout(15000)
    });
    if (!upstream.ok) return res.status(502).json({ ok: false, items: [], reason: `jin10 HTTP ${upstream.status}` });
    const json = await upstream.json();
    const rawItems = Array.isArray(json.data) ? json.data : [];
    const items = rawItems
      .filter(item => CRYPTO_RELEVANT.test(item.data?.content || ""))
      .slice(0, 30)
      .map(normalizeJin10Item);
    res.json({ ok: true, fetchedAt: new Date().toISOString(), count: items.length, items });
  } catch (e) {
    res.status(502).json({ ok: false, items: [], reason: String(e?.message || e) });
  }
});

// GET /api/jin10/history — 讀取 SQLite 歷史（前端頁面載入時拉取）
router.get("/jin10/history", (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || "100", 10), 500);
    const offset = Math.max(parseInt(req.query.offset || "0",   10), 0);
    const rows = db.prepare(`
      SELECT id, published_at, content, link, direction, confidence, commentary, is_important, saved_at
      FROM jin10_news
      ORDER BY published_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    res.json({ ok: true, count: rows.length, items: rows });
  } catch (e) {
    res.status(500).json({ ok: false, items: [], reason: String(e?.message || e) });
  }
});

export default router;
