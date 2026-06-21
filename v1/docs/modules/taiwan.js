/**
 * taiwan.js — 台股進出場時機 前端渲染模組
 * 從 Upstash 讀取 taiwan_dashboard:latest 並渲染台股頁籤
 */

const UPSTASH_URL        = "https://sensible-grouper-89071.upstash.io";
const UPSTASH_READ_TOKEN = "gQAAAAAAAVvvAAIncDE4ZjIwMzAwMmMxNTI0N2UxYjk1ZGJkNDc2MTE4YzA4ZXAxODkwNzE";
const TW_KEY             = "taiwan_dashboard:latest";
const TW_HISTORY_KEY     = "taiwan_composite:history";

let _historyChart = null;

// ── 資料載入 ──────────────────────────────────────────────────────
export async function loadTaiwanData() {
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(TW_KEY)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_READ_TOKEN}` }
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.result) return null;
    return typeof json.result === "string" ? JSON.parse(json.result) : json.result;
  } catch { return null; }
}

export async function loadTaiwanHistory() {
  try {
    const res = await fetch(`${UPSTASH_URL}/lrange/${encodeURIComponent(TW_HISTORY_KEY)}/0/59`, {
      headers: { Authorization: `Bearer ${UPSTASH_READ_TOKEN}` }
    });
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json.result)) return [];
    return json.result.map(item => {
      try {
        let v = typeof item === "string" ? JSON.parse(item) : item;
        if (Array.isArray(v)) v = v[0];
        if (typeof v === "string") v = JSON.parse(v);
        return v;
      } catch { return null; }
    }).filter(Boolean).reverse(); // 舊→新
  } catch { return []; }
}

// ── 輔助函式 ─────────────────────────────────────────────────────
function fmt(v, unit = "", digits = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = v >= 0 ? `+${v.toFixed(digits)}` : v.toFixed(digits);
  return `${s}${unit}`;
}

function signalBadge(label, signal, color) {
  return `<span class="tw-signal-badge" style="background:${color}20;color:${color};border:1px solid ${color}40">${signal}</span>`;
}

function factorBar(score) {
  if (score == null) return `<span style="color:#475569">—</span>`;
  const pct  = Math.round((score + 1) / 2 * 100);
  const col  = score > 0.15 ? "#4ade80" : score < -0.15 ? "#f87171" : "#94a3b8";
  return `
    <div class="tw-factor-bar-wrap">
      <div class="tw-factor-bar-track">
        <div class="tw-factor-bar-fill" style="width:${pct}%;background:${col}"></div>
        <div class="tw-factor-bar-mid"></div>
      </div>
      <span class="tw-factor-bar-val" style="color:${col}">${score >= 0 ? "+" : ""}${score.toFixed(2)}</span>
    </div>`;
}

// ── 渲染：主要評分卡片 ────────────────────────────────────────────
function renderScoreCard(composite, taiex, dataDate, history) {
  const score = composite?.score ?? null;
  const label = composite?.label ?? "neutral";
  const signal = composite?.signal ?? "中性持平";
  const color = composite?.color ?? "#94a3b8";
  const coverage = composite?.coverage ?? 0;
  const total = composite?.total ?? 6;

  const taiexClose = taiex?.close;
  const taiexChgPct = taiex?.changePct;
  const taiexChgAmt = taiex?.changeAmt;
  const chgColor = taiexChgPct > 0 ? "#4ade80" : taiexChgPct < 0 ? "#f87171" : "#94a3b8";

  const scoreDisplay = score !== null
    ? `<div class="tw-score-num" style="color:${color}">${score >= 0 ? "+" : ""}${score.toFixed(2)}</div>`
    : `<div class="tw-score-num" style="color:#475569">—</div>`;

  // 與前一筆歷史比較（顯示方向箭頭）
  let deltaEl = "";
  if (history?.length >= 2 && score !== null) {
    const prev = history[history.length - 2]?.s;
    if (prev != null && Number.isFinite(prev)) {
      const d = Math.round((score - prev) * 100) / 100;
      const arrow = d > 0.01 ? "↑" : d < -0.01 ? "↓" : "→";
      const dc    = d > 0.01 ? "#4ade80" : d < -0.01 ? "#f87171" : "#94a3b8";
      deltaEl = `<span class="tw-score-delta" style="color:${dc}">${arrow} ${d > 0 ? "+" : ""}${d.toFixed(2)}</span>`;
    }
  }

  return `
    <div class="tw-score-card">
      <div class="tw-score-header">
        <div>
          <div class="tw-score-label">進出場訊號</div>
          <div style="display:flex;align-items:center;gap:10px">
            ${scoreDisplay}
            ${deltaEl}
          </div>
          ${signalBadge(label, signal, color)}
        </div>
        <div class="tw-taiex-box">
          <div class="tw-score-label">加權指數</div>
          <div class="tw-taiex-close">${taiexClose != null ? taiexClose.toLocaleString() : "—"}</div>
          <div class="tw-taiex-chg" style="color:${chgColor}">
            ${taiexChgAmt != null ? fmt(taiexChgAmt, "", 0) : "—"}
            ${taiexChgPct != null ? ` (${fmt(taiexChgPct, "%")})` : ""}
          </div>
        </div>
      </div>
      <div class="tw-score-meta">
        資料日期：${dataDate ?? "—"} ｜ 因子覆蓋：${coverage}／${total}
      </div>
    </div>`;
}

// ── 渲染：因子明細 ────────────────────────────────────────────────
const FACTOR_LABELS = {
  "tw.foreign_net_buy":     "外資買賣超",
  "tw.institutional_total": "三大法人合計",
  "tw.margin_change":       "融資餘額變化",
  "tw.short_change":        "融券回補訊號",
  "tw.taiex_ma_direction":  "均線方向（5MA/20MA）",
  "tw.taiex_momentum_5d":   "近5日動能"
};

function renderFactors(factors) {
  if (!factors || Object.keys(factors).length === 0) {
    return `<p style="color:#475569;padding:16px">暫無因子資料</p>`;
  }

  const rows = Object.entries(factors).map(([key, f]) => {
    const label = FACTOR_LABELS[key] ?? key;
    const rawDisplay = (f.raw != null && f.rawUnit != null)
      ? `${typeof f.raw === "number" ? fmt(f.raw, f.rawUnit) : f.raw}`
      : "—";
    return `
      <div class="tw-factor-row">
        <div class="tw-factor-name">${label}</div>
        <div class="tw-factor-raw">${rawDisplay}</div>
        <div class="tw-factor-dir">${f.direction ?? "—"}</div>
        <div>${factorBar(f.score)}</div>
      </div>`;
  }).join("");

  return `
    <div class="tw-factor-grid">
      <div class="tw-factor-header">
        <span>因子</span><span>數值</span><span>方向</span><span>評分</span>
      </div>
      ${rows}
    </div>`;
}

// ── 渲染：歷史走勢圖 ──────────────────────────────────────────────
function renderHistoryChart(history) {
  if (!history || history.length < 3) return "";
  return `
    <div class="tw-history-wrap">
      <div class="tw-history-title">複合評分走勢（近 ${Math.min(history.length, 60)} 次）</div>
      <canvas id="tw-history-chart" height="70"></canvas>
    </div>`;
}

function drawHistoryChart(history) {
  if (!history || history.length < 3) return;
  const canvas = document.getElementById("tw-history-chart");
  if (!canvas || typeof Chart === "undefined") return;

  if (_historyChart) { _historyChart.destroy(); _historyChart = null; }

  const recent = history.slice(-60);
  const labels = recent.map(h => h.t ? h.t.slice(5, 10) : "");
  const scores = recent.map(h => (typeof h.s === "number" ? h.s : null));
  const pointColors = scores.map(s => {
    if (s == null)   return "#475569";
    if (s >= 0.4)    return "#4ade80";
    if (s >= 0.15)   return "#86efac";
    if (s >= -0.15)  return "#94a3b8";
    if (s >= -0.4)   return "#fca5a5";
    return "#f87171";
  });

  _historyChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data: scores,
        borderColor: "#38bdf8",
        borderWidth: 1.5,
        pointRadius: recent.length > 30 ? 2 : 3,
        pointBackgroundColor: pointColors,
        fill: false,
        tension: 0.3,
        spanGaps: true
      }]
    },
    options: {
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => recent[items[0].dataIndex]?.t?.slice(0, 10) ?? "",
            label: (ctx) => `評分: ${ctx.raw != null ? ctx.raw.toFixed(2) : "—"}`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#475569", font: { size: 9 }, maxTicksLimit: 10 },
          grid: { display: false }
        },
        y: {
          min: -1, max: 1,
          ticks: { color: "#64748b", font: { size: 9 }, count: 5 },
          grid: { color: "#1e293b" }
        }
      }
    }
  });
}

// ── 渲染：法人資金流 ──────────────────────────────────────────────
function renderInstitutional(institutional) {
  if (!institutional?.available) {
    return `<p style="color:#475569">三大法人資料不可用</p>`;
  }
  const rows = [
    ["外資及陸資",   institutional.foreignNetBuyBillions],
    ["投信",         institutional.trustNetBuyBillions],
    ["自營商",       institutional.dealerNetBuyBillions],
    ["三大法人合計", institutional.totalNetBuyBillions]
  ];

  return `
    <div class="tw-inst-grid">
      ${rows.map(([name, val]) => {
        const col = val > 0 ? "#4ade80" : val < 0 ? "#f87171" : "#94a3b8";
        return `
          <div class="tw-inst-row">
            <span class="tw-inst-name">${name}</span>
            <span class="tw-inst-val" style="color:${col}">${fmt(val, " 億")} 元</span>
          </div>`;
      }).join("")}
    </div>
    <div class="tw-data-note">資料日期：${institutional.dataDate ?? "—"}</div>`;
}

// ── 渲染：融資融券 ────────────────────────────────────────────────
function renderMargin(margin) {
  if (!margin?.available) {
    return `<p style="color:#475569">融資融券資料不可用</p>`;
  }
  const balCol = margin.marginChangeBillions > 0 ? "#fca5a5" : margin.marginChangeBillions < 0 ? "#4ade80" : "#94a3b8";
  const shortCol = margin.shortChangeKShares < 0 ? "#4ade80" : margin.shortChangeKShares > 0 ? "#fca5a5" : "#94a3b8";

  return `
    <div class="tw-margin-grid">
      <div class="tw-margin-row">
        <span class="tw-margin-name">融資餘額</span>
        <span class="tw-margin-val">${margin.marginBalanceBillions != null ? margin.marginBalanceBillions.toFixed(1) + " 億元" : "—"}</span>
      </div>
      <div class="tw-margin-row">
        <span class="tw-margin-name">融資日變化</span>
        <span class="tw-margin-val" style="color:${balCol}">${fmt(margin.marginChangeBillions, " 億元")}</span>
      </div>
      <div class="tw-margin-row">
        <span class="tw-margin-name">融券餘額</span>
        <span class="tw-margin-val">${margin.shortBalanceKShares != null ? margin.shortBalanceKShares.toLocaleString() + " 千股" : "—"}</span>
      </div>
      <div class="tw-margin-row">
        <span class="tw-margin-name">融券日變化</span>
        <span class="tw-margin-val" style="color:${shortCol}">${fmt(margin.shortChangeKShares, " 千股", 0)}</span>
      </div>
    </div>
    <div class="tw-data-note">資料日期：${margin.dataDate ?? "—"}</div>`;
}

// ── 渲染：TAIEX 技術面 ────────────────────────────────────────────
function renderTaiex(taiex) {
  if (!taiex?.available) {
    return `<p style="color:#475569">TAIEX 資料不可用</p>`;
  }

  const maDir = { bullish: "多頭排列", bearish: "空頭排列", neutral: "中性" }[taiex.maDirection] ?? "—";
  const maDirCol = taiex.maDirection === "bullish" ? "#4ade80" : taiex.maDirection === "bearish" ? "#f87171" : "#94a3b8";
  const momCol = taiex.momentum5d > 0 ? "#4ade80" : taiex.momentum5d < 0 ? "#f87171" : "#94a3b8";

  // 迷你走勢（文字版，10 根蠟燭方向）
  const candles = (taiex.recentCandles ?? []);
  const miniChart = candles.length >= 2
    ? candles.slice(-8).map((c, i, arr) => {
        if (i === 0) return "";
        return arr[i].close >= arr[i-1].close ? "▲" : "▼";
      }).filter(Boolean).join(" ")
    : "";

  return `
    <div class="tw-taiex-grid">
      <div class="tw-margin-row"><span class="tw-margin-name">5日均線</span><span class="tw-margin-val">${taiex.ma5 != null ? taiex.ma5.toLocaleString() : "—"}</span></div>
      <div class="tw-margin-row"><span class="tw-margin-name">20日均線</span><span class="tw-margin-val">${taiex.ma20 != null ? taiex.ma20.toLocaleString() : "—"}</span></div>
      <div class="tw-margin-row"><span class="tw-margin-name">均線方向</span><span class="tw-margin-val" style="color:${maDirCol}">${maDir}</span></div>
      <div class="tw-margin-row"><span class="tw-margin-name">近5日動能</span><span class="tw-margin-val" style="color:${momCol}">${fmt(taiex.momentum5d, "%")}</span></div>
    </div>
    ${miniChart ? `<div class="tw-mini-chart">${miniChart}</div>` : ""}
    <div class="tw-data-note">資料日期：${taiex.dataDate ?? "—"}</div>`;
}

// ── 主渲染 ────────────────────────────────────────────────────────
export function renderTaiwan(data, history = []) {
  const el = document.getElementById("taiwan-section");
  if (!el) return;

  if (!data) {
    el.innerHTML = `
      <div class="section-header"><h2>台股進出場時機</h2></div>
      <div class="tw-empty">
        <p>尚無台股資料。請先執行：<code>node v1/scripts/update-taiwan.mjs</code></p>
      </div>`;
    return;
  }

  const { composite, institutional, margin, taiex, dataDate, generatedAt } = data;

  const updatedAgo = generatedAt ? (() => {
    const mins = Math.round((Date.now() - new Date(generatedAt).getTime()) / 60000);
    if (mins < 60)   return `${mins} 分鐘前`;
    if (mins < 1440) return `${Math.floor(mins/60)} 小時前`;
    return `${Math.floor(mins/1440)} 天前`;
  })() : "—";

  el.innerHTML = `
    <div class="section-header">
      <h2>台股進出場時機</h2>
      <span class="tw-updated">更新：${updatedAgo}</span>
    </div>

    ${renderScoreCard(composite, taiex, dataDate, history)}
    ${renderHistoryChart(history)}

    <div class="tw-panels-grid">
      <div class="tw-panel">
        <div class="tw-panel-title">因子評分明細</div>
        ${renderFactors(composite?.factors)}
      </div>
      <div class="tw-panel">
        <div class="tw-panel-title">三大法人資金流</div>
        ${renderInstitutional(institutional)}
      </div>
      <div class="tw-panel">
        <div class="tw-panel-title">融資融券</div>
        ${renderMargin(margin)}
      </div>
      <div class="tw-panel">
        <div class="tw-panel-title">TAIEX 技術面</div>
        ${renderTaiex(taiex)}
      </div>
    </div>`;

  // 設定 innerHTML 後才能取得 canvas，此處同步執行沒問題
  drawHistoryChart(history);
}
