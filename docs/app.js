const fmt = new Intl.DateTimeFormat("zh-Hant", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

const IMPORTANCE_TEXT = { high: "高", medium: "中", low: "低" };
const STATUS_TEXT = { upcoming: "未來", recent: "近期 / 已公布" };
const COUNTRY_TEXT = { US: "美國", JP: "日本" };
const SIGNAL_CATEGORY_TEXT = { flow: "資金流", regulation: "監管", risk: "風險", macro: "宏觀", market: "市場" };
const SIGNAL_IMPACT_TEXT = { high: "高", medium: "中", low: "低" };

let dashboardData = null;
let onlyHighImpact = false;

function badgeClass(level = "low") {
  if (level === "high") return "badge high";
  if (level === "medium") return "badge medium";
  return "badge low";
}

function statusClass(status = "recent") {
  return status === "upcoming" ? "upcoming" : "recent";
}

function stripHtml(text = "") {
  return String(text).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function biasClass(text = "") {
  const t = String(text);
  if (/偏漲|偏多|上漲|多頭|\bup\b/i.test(t)) return "bias-up";
  if (/偏跌|偏空|下跌|空頭|\bdown\b/i.test(t)) return "bias-down";
  return "bias-side";
}

function biasSpan(text = "") {
  return `<span class="${biasClass(text)}">${text || "震盪"}</span>`;
}

function colorizeBiasWords(text = "") {
  return stripHtml(text)
    .replace(/偏漲|偏多|上漲|多頭/g, '<span class="bias-up">$&</span>')
    .replace(/偏跌|偏空|下跌|空頭/g, '<span class="bias-down">$&</span>')
    .replace(/震盪/g, '<span class="bias-side">$&</span>');
}

async function loadData() {
  const response = await fetch(`./data/latest.json?t=${Date.now()}`);
  if (!response.ok) throw new Error("無法載入最新資料");
  return response.json();
}

function renderMeta(data) {
  document.getElementById("meta").textContent = `最後更新：${fmt.format(new Date(data.generatedAt))}（UTC 來源整合）`;
}

function renderOverallTrend(data) {
  const el = document.getElementById("overall-trend");
  const overview = data.marketOverview || {};
  const summary = overview.overallSummary || "目前市場趨勢資料整理中。";
  const external = overview.externalRiskBias || "外部風險中性";
  el.innerHTML = `<strong>整體趨勢：</strong>${colorizeBiasWords(summary)}｜<strong>外部風險：</strong>${biasSpan(external)}`;
}

function renderOverview(data) {
  const root = document.getElementById("overview-cards");
  root.innerHTML = "";

  const overview = data.marketOverview || {};
  const whale = data.whaleTrend || {};
  const nextHigh = overview.nextHighImpact;

  const highRisk = (data.cryptoSignals || [])
    .filter((signal) => signal.impact === "high")
    .sort((a, b) => new Date(b.time) - new Date(a.time))[0] || null;

  const latestExternal = (data.globalRiskSignals || [])
    .sort((a, b) => new Date(b.time) - new Date(a.time))[0] || null;

  const nextEventText = nextHigh?.datetime
    ? `${fmt.format(new Date(nextHigh.datetime))} ${nextHigh.title}`
    : "未來 7 天暫無高影響事件";

  const cards = [
    {
      title: "短線總趨勢",
      valueHtml: biasSpan(overview.shortTermTrend || "短線震盪"),
      sub: "整合宏觀、外部風險、幣圈訊號"
    },
    {
      title: "下一個高影響事件",
      valueHtml: nextEventText,
      sub: nextHigh?.result?.cryptoImpact || "重點看事件前後 1-2 小時波動"
    },
    {
      title: "高風險重點",
      valueHtml: highRisk ? stripHtml(highRisk.keyChange || highRisk.zhTitle || highRisk.title) : "目前無高風險訊號",
      sub: highRisk ? `短線：${stripHtml(highRisk.shortTermBias || "震盪")}` : ""
    },
    {
      title: "外部風險重點",
      valueHtml: latestExternal ? stripHtml(latestExternal.keyChange || latestExternal.title) : "目前外部風險訊號偏少",
      sub: latestExternal ? `方向：${stripHtml(latestExternal.shortTermBias || "震盪")}` : ""
    },
    {
      title: "巨鯨風向",
      valueHtml: biasSpan(whale.trend || "中性"),
      sub: whale.summary || "無足夠資料"
    }
  ];

  cards.forEach((item) => {
    const card = document.createElement("article");
    card.className = "card";
    const subHtml = item.sub ? `<div class="kv">${colorizeBiasWords(item.sub)}</div>` : "";
    card.innerHTML = `<h3>${item.title}</h3><div class="metric">${item.valueHtml}</div>${subHtml}`;
    root.appendChild(card);
  });
}

function renderAi(data) {
  const list = document.getElementById("ai-insights");
  list.innerHTML = "";
  (data?.aiSummary?.keyInsights || []).forEach((item) => {
    const li = document.createElement("li");
    li.innerHTML = colorizeBiasWords(item);
    list.appendChild(li);
  });
}

function renderWindows(data) {
  const root = document.getElementById("key-windows");
  const note = document.getElementById("key-windows-note");
  root.innerHTML = "";

  if (!data.keyWindows || data.keyWindows.length === 0) {
    note.textContent = data.keyWindowsNote || "未來 7 天暫無高影響窗口。";
    return;
  }

  note.textContent = "";

  data.keyWindows.forEach((item) => {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3>${item.title}</h3>
      <div>${fmt.format(new Date(item.datetime))}</div>
      <div class="kv">${item.country} / ${item.why}</div>
    `;
    root.appendChild(card);
  });
}

function renderMacro(data) {
  const body = document.getElementById("macro-body");
  body.innerHTML = "";

  const now = Date.now();
  const pastWindow = 1000 * 60 * 60 * 24 * 90;
  const futureWindow = 1000 * 60 * 60 * 24 * 365;

  const visibleEvents = (data.macroEvents || []).filter((event) => {
    const t = new Date(event.datetime).getTime();
    return t >= now - pastWindow && t <= now + futureWindow;
  });

  visibleEvents.forEach((event) => {
    const hasPublished = Boolean(event.result && event.result.actual);
    const resultText = hasPublished
      ? `${event.result.actual}${event.result.unit && event.result.unit !== "-" ? ` ${event.result.unit}` : ""}`
      : "尚未公布";

    const analysisText = hasPublished ? (event.result?.analysis || "") : "等待公布後更新";

    const impactLine = hasPublished
      ? `對幣市：${event.result?.cryptoImpact || "等待補充"}｜短線：${biasSpan(event.result?.shortTermBias || "震盪")}`
      : `對幣市：待公布後判讀｜短線：${biasSpan("待確認")}`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmt.format(new Date(event.datetime))}</td>
      <td>${COUNTRY_TEXT[event.country] || event.country}</td>
      <td><a href="${event.source}" target="_blank" rel="noreferrer">${event.title}</a></td>
      <td><span class="${badgeClass(event.importance)}">${IMPORTANCE_TEXT[event.importance] || event.importance}</span></td>
      <td><span class="${statusClass(event.status)}">${STATUS_TEXT[event.status] || event.status}</span></td>
      <td>${resultText}</td>
      <td class="analysis">${analysisText}<div class="impact-inline">${impactLine}</div></td>
    `;
    body.appendChild(tr);
  });
}

function renderSignals(data) {
  const root = document.getElementById("crypto-signals");
  root.innerHTML = "";

  let signals = data.cryptoSignals || [];
  if (onlyHighImpact) signals = signals.filter((signal) => signal.impact === "high");

  signals.forEach((signal) => {
    const summary = stripHtml(signal.zhSummary || signal.summary || "");
    const impactText = stripHtml(signal.cryptoImpact || "市場影響評估中");
    const analysisText = stripHtml(signal.cryptoAnalysis || "等待更多資料補充分析");
    const changeText = stripHtml(signal.keyChange || "關鍵變化整理中");
    const shortBias = stripHtml(signal.shortTermBias || "震盪");

    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3><a href="${signal.source}" target="_blank" rel="noreferrer">${signal.zhTitle || signal.title}</a></h3>
      <div>${fmt.format(new Date(signal.time))}</div>
      <div class="kv">分類：${SIGNAL_CATEGORY_TEXT[signal.category] || signal.category} / 影響：${SIGNAL_IMPACT_TEXT[signal.impact] || signal.impact} / 短線：${biasSpan(shortBias)}</div>
      <p class="change"><strong>具體變化：</strong>${changeText}</p>
      <p>${summary}</p>
      <p class="impact"><strong>對虛擬幣影響：</strong>${impactText}</p>
      <p class="analysis-note"><strong>交易分析：</strong>${colorizeBiasWords(analysisText)}</p>
    `;
    root.appendChild(card);
  });
}

function renderWhale(data) {
  const root = document.getElementById("whale-trend");
  const whale = data.whaleTrend || {};
  const details = whale.details || [];

  const detailList = details.length === 0
    ? "<div class=\"kv\">近期無可用巨鯨明確紀錄。</div>"
    : `<ul class=\"whale-list\">${details
      .map((item) => `<li><strong>${fmt.format(new Date(item.time))}</strong>｜${stripHtml(item.actor)}｜${stripHtml(item.action)}｜${biasSpan(stripHtml(item.bias || "震盪"))}</li>`)
      .join("")}</ul>`;

  root.innerHTML = `
    <h3>巨鯨風向：${biasSpan(whale.trend || "中性")}</h3>
    <div class="kv">${whale.summary || "近期無足夠巨鯨線索"}</div>
    <div class="kv">偏多：${whale.bull ?? 0} / 偏空：${whale.bear ?? 0} / 中性：${whale.neutral ?? 0}</div>
    ${detailList}
  `;
}

function renderGlobalRisks(data) {
  const root = document.getElementById("global-risks");
  root.innerHTML = "";

  const risks = (data.globalRiskSignals || []).slice(0, 8);
  if (risks.length === 0) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = "<h3>目前外部風險訊號偏少</h3><p>仍建議持續觀察川普政策、戰爭與制裁消息。</p>";
    root.appendChild(card);
    return;
  }

  risks.forEach((risk) => {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3><a href="${risk.source}" target="_blank" rel="noreferrer">${risk.title}</a></h3>
      <div>${fmt.format(new Date(risk.time))}</div>
      <p class="change"><strong>具體變化：</strong>${stripHtml(risk.keyChange)}</p>
      <p class="impact"><strong>對虛擬幣影響：</strong>${stripHtml(risk.cryptoImpact)}</p>
      <p class="analysis-note"><strong>短期方向：</strong>${biasSpan(stripHtml(risk.shortTermBias || "震盪"))}</p>
    `;
    root.appendChild(card);
  });
}

function renderAll(data) {
  renderMeta(data);
  renderOverallTrend(data);
  renderOverview(data);
  renderAi(data);
  renderWindows(data);
  renderMacro(data);
  renderSignals(data);
  renderWhale(data);
  renderGlobalRisks(data);
}

function bindControls() {
  const checkbox = document.getElementById("only-high-impact");
  checkbox.addEventListener("change", (event) => {
    onlyHighImpact = Boolean(event.target.checked);
    if (dashboardData) renderAll(dashboardData);
  });
}

async function bootstrap() {
  try {
    const data = await loadData();
    dashboardData = data;
    bindControls();
    renderAll(data);
  } catch (error) {
    document.body.innerHTML = `<main class="container"><h1>資料載入失敗</h1><p>${error.message}</p></main>`;
  }
}

bootstrap();
