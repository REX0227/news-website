/**
 * app.js — 主入口（精簡版）
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
import { initPolymarket }                                     from './modules/polymarket.js';
import { fetchJin10Live, fetchJin10History,
         renderJin10Live, renderJin10History }                from './modules/jin10.js';

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

// ── Bootstrap ────────────────────────────────────────────────────
async function bootstrap() {
  try {
    const data = await loadData();
    state.dashboardData = data;
    bindControls();
    renderAll(data);
  } catch (error) {
    document.body.innerHTML = `<main class="container"><h1>資料載入失敗</h1><p>${error.message}</p></main>`;
  }
}

// ── Auto refresh ─────────────────────────────────────────────────
async function autoRefresh() {
  try {
    const data = await loadData();
    state.dashboardData = data;
    renderAll(data);
  } catch (_) {
    // 靜默失敗，等下次輪詢
  }
}

// ── Coinglass refresh（fetch 後觸發 Gate 重繪）───────────────────
async function refreshCoinglass() {
  await fetchCoinglass();
  if (state.dashboardData) renderGate(state.dashboardData);
}

// ── Composite history refresh ─────────────────────────────────────
async function refreshCompositeHistory() {
  const history = await fetchCompositeHistory();
  state.compositeHistory = history;
  if (state.dashboardData) renderGate(state.dashboardData);
}

// ── Jin10 快訊 ────────────────────────────────────────────────────
async function refreshJin10Live() {
  const result = await fetchJin10Live();
  renderJin10Live(result);
}

async function initJin10() {
  // 頁面載入：先拉歷史，再拉即時
  const [hist, live] = await Promise.all([fetchJin10History(100), fetchJin10Live()]);
  renderJin10History(hist);
  renderJin10Live(live);
}

// ── Entry point ───────────────────────────────────────────────────
const POLL_INTERVAL     = 2 * 60 * 1000;  // 2 分鐘（主資料）
const JIN10_POLL        = 60 * 1000;      // 1 分鐘（即時快訊）

bootstrap();
refreshCoinglass();
refreshCompositeHistory();
initPolymarket().then(() => {
  if (state.dashboardData) renderGate(state.dashboardData);
});
initJin10();

setInterval(autoRefresh,             POLL_INTERVAL);
setInterval(refreshCoinglass,        POLL_INTERVAL);
setInterval(refreshCompositeHistory, POLL_INTERVAL);
setInterval(refreshJin10Live,        JIN10_POLL);
