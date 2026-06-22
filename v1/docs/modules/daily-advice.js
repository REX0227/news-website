/**
 * daily-advice.js — 每日投資建議前端模組
 *
 * renderDailyAdvice(date?)  → 渲染指定日期（預設今天）的投資建議
 * renderDailyAdviceList()   → 渲染右側歷史記錄清單
 */

const API = `${window.location.origin}/api/v2/daily-advice`;

const DIR_MAP = {
  bullish:  { label: "看多", color: "#4ade80", bg: "rgba(74,222,128,0.12)", border: "#166534" },
  bearish:  { label: "看空", color: "#f87171", bg: "rgba(248,113,113,0.12)", border: "#991b1b" },
  neutral:  { label: "中性", color: "#94a3b8", bg: "rgba(148,163,184,0.10)", border: "#334155" },
  cautious: { label: "謹慎", color: "#fb923c", bg: "rgba(251,146,60,0.12)",  border: "#9a3412" },
};

// ── 工具函式 ─────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(d) {
  // YYYY-MM-DD → M月D日（週X）
  const dt = new Date(d + "T00:00:00");
  const WEEK = ["日","一","二","三","四","五","六"];
  return `${dt.getMonth()+1}月${dt.getDate()}日（週${WEEK[dt.getDay()]}）`;
}

// ── 單筆建議渲染 ─────────────────────────────────────────────────────────────

export async function renderDailyAdvice(date) {
  const el = document.getElementById("daily-advice-content");
  if (!el) return;

  const target = date || todayStr();
  el.innerHTML = `<p class="da-loading">載入中…</p>`;

  try {
    const res  = await fetch(`${API}/${target}`);
    if (res.status === 404) {
      el.innerHTML = `<p class="da-empty">📭 ${fmtDate(target)} 暫無投資建議</p>`;
      return;
    }
    if (!res.ok) throw new Error(res.status);
    const { advice } = await res.json();
    el.innerHTML = buildAdviceHTML(advice);
  } catch (e) {
    el.innerHTML = `<p class="da-error">讀取失敗：${e.message}</p>`;
  }
}

function buildAdviceHTML(a) {
  const dir  = DIR_MAP[a.overall_direction] || DIR_MAP.neutral;
  const rows = [
    ["📅 發生了什麼", a.what_happened],
    ["🔍 為什麼重要", a.why_important],
    ["💡 我的看法",   a.my_view],
    ["👁 觀察指標",   a.watch_indicators],
  ].filter(([, v]) => v && v.trim());

  const actions = [
    a.action_short && `<div class="da-action-item"><span class="da-action-tag short">短線</span>${a.action_short}</div>`,
    a.action_mid   && `<div class="da-action-item"><span class="da-action-tag mid">中線</span>${a.action_mid}</div>`,
    a.action_long  && `<div class="da-action-item"><span class="da-action-tag long">長線</span>${a.action_long}</div>`,
  ].filter(Boolean).join("");

  return `
    <div class="da-card" style="border-color:${dir.border};background:${dir.bg}">
      <div class="da-headline">
        <span class="da-dir-badge" style="color:${dir.color}">${dir.label}</span>
        ${a.headline || "（無標題）"}
        ${a.regime_label ? `<span class="da-regime-tag">${a.regime_label}</span>` : ""}
      </div>

      ${rows.map(([label, val]) => `
        <div class="da-section">
          <div class="da-section-label">${label}</div>
          <div class="da-section-body">${escHtml(val)}</div>
        </div>
      `).join("")}

      ${actions ? `
        <div class="da-section">
          <div class="da-section-label">📌 操作建議</div>
          <div class="da-actions">${actions}</div>
        </div>
      ` : ""}

      <div class="da-meta">
        ${a.author !== "manual" ? `<span>作者：${escHtml(a.author)}</span>` : ""}
        <span>更新：${a.updated_at ? a.updated_at.slice(0,16).replace("T"," ") : "—"}</span>
      </div>
    </div>
  `;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/\n/g,"<br>");
}

// ── 歷史列表 ─────────────────────────────────────────────────────────────────

export async function renderDailyAdviceList(selectedDate) {
  const el = document.getElementById("daily-advice-list");
  if (!el) return;

  try {
    const res  = await fetch(`${API}?from=2026-02-01&limit=90`);
    const data = await res.json();
    if (!data.ok || !data.rows.length) {
      el.innerHTML = `<p class="da-empty" style="padding:12px">尚無記錄</p>`;
      return;
    }

    const today = todayStr();
    const sel   = selectedDate || today;

    el.innerHTML = data.rows.map(r => {
      const dir   = DIR_MAP[r.overall_direction] || DIR_MAP.neutral;
      const isToday = r.date === today;
      const active  = r.date === sel ? " da-list-active" : "";
      return `
        <div class="da-list-item${active}" data-date="${r.date}" title="${r.headline || r.date}">
          <span class="da-list-dot" style="background:${dir.color}"></span>
          <span class="da-list-date">${r.date}${isToday ? " <em>今</em>" : ""}</span>
          <span class="da-list-dir" style="color:${dir.color}">${dir.label}</span>
        </div>
      `;
    }).join("");

    // 點擊切換
    el.querySelectorAll(".da-list-item").forEach(item => {
      item.addEventListener("click", () => {
        const d = item.dataset.date;
        // 更新標題日期顯示
        const title = document.getElementById("da-current-date");
        if (title) title.textContent = fmtDate(d);
        // 更新 active 狀態
        el.querySelectorAll(".da-list-item").forEach(x => x.classList.remove("da-list-active"));
        item.classList.add("da-list-active");
        renderDailyAdvice(d);
      });
    });
  } catch (e) {
    el.innerHTML = `<p class="da-error" style="padding:12px">讀取失敗</p>`;
  }
}

// ── 日期導覽（上一天 / 下一天）────────────────────────────────────────────────

export function initDailyAdviceNav() {
  let current = todayStr();

  const titleEl = document.getElementById("da-current-date");
  const prevBtn  = document.getElementById("da-prev");
  const nextBtn  = document.getElementById("da-next");
  const todayBtn = document.getElementById("da-today");

  function go(date) {
    current = date;
    if (titleEl) titleEl.textContent = fmtDate(date);
    if (nextBtn) nextBtn.disabled = date >= todayStr();
    renderDailyAdvice(date);
    // 同步高亮列表
    const listEl = document.getElementById("daily-advice-list");
    if (listEl) {
      listEl.querySelectorAll(".da-list-item").forEach(x => {
        x.classList.toggle("da-list-active", x.dataset.date === date);
      });
    }
  }

  if (titleEl) titleEl.textContent = fmtDate(current);
  if (nextBtn) nextBtn.disabled = true;

  prevBtn?.addEventListener("click", () => {
    const d = new Date(current + "T00:00:00");
    d.setDate(d.getDate() - 1);
    if (d >= new Date("2026-02-01T00:00:00")) go(d.toISOString().slice(0,10));
  });

  nextBtn?.addEventListener("click", () => {
    const d = new Date(current + "T00:00:00");
    d.setDate(d.getDate() + 1);
    if (d.toISOString().slice(0,10) <= todayStr()) go(d.toISOString().slice(0,10));
  });

  todayBtn?.addEventListener("click", () => go(todayStr()));

  // 初始載入
  go(current);
}
