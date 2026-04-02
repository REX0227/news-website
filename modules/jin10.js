/**
 * jin10.js — 金十數據快訊前端模組
 *
 * A. fetchJin10Live()  → GET /api/jin10（即時 proxy，每 60 秒）
 * B. fetchJin10Hist()  → GET /api/jin10/history（SQLite 歷史，頁面載入時）
 * renderJin10Live()    → 渲染即時快訊區
 * renderJin10History() → 渲染歷史記錄區
 */

const LIVE_URL    = "http://localhost:3000/api/jin10";
const HISTORY_URL = "http://localhost:3000/api/jin10/history";
const UPSTASH_URL         = "https://sensible-grouper-89071.upstash.io";
const UPSTASH_READ_TOKEN  = "gQAAAAAAAVvvAAIncDE4ZjIwMzAwMmMxNTI0N2UxYjk1ZGJkNDc2MTE4YzA4ZXAxODkwNzE";
const UPSTASH_JIN10_KEY   = "jin10:latest";

// ── fetch ────────────────────────────────────────────────────────────

async function fetchJin10FromUpstash() {
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(UPSTASH_JIN10_KEY)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_READ_TOKEN}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return { ok: false, items: [] };
    const json = await res.json();
    const result = typeof json.result === "string" ? JSON.parse(json.result) : json.result;
    if (!result?.items) return { ok: false, items: [] };
    return { ok: true, fetchedAt: result.updatedAt, items: result.items, source: "upstash" };
  } catch {
    return { ok: false, items: [] };
  }
}

export async function fetchJin10Live() {
  try {
    const res = await fetch(LIVE_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error("local api error");
    const data = await res.json();
    if (data.ok) return { ...data, source: "local" };
    throw new Error("local api returned not ok");
  } catch {
    // fallback to Upstash（GitHub Pages 或本機 server 未啟動時）
    return fetchJin10FromUpstash();
  }
}

export async function fetchJin10History(limit = 100) {
  try {
    const res = await fetch(`${HISTORY_URL}?limit=${limit}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error("local api error");
    const data = await res.json();
    if (data.ok) return data;
    throw new Error("no data");
  } catch {
    // GitHub Pages：歷史改從 Upstash 讀同一份 key（最近 30 筆）
    return fetchJin10FromUpstash();
  }
}

// ── 工具函式 ─────────────────────────────────────────────────────────

const fmt = new Intl.DateTimeFormat("zh-Hant", {
  timeZone: "Asia/Taipei",
  month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false
});

function directionBadge(direction) {
  if (direction === "做多") return `<span class="jin10-dir bull">▲ 做多</span>`;
  if (direction === "做空") return `<span class="jin10-dir bear">▼ 做空</span>`;
  return `<span class="jin10-dir neutral">— 中性</span>`;
}

function confidenceDots(score) {
  const n = Math.max(1, Math.min(5, score));
  return Array.from({ length: 5 }, (_, i) =>
    `<span class="jin10-dot${i < n ? " on" : ""}"></span>`
  ).join("");
}

function renderItem(item) {
  const timeStr = item.published_at ? fmt.format(new Date(item.published_at)) : "—";
  const link = item.link || "#";
  return `
    <div class="jin10-item">
      <div class="jin10-item-header">
        <span class="jin10-time">${timeStr}</span>
        ${directionBadge(item.direction)}
        <span class="jin10-confidence">${confidenceDots(item.confidence)}</span>
      </div>
      <p class="jin10-content">
        <a href="${link}" target="_blank" rel="noreferrer">${item.content}</a>
      </p>
      <p class="jin10-commentary">${item.commentary}</p>
    </div>
  `;
}

// ── render 即時快訊 ───────────────────────────────────────────────────

export function renderJin10Live(result) {
  const root = document.getElementById("jin10-live");
  if (!root) return;

  if (!result.ok || !result.items?.length) {
    root.innerHTML = `<div class="jin10-empty">暫無即時快訊</div>`;
    return;
  }

  const fetchedAt = result.fetchedAt
    ? `更新：${fmt.format(new Date(result.fetchedAt))}`
    : "";

  root.innerHTML = `
    <div class="jin10-live-header">
      <span class="jin10-live-dot"></span> 即時快訊
      <span class="jin10-fetch-time">${fetchedAt}</span>
    </div>
    <div class="jin10-live-list">
      ${result.items.map(renderItem).join("")}
    </div>
  `;
}

// ── render 歷史記錄 ───────────────────────────────────────────────────

export function renderJin10History(result) {
  const root = document.getElementById("jin10-history");
  if (!root) return;

  if (!result.ok || !result.items?.length) {
    root.innerHTML = `<div class="jin10-empty">資料庫暫無歷史記錄</div>`;
    return;
  }

  // tab 控制（多/空/中性/全部）
  root.innerHTML = `
    <div class="jin10-hist-tabs">
      <button class="jin10-tab active" data-filter="all">全部（${result.items.length}）</button>
      <button class="jin10-tab" data-filter="做多">做多</button>
      <button class="jin10-tab" data-filter="做空">做空</button>
      <button class="jin10-tab" data-filter="中性">中性</button>
    </div>
    <div id="jin10-hist-list" class="jin10-hist-list">
      ${result.items.map(renderItem).join("")}
    </div>
  `;

  // tab 篩選邏輯
  root.querySelectorAll(".jin10-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      root.querySelectorAll(".jin10-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const filter = btn.dataset.filter;
      const items = filter === "all"
        ? result.items
        : result.items.filter(i => i.direction === filter);
      document.getElementById("jin10-hist-list").innerHTML =
        items.length ? items.map(renderItem).join("") : `<div class="jin10-empty">無符合條件的記錄</div>`;
    });
  });
}
