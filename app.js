/**
 * app.js — 主入口
 * 負責：renderAll、bootstrap、autoRefresh、Tab 切換、Coinglass 輪詢
 * 所有業務邏輯已分拆至 modules/ 各模組
 */

import { state }                                              from './modules/state.js';
import { loadData, fetchCoinglass, fetchCompositeHistory }    from './modules/data.js';
import { renderGate }                                         from './modules/gate.js';
import { renderMeta, renderOverallTrend, renderOverview }     from './modules/overview.js';
import { renderPolicySignals, renderAi, renderWindows,
         renderMacro, renderSignals, renderWhale,
         renderGlobalRisks }                                  from './modules/signals.js';

// ── Regime / Comment ─────────────────────────────────────────────
const API_BASE = window.location.origin + "/api";

async function fetchComment() {
  const res = await fetch(`${API_BASE}/comment`);
  if (!res.ok) return null;
  return res.json();
}

function renderRegime(comment) {
  const el = document.getElementById("regime-panel");
  if (!el) return;
  if (!comment || !comment.macro_regime) {
    el.innerHTML = '<p style="color:#475569">暫無 Regime 資料（pipeline 尚未執行）</p>';
    return;
  }
  const r = comment.macro_regime;
  const risk = comment.global_risk || {};
  const narrative = comment.narrative || {};

  const REGIME_LABEL_MAP = {
    easing_early:    "早期寬鬆",
    easing_late:     "晚期寬鬆",
    tightening_early:"早期收緊",
    tightening_late: "晚期收緊",
    neutral:         "中性",
    shock:           "衝擊"
  };
  const RISK_COLOR = {
    low:      "#4ade80", moderate: "#facc15",
    elevated: "#fb923c", high:     "#f87171", extreme: "#e11d48"
  };

  const regimeLabel = REGIME_LABEL_MAP[r.label] || r.label || "—";
  const riskColor = RISK_COLOR[risk.level] || "#94a3b8";
  const conf = r.confidence != null ? `${Math.round(r.confidence * 100)}%` : "—";
  const stability = r.stability_24h != null ? `${Math.round(r.stability_24h * 100)}%` : "—";
  const tailRisk = risk.tail_risk_score != null ? risk.tail_risk_score.toFixed(2) : "—";

  el.innerHTML = `
    <div class="regime-grid">
      <div>
        <div class="regime-label">Macro Regime</div>
        <div class="regime-value">${regimeLabel}</div>
      </div>
      <div>
        <div class="regime-label">置信度</div>
        <div class="regime-value">${conf}</div>
      </div>
      <div>
        <div class="regime-label">24h 穩定性</div>
        <div class="regime-value">${stability}</div>
      </div>
      <div>
        <div class="regime-label">全球風險</div>
        <div class="regime-value" style="color:${riskColor}">${risk.level || "—"}</div>
      </div>
      <div>
        <div class="regime-label">尾部風險分</div>
        <div class="regime-value">${tailRisk}</div>
      </div>
    </div>
    ${narrative.headline ? `<div class="regime-narrative">${narrative.headline}</div>` : ""}
    ${narrative.summary  ? `<div class="regime-narrative" style="margin-top:8px">${narrative.summary}</div>` : ""}
  `;
}

// ── Liquidation Monitor ──────────────────────────────────────────
async function fetchLiquidations() {
  const res = await fetch(`${API_BASE}/v2/liquidations?window=1h,24h`);
  if (!res.ok) return null;
  return res.json();
}

function renderLiquidations(data) {
  const el = document.getElementById("liq-monitor");
  if (!el) return;
  if (!data || !data.symbols || !data.has_data) {
    el.innerHTML = '<p class="liq-empty">暫無清算資料（aggregator 尚未啟動或無近期資料）</p>';
    return;
  }

  const cards = Object.values(data.symbols).map(sym => {
    const w1h  = sym.windows?.["1h"]  || {};
    const w24h = sym.windows?.["24h"] || {};

    function fmtUsd(v) {
      if (!v) return "—";
      if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
      if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
      return `$${(v / 1e3).toFixed(0)}K`;
    }
    function scoreClass(dir) {
      if (dir === "bullish") return "liq-score-bullish";
      if (dir === "bearish") return "liq-score-bearish";
      return "liq-score-neutral";
    }

    return `
      <div class="liq-card">
        <div class="liq-symbol">${sym.symbol}</div>
        <div class="liq-window-row">
          <span class="liq-window-label">1h 總清算</span>
          <span class="liq-usd">${fmtUsd(w1h.total_usd)}</span>
        </div>
        <div class="liq-window-row">
          <span class="liq-window-label">1h 多/空</span>
          <span class="${scoreClass(w1h.direction)}">${fmtUsd(w1h.long_liq_usd)} / ${fmtUsd(w1h.short_liq_usd)}</span>
        </div>
        <div class="liq-window-row">
          <span class="liq-window-label">24h 總清算</span>
          <span class="liq-usd">${fmtUsd(w24h.total_usd)}</span>
        </div>
        <div class="liq-window-row">
          <span class="liq-window-label">24h 方向</span>
          <span class="${scoreClass(w24h.direction)}">${w24h.direction || "—"}</span>
        </div>
      </div>
    `;
  }).join("");

  el.innerHTML = cards || '<p class="liq-empty">無資料</p>';
}

// ── renderAll ────────────────────────────────────────────────────
function renderAll(data) {
  renderMeta(data);
  renderGate(data);
  renderOverallTrend(data);
  renderOverview(data);
  renderAi(data);
  renderWindows(data);
  renderMacro(data);
  renderSignals(data);
  renderWhale(data);
  renderPolicySignals(data);
  renderGlobalRisks(data);
}

// ── Tab 切換 ─────────────────────────────────────────────────────
function initTabs() {
  const tabBar = document.querySelector('.tab-bar');
  if (!tabBar) return;

  tabBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const panel = document.getElementById('tab-' + target);
    if (panel) panel.classList.add('active');
  });

  const tabMap = {
    'policy-section': 'policy',
    'risk-section':   'risk',
    'whale-section':  'whale',
    'crypto-section': 'crypto'
  };
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a.overview-link');
    if (!link) return;
    const hash   = (link.getAttribute('href') || '').replace('#', '');
    const tabKey = tabMap[hash];
    if (!tabKey) return;
    const btn = document.querySelector(`.tab-btn[data-tab="${tabKey}"]`);
    if (btn) btn.click();
  });
}

// ── Controls ──────────────────────────────────────────────────────
function bindControls() {
  const checkbox = document.getElementById("only-high-impact");
  if (checkbox) {
    checkbox.addEventListener("change", (event) => {
      state.onlyHighImpact = Boolean(event.target.checked);
      if (state.dashboardData) renderAll(state.dashboardData);
    });
  }

  // 宏觀日程篩選 tab
  document.querySelector(".macro-filter-bar")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".macro-tab");
    if (!btn) return;
    document.querySelectorAll(".macro-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.macroFilter = btn.dataset.filter;
    if (state.dashboardData) renderMacro(state.dashboardData);
  });

  initTabs();
}

// ── 共用：抓取資料並全量重繪 ────────────────────────────────────
async function fetchAndRender() {
  const data = await loadData();
  state.dashboardData = data;
  renderAll(data);
}

// ── Bootstrap ────────────────────────────────────────────────────
async function bootstrap() {
  try {
    await fetchAndRender();
    bindControls();
  } catch (error) {
    const banner = document.createElement('div');
    banner.style.cssText = 'padding:1rem;background:#ff4d4f;color:#fff;text-align:center;font-weight:bold;';
    banner.textContent = `資料載入失敗：${error.message}`;
    document.body.prepend(banner);
  }
}

// ── Auto refresh ─────────────────────────────────────────────────
async function autoRefresh() {
  try {
    await fetchAndRender();
  } catch (_) {}
}

// ── Coinglass refresh（fetch 後觸發 Gate 重繪）───────────────────
async function refreshCoinglass() {
  try {
    await fetchCoinglass();
    if (state.dashboardData) renderGate(state.dashboardData);
  } catch (_) {}
}

// ── Composite history refresh ─────────────────────────────────────
async function refreshCompositeHistory() {
  try {
    const history = await fetchCompositeHistory();
    state.compositeHistory = history;
    if (state.dashboardData) renderGate(state.dashboardData);
  } catch (_) {}
}

// ── Regime refresh ────────────────────────────────────────────────
async function refreshRegime() {
  try {
    const comment = await fetchComment();
    renderRegime(comment);
  } catch (_) {}
}

// ── Liquidation refresh ───────────────────────────────────────────
async function refreshLiquidations() {
  try {
    const data = await fetchLiquidations();
    renderLiquidations(data);
  } catch (_) {}
}

// ── Entry point ───────────────────────────────────────────────────
const POLL_INTERVAL          = 2 * 60 * 1000;  // 2 分鐘（主資料）
const COINGLASS_POLL         = 2 * 60 * 1000;  // 2 分鐘（Coinglass）
const COMPOSITE_HISTORY_POLL = 2 * 60 * 1000;  // 2 分鐘（CompositeHistory）
const REGIME_POLL            = 5 * 60 * 1000;  // 5 分鐘（Regime / Comment）
const LIQ_POLL               = 2 * 60 * 1000;  // 2 分鐘（清算快照）

const bootstrapPromise = bootstrap();

bootstrapPromise
  .then(async () => {
    await Promise.allSettled([
      refreshCoinglass(),
      refreshCompositeHistory(),
      refreshRegime(),
      refreshLiquidations(),
    ]);
    if (state.dashboardData) renderGate(state.dashboardData);
  })
  .catch(() => {});

setInterval(autoRefresh,             POLL_INTERVAL);
setInterval(refreshCoinglass,        COINGLASS_POLL);
setInterval(refreshCompositeHistory, COMPOSITE_HISTORY_POLL);
setInterval(refreshRegime,           REGIME_POLL);
setInterval(refreshLiquidations,     LIQ_POLL);
