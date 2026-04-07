/**
 * polymarket.js — ETH 預測市場（Polymarket）
 * initPolymarket：fetch 資料並渲染，回傳 boolean（success）
 * renderPolymarket：依 markets 陣列渲染 K 線卡片
 */

import { state } from './state.js';

function translatePolymarketQuestion(q) {
  const MONTHS = {
    January: "1月", February: "2月", March: "3月", April: "4月",
    May: "5月", June: "6月", July: "7月", August: "8月",
    September: "9月", October: "10月", November: "11月", December: "12月"
  };
  const toZhDate = (s) => s.replace(/(\w+)\s+(\d+)/g, (_, m, d) => `${MONTHS[m] || m} ${d} 日`);

  let r;
  r = q.match(/Will (?:the price of )?Ethereum (?:dip|drop|fall) to \$([\d,]+)(?: in (\w+)| by (.+?))?[?？]?$/i);
  if (r) return `以太坊${r[2] || r[3] ? `在 ${r[2] || toZhDate(r[3])}` : ""}內會跌至 $${r[1]} 嗎？`;

  r = q.match(/Will (?:the price of )?Ethereum (?:reach|hit|exceed|surpass|touch) \$([\d,]+)(?: in (\w+)| by (.+?))?[?？]?$/i);
  if (r) return `以太坊${r[2] ? `在 ${r[2]}` : r[3] ? `在 ${toZhDate(r[3])} 前` : ""}會漲至 $${r[1]} 嗎？`;

  r = q.match(/Will the price of Ethereum be above \$([\d,]+) on (.+?)[?？]?$/i);
  if (r) return `以太坊在 ${toZhDate(r[2])} 的價格會高於 $${r[1]} 嗎？`;

  r = q.match(/Will the price of Ethereum be between \$([\d,]+) and \$([\d,]+) on (.+?)[?？]?$/i);
  if (r) return `以太坊在 ${toZhDate(r[3])} 的價格會介於 $${r[1]}–$${r[2]} 之間嗎？`;

  r = q.match(/Will the price of Ethereum be greater than \$([\d,]+) on (.+?)[?？]?$/i);
  if (r) return `以太坊在 ${toZhDate(r[2])} 的價格會高於 $${r[1]} 嗎？`;

  r = q.match(/Ethereum all.?time high by (.+?)[?？]?$/i);
  if (r) return `以太坊會在 ${toZhDate(r[1])} 前創歷史新高嗎？`;

  r = q.match(/Ethereum Up or Down[\s\-–]+(.+)/i);
  if (r) return `以太坊漲跌預測（${r[1].trim()}）`;

  return q;
}

function aggregatePmOHLCV(data, mins) {
  if (mins <= 1) return data;
  const secs = mins * 60;
  const buckets = {};
  for (const c of data) {
    const key = Math.floor(c.time / secs) * secs;
    if (!buckets[key]) buckets[key] = { time: key, open: c.open, high: c.high, low: c.low, close: c.close };
    else {
      if (c.high > buckets[key].high) buckets[key].high = c.high;
      if (c.low  < buckets[key].low)  buckets[key].low  = c.low;
      buckets[key].close = c.close;
    }
  }
  return Object.values(buckets).sort((a, b) => a.time - b.time);
}

export function renderPolymarket(markets) {
  const root = document.getElementById("polymarket-cards");
  root.innerHTML = "";

  if (!markets || markets.length === 0) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = "<h3>目前無法載入預測市場資料</h3><p>請先執行 node scripts/polymarket_eth.mjs 產生資料檔。</p>";
    root.appendChild(card);
    return;
  }

  const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

  markets.forEach((m) => {
    const yes     = m.outcomes.find((o) => o.label.toLowerCase() === "yes");
    const no      = m.outcomes.find((o) => o.label.toLowerCase() === "no");
    const yesProb = yes?.probability ?? null;
    const noProb  = no?.probability  ?? null;

    const barColor = yesProb !== null
      ? (yesProb >= 60 ? "var(--ok)" : yesProb <= 40 ? "var(--danger)" : "var(--accent)")
      : "var(--muted)";

    const probBar = yesProb !== null
      ? `<div style="margin:8px 0 4px;background:#1f2937;border-radius:4px;height:8px;overflow:hidden">
           <div style="width:${yesProb}%;height:100%;background:${barColor};transition:width .3s"></div>
         </div>
         <div class="kv">
           <div style="color:${barColor}">是（Yes）${yesProb}%</div>
           ${noProb !== null ? `<div style="color:var(--muted)">否（No）${noProb}%</div>` : ""}
         </div>`
      : "";

    const endStr    = m.endDate ? `到期：${new Date(m.endDate).toLocaleDateString("zh-Hant")}` : "";
    const volStr    = m.volume24hr > 0 ? `24h 成交量：${fmtUsd.format(m.volume24hr)}` : "";
    const zhQuestion = translatePolymarketQuestion(m.question);
    const chartId   = `pm-chart-${m.id}`;
    const hasChart  = m.ohlcv && m.ohlcv.length > 1;

    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3><a href="${m.url}" target="_blank" rel="noreferrer">${zhQuestion}</a></h3>
      ${probBar}
      <div class="kv" style="font-size:13px;color:var(--muted);margin-top:6px">
        ${volStr ? `<div>${volStr}</div>` : ""}
        ${endStr ? `<div>${endStr}</div>` : ""}
      </div>
      ${hasChart
        ? `<div style="display:flex;align-items:center;gap:6px;margin-top:10px">
             <span style="font-size:12px;color:var(--muted)">K 線週期：</span>
             ${[1, 5, 15].map((n) =>
               `<button class="pm-iv-btn" data-mins="${n}" data-chart="${chartId}"
                  style="padding:2px 10px;border:1px solid #334155;border-radius:5px;cursor:pointer;font-size:12px;
                         background:${n === 1 ? "var(--accent)" : "#1f2937"};
                         color:${n === 1 ? "#0f172a" : "var(--muted)"}">${n}m</button>`
             ).join("")}
           </div>
           <div id="${chartId}" style="height:180px;margin-top:6px;border-radius:6px;overflow:hidden"></div>`
        : ""}
    `;
    root.appendChild(card);

    if (hasChart && typeof LightweightCharts !== "undefined") {
      requestAnimationFrame(() => {
        const el = document.getElementById(chartId);
        if (!el) return;
        const chart = LightweightCharts.createChart(el, {
          width: el.clientWidth || 400,
          height: 180,
          layout: { background: { color: "#0f172a" }, textColor: "#94a3b8" },
          grid: { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
          crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
          rightPriceScale: { borderColor: "#1f2937" },
          timeScale: { borderColor: "#1f2937", timeVisible: true, secondsVisible: false },
        });
        const series = chart.addCandlestickSeries({
          upColor: "#22c55e", downColor: "#fb7185",
          borderUpColor: "#22c55e", borderDownColor: "#fb7185",
          wickUpColor: "#22c55e", wickDownColor: "#fb7185",
        });
        series.setData(m.ohlcv);
        chart.timeScale().fitContent();
        new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth })).observe(el);

        card.querySelectorAll(".pm-iv-btn").forEach((btn) => {
          btn.addEventListener("click", () => {
            const mins = Number(btn.dataset.mins);
            card.querySelectorAll(".pm-iv-btn").forEach((b) => {
              b.style.background = Number(b.dataset.mins) === mins ? "var(--accent)" : "#1f2937";
              b.style.color      = Number(b.dataset.mins) === mins ? "#0f172a"       : "var(--muted)";
            });
            series.setData(aggregatePmOHLCV(m.ohlcv, mins));
            chart.timeScale().fitContent();
          });
        });
      });
    }
  });
}

export async function initPolymarket() {
  try {
    const resp = await fetch("./data/polymarket_eth.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    state.polymarketMarketsCache = data.markets || [];
    renderPolymarket(state.polymarketMarketsCache);
    return true;
  } catch {
    renderPolymarket([]);
    return false;
  }
}
