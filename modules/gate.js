/**
 * gate.js — Gate 評分計算 + 水平條形圖渲染
 * computeGateScores：從 dashboardData + state.coinglassCache 計算 7 維度分數
 * renderGate：渲染左側面板 + Chart.js 條形圖
 */

import { state } from './state.js';

let compositeHistoryChart = null;
import { cgSeries, cgLatest, cgPrevious, cgPositions } from './data.js';
import { toNumber } from './utils.js';

let gateChart = null;

export function computeGateScores(data) {
  const clamp = v => Math.max(-3, Math.min(3, Math.round(v)));
  const diff2score = (d, cap = 2) => Math.max(-cap, Math.min(cap, d >= 2 ? cap : d <= -2 ? -cap : d));

  // 1. 市場趨勢總覽：short/mid/long trend (-3~+3)
  const ov = data.marketOverview || {};
  const ts = t => t === '偏漲' ? 1 : t === '偏跌' ? -1 : 0;
  const trend = clamp(ts(ov.shortTermTrend) + ts(ov.midTermTrend) + ts(ov.longTermTrend));

  // 2. 市場情緒：Fear & Greed + 全市場多空比（Coinglass）
  const fng = Number(data.marketIntel?.sentiment?.fearGreedValue ?? 50);
  let sentiment = fng <= 20 ? -3 : fng <= 35 ? -2 : fng <= 45 ? -1 :
                  fng <= 55 ?  0 : fng <= 65 ?  1 : fng <= 80 ?  2 : 3;
  if (state.coinglassCache) {
    const globalSeries = cgSeries(state.coinglassCache, 'globalLongShortAccountRatio', 'Binance:BTCUSDT');
    const globalRatio = toNumber(cgLatest(globalSeries)?.longShortRatio);
    if (globalRatio !== null) {
      if (globalRatio > 1.3) sentiment = clamp(sentiment + 1);
      else if (globalRatio < 0.77) sentiment = clamp(sentiment - 1);
    }
  }

  // 3. 宏觀變數：CPI + NFP + FOMC 利率方向（只取 90 天內）
  let macro = 0;
  const macroEvents = data.macroEvents || [];
  const cutoffMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const recentCpi  = macroEvents.filter(e => e.eventType === 'cpi' && e.status === 'recent' && new Date(e.datetime).getTime() > cutoffMs)
    .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))[0];
  const recentNfp  = macroEvents.filter(e => e.eventType === 'nfp' && e.status === 'recent' && new Date(e.datetime).getTime() > cutoffMs)
    .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))[0];
  const recentFomc = macroEvents.filter(e => e.eventType === 'central-bank' && e.country === 'US' && e.status === 'recent' && new Date(e.datetime).getTime() > cutoffMs)
    .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))[0];
  if (recentCpi?.result?.shortTermBias === '偏漲') macro += 1;
  else if (recentCpi?.result?.shortTermBias === '偏跌') macro -= 1;
  if (recentNfp?.result?.shortTermBias === '偏漲') macro += 1;
  else if (recentNfp?.result?.shortTermBias === '偏跌') macro -= 1;
  const rateA = toNumber(recentFomc?.result?.actual);
  const rateP = toNumber(recentFomc?.result?.previous);
  if (rateA !== null && rateP !== null) {
    if (rateA < rateP) macro += 1; else if (rateA > rateP) macro -= 1;
  }

  // 4. 資金流向：7D ETF 淨流（Coinglass）+ OI 變化 + 穩定幣供應
  let flow = 0;
  const etf7d = toNumber(data.coinglassDerivatives?.etfFlow7d?.netUsd);
  if (etf7d !== null) {
    if (etf7d > 500e6) flow += 2; else if (etf7d > 200e6) flow += 1;
    else if (etf7d < -500e6) flow -= 2; else if (etf7d < -200e6) flow -= 1;
  } else if (state.coinglassCache) {
    const btcEtfLatest = cgLatest(cgSeries(state.coinglassCache, 'etfFlowHistory', 'bitcoin'));
    const btcEtfFlow = (btcEtfLatest?.etfFlows ?? []).reduce((s, f) => s + (toNumber(f.flowUsd) ?? 0), 0);
    if (btcEtfFlow > 500e6) flow += 2; else if (btcEtfFlow > 200e6) flow += 1;
    else if (btcEtfFlow < -500e6) flow -= 2; else if (btcEtfFlow < -200e6) flow -= 1;
  } else {
    const etf = Number(data.cryptoSignalMetrics7d?.etfNetFlowUsd ?? 0);
    if (etf > 500e6) flow += 2; else if (etf > 200e6) flow += 1;
    else if (etf < -500e6) flow -= 2; else if (etf < -200e6) flow -= 1;
  }
  if (state.coinglassCache) {
    const btcOiSeries = cgSeries(state.coinglassCache, 'openInterestAggregated', 'BTC');
    const btcOiLatest = toNumber(cgLatest(btcOiSeries)?.closeUsd) ?? 0;
    const btcOiPrev   = toNumber(cgPrevious(btcOiSeries)?.closeUsd) ?? 0;
    const oiChange = btcOiLatest - btcOiPrev;
    if (oiChange > 1e9) flow += 1; else if (oiChange < -1e9) flow -= 1;
  }
  const sc = Number(data.cryptoSignalMetrics7d?.stablecoinSupplyChangeUsd ?? 0);
  if (sc > 0) flow += 1; else if (sc < 0) flow -= 1;

  // 5. 槓桿大戶風險：7D 清算量（Coinglass 聚合）+ Funding Rate
  let leverage = 0;
  const liq7d = toNumber(data.coinglassDerivatives?.liquidation7d?.totalUsd);
  if (liq7d !== null && liq7d > 0) {
    leverage = liq7d > 2000e6 ? -3 : liq7d > 1000e6 ? -2 : liq7d > 400e6 ? -1 : liq7d > 150e6 ? 0 : 1;
  } else if (state.coinglassCache) {
    const btcLiqSeries = cgSeries(state.coinglassCache, 'aggregatedLiquidation', 'BTC');
    const ethLiqSeries = cgSeries(state.coinglassCache, 'aggregatedLiquidation', 'ETH');
    const sum7 = (s) => s.slice(-42).reduce((a, b) => a + (toNumber(b.totalLiquidationUsd) ?? 0), 0);
    const totalLiq = sum7(btcLiqSeries) + sum7(ethLiqSeries);
    leverage = totalLiq > 2000e6 ? -3 : totalLiq > 1000e6 ? -2 : totalLiq > 400e6 ? -1 : totalLiq > 150e6 ? 0 : 1;
  } else {
    const liq = Number(data.cryptoSignalMetrics7d?.liquidationTotalUsd ?? 0);
    leverage = liq > 2000e6 ? -3 : liq > 1000e6 ? -2 : liq > 400e6 ? -1 : liq > 150e6 ? 0 : 1;
  }
  if (state.coinglassCache) {
    const fundingSeries = cgSeries(state.coinglassCache, 'fundingRate', 'Binance:BTCUSDT');
    const fundingPct = (toNumber(cgLatest(fundingSeries)?.close) ?? 0) * 100;
    if (fundingPct > 0.1) leverage = clamp(leverage - 2);
    else if (fundingPct > 0.05) leverage = clamp(leverage - 1);
    else if (fundingPct < -0.05) leverage = clamp(leverage + 1);
  }

  // 6. 巨鯨走向：Hyperliquid 大戶倉位（Coinglass），fallback 到 whaleTrend
  let whaleScore = 0;
  const positions = state.coinglassCache ? cgPositions(state.coinglassCache) : [];
  if (positions.length > 0) {
    let longVal = 0, shortVal = 0;
    for (const pos of positions) {
      const size = toNumber(pos?.positionSize) ?? 0;
      const val  = toNumber(pos?.positionValueUsd) ?? 0;
      if (size > 0) longVal += val; else shortVal += val;
    }
    const total = longVal + shortVal;
    if (total > 0) {
      const longRatio = longVal / total;
      whaleScore = longRatio > 0.65 ? 2 : longRatio > 0.55 ? 1 :
                   longRatio < 0.35 ? -2 : longRatio < 0.45 ? -1 : 0;
    }
  } else {
    const whale = data.whaleTrend || {};
    const whaleDiff = Number(whale.bull ?? 0) - Number(whale.bear ?? 0);
    whaleScore = diff2score(whaleDiff);
  }

  // 7. 政策監管：policySignals 偏漲 vs 偏跌
  const pol = data.policySignals || [];
  const polDiff = pol.filter(s => s.shortTermBias === '偏漲').length -
                  pol.filter(s => s.shortTermBias === '偏跌').length;
  const policy = diff2score(polDiff);

  // 8. 外部風險：globalRiskSignals 偏漲 vs 偏跌
  const risks = data.globalRiskSignals || [];
  const riskDiff = risks.filter(s => s.shortTermBias === '偏漲').length -
                   risks.filter(s => s.shortTermBias === '偏跌').length;
  const risk = clamp(riskDiff >= 2 ? 2 : riskDiff === 1 ? 1 :
               riskDiff <= -3 ? -3 : riskDiff === -2 ? -2 : riskDiff === -1 ? -1 : 0);

  // 9. 以太坊預測市場（Polymarket）
  let polyScore = 0;
  if (state.polymarketMarketsCache?.length > 0) {
    let bull = 0, bear = 0;
    for (const m of state.polymarketMarketsCache) {
      const yes = m.outcomes?.find(o => o.label?.toLowerCase() === 'yes');
      const yp = yes?.probability ?? 50;
      const isDown = /dip|drop|fall|below/i.test(m.question || '');
      if (isDown) {
        if (yp > 65) bear += 2; else if (yp > 55) bear += 1;
        else if (yp < 35) bull += 1;
      } else {
        if (yp > 65) bull += 2; else if (yp > 55) bull += 1;
        else if (yp < 35) bear += 1;
      }
    }
    polyScore = clamp(diff2score(bull - bear, 3));
  }

  return {
    trend:      clamp(trend),
    sentiment:  clamp(sentiment),
    macro:      clamp(macro),
    flow:       clamp(flow),
    leverage:   clamp(leverage),
    whale:      clamp(whaleScore),
    policy:     clamp(policy),
    risk:       clamp(risk),
    polymarket: clamp(polyScore),
  };
}

export function renderGate(data) {
  if (!state.coinglassCache) {
    const panel = document.getElementById('gate-summary');
    if (panel) panel.innerHTML = '<p style="color:#94a3b8;padding:8px 0;">Coinglass 資料載入中...</p>';
    return;
  }
  const scores = computeGateScores(data);
  const dims   = ['市場情緒', '宏觀變數', '資金流向', '槓桿大戶風險', '巨鯨走向', '政策監管', '外部風險'];
  const values = [scores.sentiment, scores.macro, scores.flow, scores.leverage, scores.whale, scores.policy, scores.risk];
  const avg    = values.reduce((a, b) => a + b, 0) / values.length;

  let gateLabel, gateColor, gateEmoji;
  if      (avg >= 1.5)  { gateLabel = '全開 — 多頭環境';  gateColor = '#34d399'; gateEmoji = '🟢'; }
  else if (avg >= 0.5)  { gateLabel = '偏開 — 謹慎偏多'; gateColor = '#86efac'; gateEmoji = '🟢'; }
  else if (avg > -0.5)  { gateLabel = '半開 — 震盪觀望'; gateColor = '#fbbf24'; gateEmoji = '🟡'; }
  else if (avg > -1.5)  { gateLabel = '偏關 — 謹慎偏空'; gateColor = '#f87171'; gateEmoji = '🔴'; }
  else                  { gateLabel = '全關 — 空頭環境';  gateColor = '#ef4444'; gateEmoji = '🔴'; }

  // ── 左側面板：總評 + 等級說明 ──────────────────────────────────
  document.getElementById('gate-summary').innerHTML = `
    <div class="gate-status" style="color:${gateColor}">${gateEmoji} ${gateLabel}</div>
    <div class="gate-avg">平均分：<strong style="color:${gateColor}">${avg >= 0 ? '+' : ''}${avg.toFixed(1)}</strong> / 3</div>
    <div class="gate-legend">
      <div class="gate-legend-title">閘門等級說明</div>
      <div class="gate-legend-rows">
        <div class="gate-legend-row ${avg >= 1.5 ? 'gate-legend-active' : ''}" style="border-left:3px solid #34d399">
          <span class="gate-legend-dot" style="background:#34d399"></span>
          <span class="gate-legend-name">全開</span>
          <span class="gate-legend-range">≥ +1.5</span>
          <span class="gate-legend-desc">多頭環境，積極做多</span>
        </div>
        <div class="gate-legend-row ${avg >= 0.5 && avg < 1.5 ? 'gate-legend-active' : ''}" style="border-left:3px solid #86efac">
          <span class="gate-legend-dot" style="background:#86efac"></span>
          <span class="gate-legend-name">偏開</span>
          <span class="gate-legend-range">+0.5 ～ +1.5</span>
          <span class="gate-legend-desc">偏多，謹慎做多</span>
        </div>
        <div class="gate-legend-row ${avg > -0.5 && avg < 0.5 ? 'gate-legend-active' : ''}" style="border-left:3px solid #fbbf24">
          <span class="gate-legend-dot" style="background:#fbbf24"></span>
          <span class="gate-legend-name">半開</span>
          <span class="gate-legend-range">-0.5 ～ +0.5</span>
          <span class="gate-legend-desc">震盪觀望，不宜重倉</span>
        </div>
        <div class="gate-legend-row ${avg <= -0.5 && avg > -1.5 ? 'gate-legend-active' : ''}" style="border-left:3px solid #f87171">
          <span class="gate-legend-dot" style="background:#f87171"></span>
          <span class="gate-legend-name">偏關</span>
          <span class="gate-legend-range">-1.5 ～ -0.5</span>
          <span class="gate-legend-desc">偏空，謹慎做空</span>
        </div>
        <div class="gate-legend-row ${avg <= -1.5 ? 'gate-legend-active' : ''}" style="border-left:3px solid #ef4444">
          <span class="gate-legend-dot" style="background:#ef4444"></span>
          <span class="gate-legend-name">全關</span>
          <span class="gate-legend-range">≤ -1.5</span>
          <span class="gate-legend-desc">空頭環境，避免進場</span>
        </div>
      </div>
    </div>
  `;

  // ── 右側：水平條形圖（+3 多 / -3 空）──────────────────────────
  const barColors = values.map(v =>
    v > 0 ? 'rgba(52,211,153,0.72)' : v < 0 ? 'rgba(248,113,113,0.72)' : 'rgba(251,191,36,0.55)'
  );
  const borderColors = values.map(v =>
    v > 0 ? '#34d399' : v < 0 ? '#f87171' : '#fbbf24'
  );

  const canvasEl = document.getElementById('gate-bar');
  if (!canvasEl) return;
  const ctx = canvasEl.getContext('2d');
  if (gateChart) gateChart.destroy();

  const scoreLabelPlugin = {
    id: 'scoreLabels',
    afterDatasetsDraw(chart) {
      const { ctx: c, scales } = chart;
      const meta = chart.getDatasetMeta(0);
      values.forEach((v, i) => {
        const bar = meta.data[i];
        if (!bar) return;
        const xZero = scales.x.getPixelForValue(0);
        const y = bar.y;
        const sign = v > 0 ? '+' : '';
        const color = v > 0 ? '#34d399' : v < 0 ? '#f87171' : '#94a3b8';
        const label = `${sign}${v}`;
        c.save();
        c.fillStyle = color;
        c.font = 'bold 12px "Segoe UI", system-ui, sans-serif';
        c.textAlign = v < 0 ? 'right' : 'left';
        const offsetX = v < 0 ? xZero - 6 : xZero + 6;
        c.fillText(label, offsetX, y + 4);
        c.restore();
      });
    }
  };

  gateChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: dims,
      datasets: [{
        data: values,
        backgroundColor: barColors,
        borderColor: borderColors,
        borderWidth: 1,
        borderRadius: 4,
        barThickness: 24,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          min: -3, max: 3,
          ticks: {
            stepSize: 1,
            color: '#64748b',
            font: { size: 11 },
            callback: v => v > 0 ? `+${v}` : String(v)
          },
          grid: {
            color: ctx => ctx.tick.value === 0 ? 'rgba(100,116,139,0.6)' : 'rgba(51,65,85,0.35)'
          },
          border: { color: '#334155' }
        },
        y: {
          ticks: {
            color: '#94a3b8',
            font: { size: 13, family: "'Microsoft JhengHei', 'Segoe UI', system-ui, sans-serif" }
          },
          grid: { display: false },
          border: { display: false }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.raw;
              const sign = v > 0 ? '+' : '';
              const desc = v >= 2 ? '強多' : v === 1 ? '偏多' : v === 0 ? '中性' : v === -1 ? '偏空' : '強空';
              return ` ${sign}${v}  (${desc})`;
            }
          }
        }
      }
    },
    plugins: [scoreLabelPlugin]
  });

  // ── Composite Score 面板 ─────────────────────────────────────────
  renderCompositePanel(data);
}

function renderCompositePanel(data) {
  const el = document.getElementById('gate-composite');
  if (!el) return;

  const cs = data?.compositeScore;
  const fd = data?.factorDelta;

  // ── Composite Score 卡片 ─────────────────────────────────────
  let csHtml = '';
  if (cs) {
    const score = Number(cs.score);
    const color = score >= 0.4  ? '#34d399'
                : score >= 0.15 ? '#86efac'
                : score <= -0.4 ? '#ef4444'
                : score <= -0.15 ? '#f87171'
                : '#fbbf24';
    const sign = score >= 0 ? '+' : '';
    const coveragePct = cs.coverage_pct ?? ((cs.coverage / cs.total_factors) * 100).toFixed(1);
    csHtml = `
      <div class="composite-card">
        <div class="composite-title">Factor Composite Score</div>
        <div class="composite-score" style="color:${color}">${sign}${score.toFixed(3)}</div>
        <div class="composite-label" style="color:${color}">${cs.label}</div>
        <div class="composite-coverage">因子覆蓋率 ${cs.coverage}/${cs.total_factors}（${coveragePct}%）</div>
      </div>`;
  }

  // ── Factor Delta 面板 ─────────────────────────────────────────
  let fdHtml = '';
  if (fd && fd.count > 0) {
    const rows = fd.changed.slice(0, 6).map(c => {
      const diff = c.score_diff !== null ? (c.score_diff >= 0 ? `+${c.score_diff.toFixed(3)}` : c.score_diff.toFixed(3)) : '—';
      const diffColor = c.score_diff > 0 ? '#34d399' : c.score_diff < 0 ? '#f87171' : '#94a3b8';
      const tag = c.direction_changed
        ? `<span class="fd-tag fd-tag-dir">${c.prev_direction} → ${c.curr_direction}</span>`
        : `<span class="fd-tag fd-tag-move">大幅跳變</span>`;
      return `<div class="fd-row">
        <span class="fd-key">${c.factor}</span>
        <span class="fd-diff" style="color:${diffColor}">${diff}</span>
        ${tag}
      </div>`;
    }).join('');
    fdHtml = `
      <div class="fd-card">
        <div class="fd-title">Factor 變動 <span class="fd-count">${fd.count} 項</span></div>
        ${rows}
      </div>`;
  } else if (fd && fd.count === 0) {
    fdHtml = `<div class="fd-card"><div class="fd-title">Factor 變動</div><div class="fd-empty">本次無顯著因子變化</div></div>`;
  }

  el.innerHTML = csHtml + fdHtml;
  renderCompositeHistoryChart();
}

function renderCompositeHistoryChart() {
  const history = state.compositeHistory;
  const wrap = document.getElementById('gate-composite-history');
  const canvas = document.getElementById('gate-composite-chart');
  if (!wrap || !canvas) return;

  if (!Array.isArray(history) || history.length < 2) {
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = 'block';

  const labels = history.map(h => {
    const d = new Date(h.t);
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  });
  const scores = history.map(h => Number(h.s));
  const pointColors = scores.map(s =>
    s >= 0.4  ? '#34d399' : s >= 0.15 ? '#86efac'
  : s <= -0.4 ? '#ef4444' : s <= -0.15 ? '#f87171'
  : '#fbbf24'
  );

  if (compositeHistoryChart) {
    compositeHistoryChart.destroy();
    compositeHistoryChart = null;
  }

  compositeHistoryChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: scores,
        borderColor: '#38bdf8',
        borderWidth: 1.5,
        pointRadius: 2,
        pointBackgroundColor: pointColors,
        fill: false,
        tension: 0.3
      }]
    },
    options: {
      animation: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: {
          label: ctx => {
            const h = history[ctx.dataIndex];
            const sign = ctx.parsed.y >= 0 ? '+' : '';
            return `${sign}${ctx.parsed.y.toFixed(3)}  ${h?.l || ''}`;
          }
        }
      }},
      scales: {
        x: { ticks: { color: '#64748b', font: { size: 10 }, autoSkip: false,
          callback: function(val, idx) {
            const d = new Date(history[idx]?.t);
            return d.getMinutes() === 0 ? `${d.getHours().toString().padStart(2,'0')}:00` : '';
          }
        }, grid: { color: '#1e293b', drawOnChartArea: true,
          tickColor: ctx => {
            const d = new Date(history[ctx.index]?.t);
            return d?.getMinutes() === 0 ? '#1e3a5f' : 'transparent';
          }
        } },
        y: {
          min: -1, max: 1,
          ticks: { color: '#64748b', font: { size: 10 }, stepSize: 0.5 },
          grid: { color: '#1e293b' }
        }
      }
    }
  });
}
