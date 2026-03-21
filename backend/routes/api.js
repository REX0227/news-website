import { Router } from "express";
import { db, saveSnapshot, getSnapshot, logUpdate } from "../database.js";

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

export default router;
