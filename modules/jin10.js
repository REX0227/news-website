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

// ── 即時快訊去重 Set（module-level，跨輪詢保留已見 id）─────────────
const _seenIds = new Set();

// ── AbortSignal.timeout 相容（iOS 16.4 以前不支援）──────────────────
function makeSignal(ms) {
  try { return AbortSignal.timeout(ms); } catch {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  }
}

// ── fetch ────────────────────────────────────────────────────────────

async function fetchJin10FromUpstash() {
  try {
    // 先嘗試讀 jin10:history list（最近 50 筆）
    const res = await fetch(
      `${UPSTASH_URL}/lrange/${encodeURIComponent('jin10:history')}/0/49`,
      { headers: { Authorization: `Bearer ${UPSTASH_READ_TOKEN}` }, signal: makeSignal(8000) }
    );
    if (!res.ok) throw new Error();
    const json = await res.json();
    if (!Array.isArray(json.result) || json.result.length === 0) throw new Error();
    const items = json.result.map(item => {
      try { return typeof item === 'string' ? JSON.parse(item) : item; } catch { return null; }
    }).filter(Boolean);
    // 去重（同 id 可能重複）
    const seen = new Set();
    const unique = items.filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });
    return { ok: true, fetchedAt: unique[0]?.published_at, items: unique, source: "upstash" };
  } catch {
    // fallback: 讀 jin10:latest（舊格式）
    try {
      const res2 = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent('jin10:latest')}`, {
        headers: { Authorization: `Bearer ${UPSTASH_READ_TOKEN}` }, signal: makeSignal(8000)
      });
      if (!res2.ok) return { ok: false, items: [] };
      const json2 = await res2.json();
      const result = typeof json2.result === 'string' ? JSON.parse(json2.result) : json2.result;
      if (!result?.items) return { ok: false, items: [] };
      return { ok: true, fetchedAt: result.updatedAt, items: result.items, source: "upstash" };
    } catch { return { ok: false, items: [] }; }
  }
}

export async function fetchJin10Live() {
  try {
    const res = await fetch(LIVE_URL, { signal: makeSignal(5000) });
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
    const res = await fetch(`${HISTORY_URL}?limit=${limit}`, { signal: makeSignal(5000) });
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
  if (!item || typeof item !== "object") return "";
  const timeStr = item.published_at ? fmt.format(new Date(item.published_at)) : "—";
  const link = item.link || "#";
  const content = item.content || "";
  const commentary = item.commentary || "";
  return `
    <div class="jin10-item">
      <div class="jin10-item-header">
        <span class="jin10-time">${timeStr}</span>
        ${directionBadge(item.direction)}
        <span class="jin10-confidence">${confidenceDots(item.confidence)}</span>
      </div>
      <p class="jin10-content">
        <a href="${link}" target="_blank" rel="noreferrer">${content}</a>
      </p>
      ${commentary ? `<p class="jin10-commentary">${commentary}</p>` : ""}
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

  // 去重：找出本批中有新 id 的 item
  const newItems = result.items.filter(i => !_seenIds.has(i.id));

  // 如果全部都是舊 id，只更新時間標示，不重繪列表
  if (newItems.length === 0) {
    const timeEl = root.querySelector(".jin10-fetch-time");
    if (timeEl && result.fetchedAt) {
      timeEl.textContent = _buildFetchedAtText(result);
    }
    return;
  }

  // 有新 id → 加入 _seenIds，重繪列表
  newItems.forEach(i => _seenIds.add(i.id));

  const sourceLabel = result.source === "upstash" ? "Upstash" : result.source === "local" ? "本機" : "";
  const sourceBadge = sourceLabel ? `<span class="jin10-source-badge">${sourceLabel}</span>` : "";

  root.innerHTML = `
    <div class="jin10-live-header">
      <span class="jin10-live-dot"></span> 即時快訊
      <span class="jin10-fetch-time">${_buildFetchedAtText(result)}</span>
      ${sourceBadge}
    </div>
    <div class="jin10-live-list">
      ${result.items.map(renderItem).join("")}
    </div>
  `;
}

/** 格式化更新時間為台北時間 MM/DD HH:MM */
function _buildFetchedAtText(result) {
  if (!result.fetchedAt) return "";
  try {
    return `更新：${fmt.format(new Date(result.fetchedAt))}`;
  } catch { return ""; }
}

// ── render 歷史記錄 ───────────────────────────────────────────────────

export function renderJin10History(result) {
  const root = document.getElementById("jin10-history");
  if (!root) return;

  if (!result.ok || !result.items?.length) {
    root.innerHTML = `<div class="jin10-empty">資料庫暫無歷史記錄</div>`;
    return;
  }

  // 統計資訊：共 N 筆 + 最新時間
  const latestItem = result.items.find(i => i.published_at);
  const latestTimeStr = latestItem
    ? (() => {
        try {
          const d = new Date(latestItem.published_at);
          const pad = n => String(n).padStart(2, "0");
          return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } catch { return "—"; }
      })()
    : "—";
  const histMeta = `<div class="jin10-hist-meta">共 ${result.items.length} 筆 | 最新：${latestTimeStr}</div>`;

  // 各方向筆數
  const countBull    = result.items.filter(i => i.direction === "做多").length;
  const countBear    = result.items.filter(i => i.direction === "做空").length;
  const countNeutral = result.items.filter(i => i.direction === "中性").length;

  // tab 控制（多/空/中性/全部）
  root.innerHTML = `
    <div class="jin10-hist-tabs">
      <button class="jin10-tab active" data-filter="all">全部（${result.items.length}）</button>
      <button class="jin10-tab" data-filter="做多">做多（${countBull}）</button>
      <button class="jin10-tab" data-filter="做空">做空（${countBear}）</button>
      <button class="jin10-tab" data-filter="中性">中性（${countNeutral}）</button>
    </div>
    ${histMeta}
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
