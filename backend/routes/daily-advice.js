/**
 * daily-advice.js — 每日投資建議 API
 *
 * GET  /api/v2/daily-advice           → 列表（支援 from/to/limit/offset）
 * GET  /api/v2/daily-advice/dates     → 所有有資料的日期清單（供前端日曆用）
 * GET  /api/v2/daily-advice/:date     → 單筆（YYYY-MM-DD）
 * POST /api/v2/daily-advice           → 新增或更新（upsert by date）
 */

import { Router } from "express";
import { db } from "../database.js";

const router = Router();

const VALID_DIRECTIONS = new Set(["bullish", "bearish", "neutral", "cautious"]);

function parseDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ── 列表 ────────────────────────────────────────────────────────────────────

router.get("/daily-advice", (req, res) => {
  try {
    const from   = parseDate(req.query.from)  || "2026-02-01";
    const to     = parseDate(req.query.to)    || "9999-12-31";
    const limit  = Math.min(parseInt(req.query.limit  || "90",  10), 365);
    const offset = Math.max(parseInt(req.query.offset || "0",   10), 0);

    const rows = db.prepare(`
      SELECT date, headline, overall_direction, regime_label, author,
             action_short, action_mid, action_long,
             what_happened, why_important, my_view, watch_indicators,
             created_at, updated_at
      FROM daily_advice
      WHERE date >= ? AND date <= ?
      ORDER BY date DESC
      LIMIT ? OFFSET ?
    `).all(from, to, limit, offset);

    const total = db.prepare(`
      SELECT COUNT(*) as cnt FROM daily_advice WHERE date >= ? AND date <= ?
    `).get(from, to).cnt;

    res.json({ ok: true, total, limit, offset, rows });
  } catch (e) {
    console.error("[daily-advice] GET list error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 所有已存在日期（供前端日曆高亮）────────────────────────────────────────

router.get("/daily-advice/dates", (_req, res) => {
  try {
    const rows = db.prepare(`
      SELECT date, overall_direction FROM daily_advice
      WHERE date >= '2026-02-01'
      ORDER BY date DESC
    `).all();
    res.json({ ok: true, dates: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 單筆 ────────────────────────────────────────────────────────────────────

router.get("/daily-advice/:date", (req, res) => {
  const date = parseDate(req.params.date);
  if (!date) return res.status(400).json({ ok: false, error: "invalid date format" });

  try {
    const row = db.prepare("SELECT * FROM daily_advice WHERE date = ?").get(date);
    if (!row) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true, advice: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 新增 / 更新 ─────────────────────────────────────────────────────────────

router.post("/daily-advice", (req, res) => {
  const {
    date, headline = "", what_happened = "", why_important = "",
    my_view = "", action_short = "", action_mid = "", action_long = "",
    watch_indicators = "", overall_direction = "neutral",
    regime_label = "", author = "manual"
  } = req.body || {};

  if (!parseDate(date)) return res.status(400).json({ ok: false, error: "date required (YYYY-MM-DD)" });
  if (!VALID_DIRECTIONS.has(overall_direction))
    return res.status(400).json({ ok: false, error: "invalid overall_direction" });

  try {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO daily_advice
        (date, headline, what_happened, why_important, my_view,
         action_short, action_mid, action_long, watch_indicators,
         overall_direction, regime_label, author, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(date) DO UPDATE SET
        headline=excluded.headline,
        what_happened=excluded.what_happened,
        why_important=excluded.why_important,
        my_view=excluded.my_view,
        action_short=excluded.action_short,
        action_mid=excluded.action_mid,
        action_long=excluded.action_long,
        watch_indicators=excluded.watch_indicators,
        overall_direction=excluded.overall_direction,
        regime_label=excluded.regime_label,
        author=excluded.author,
        updated_at=excluded.updated_at
    `).run(date, headline, what_happened, why_important, my_view,
           action_short, action_mid, action_long, watch_indicators,
           overall_direction, regime_label, author, now, now);

    res.json({ ok: true, date });
  } catch (e) {
    console.error("[daily-advice] POST error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
