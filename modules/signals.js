/**
 * signals.js — 訊號區塊渲染
 * renderPolicySignals、renderAi、renderWindows、renderMacro、
 * renderSignals、renderWhale、renderGlobalRisks
 */

import { state } from './state.js';
import {
  fmt, stripHtml, biasSpan, colorizeBiasWords,
  toTimestamp, badgeClass, statusClass,
  IMPORTANCE_TEXT, STATUS_TEXT, COUNTRY_TEXT,
  SIGNAL_CATEGORY_TEXT, SIGNAL_IMPACT_TEXT,
  translatePolicyTitle, translatePolicySourceName, translateRiskText
} from './utils.js';

export function renderPolicySignals(data) {
  const root = document.getElementById("policy-signals");
  if (!root) return;
  root.innerHTML = "";

  const items = [...(data.policySignals || [])]
    .sort((a, b) => toTimestamp(b.time) - toTimestamp(a.time))
    .slice(0, 9);

  if (items.length === 0) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = "<h3>目前無可用政策/監管訊號</h3><p>來源為官方 RSS；若來源暫時不可用，稍後會自動恢復。</p>";
    root.appendChild(card);
    return;
  }

  items.forEach((item) => {
    const title      = translatePolicyTitle(item.title || item.keyChange || "");
    const sourceName = translatePolicySourceName(item.sourceName || "官方來源");
    const impact     = stripHtml(item.impact || "medium");
    const bias       = stripHtml(item.shortTermBias || "震盪");
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3><a href="${item.source}" target="_blank" rel="noreferrer">${title}</a></h3>
      <div>${item.time ? fmt.format(new Date(item.time)) : "時間未知"}</div>
      <div class="kv">
        <div>來源：${sourceName}</div>
        <div>影響：${SIGNAL_IMPACT_TEXT[impact] || impact}</div>
        <div>短線（1-7天）：${biasSpan(bias)}</div>
      </div>
      <p class="impact"><strong>對虛擬幣影響：</strong>${stripHtml(item.cryptoImpact || "—")}</p>
    `;
    root.appendChild(card);
  });
}

export function renderAi(data) {
  const list = document.getElementById("ai-insights");
  list.innerHTML = "";
  (data?.aiSummary?.keyInsights || []).forEach((item) => {
    const li = document.createElement("li");
    li.innerHTML = colorizeBiasWords(item);
    list.appendChild(li);
  });
}

export function renderWindows(data) {
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

export function renderMacro(data) {
  const body = document.getElementById("macro-body");
  body.innerHTML = "";

  const now = Date.now();
  const pastWindow   = 1000 * 60 * 60 * 24 * 90;
  const futureWindow = 1000 * 60 * 60 * 24 * 365;

  let visibleEvents = (data.macroEvents || []).filter((event) => {
    const t = new Date(event.datetime).getTime();
    return t >= now - pastWindow && t <= now + futureWindow;
  });

  if (state.macroFilter === "recent") {
    visibleEvents = visibleEvents
      .filter((e) => e.status === "recent")
      .sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
  }

  visibleEvents.forEach((event) => {
    const hasPublished = Boolean(event.result && event.result.actual);
    const resultText   = hasPublished
      ? `${event.result.actual}${event.result.unit && event.result.unit !== "-" ? ` ${event.result.unit}` : ""}`
      : "尚未公布";
    const analysisText = hasPublished ? (event.result?.analysis || "") : "等待公布後更新";
    const impactLine   = hasPublished
      ? `對幣市：${event.result?.cryptoImpact || "等待補充"}｜短線：${biasSpan(event.result?.shortTermBias || "震盪")}`
      : `<span class="bias-muted">對幣市：待公布後判讀｜短線：待確認</span>`;

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

export function renderSignals(data) {
  const root = document.getElementById("crypto-signals");
  root.innerHTML = "";

  let signals = data.cryptoSignals || [];
  if (state.onlyHighImpact) signals = signals.filter((signal) => signal.impact === "high");
  signals = [...signals].sort((a, b) => toTimestamp(b.time) - toTimestamp(a.time));

  signals.forEach((signal) => {
    const summary      = stripHtml(signal.zhSummary || signal.summary || "");
    const impactText   = stripHtml(signal.cryptoImpact || "市場影響評估中");
    const analysisText = stripHtml(signal.cryptoAnalysis || "等待更多資料補充分析");
    const changeText   = stripHtml(signal.keyChange || "關鍵變化整理中");
    const shortBias    = stripHtml(signal.shortTermBias || "震盪");
    const mergedHint   = Number(signal.mergedCount || 1) > 1
      ? `<div class="kv"><div>已整合同類訊息 ${signal.mergedCount} 則</div></div>`
      : "";

    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3><a href="${signal.source}" target="_blank" rel="noreferrer">${signal.zhTitle || signal.title}</a></h3>
      <div>${fmt.format(new Date(signal.time))}</div>
      <div class="kv">
        <div>分類：${SIGNAL_CATEGORY_TEXT[signal.category] || signal.category}</div>
        <div>影響：${SIGNAL_IMPACT_TEXT[signal.impact] || signal.impact}</div>
        <div>短線（1-7天）：${biasSpan(shortBias)}</div>
      </div>
      <p class="change"><strong>具體變化：</strong>${changeText}</p>
      <p>${summary}</p>
      <p class="impact"><strong>對虛擬幣影響：</strong>${impactText}</p>
      <p class="analysis-note"><strong>交易分析：</strong>${colorizeBiasWords(analysisText)}</p>
      ${mergedHint}
    `;
    root.appendChild(card);
  });
}

export function renderWhale(data) {
  const root  = document.getElementById("whale-trend");
  const whale   = data.whaleTrend || {};
  const details = whale.details || [];

  const detailList = details.length === 0
    ? "<div class=\"kv\">近期無可用巨鯨明確紀錄。</div>"
    : `<ul class=\"whale-list\">${details
        .map((item) => `<li><div><strong>${fmt.format(new Date(item.time))}</strong></div><div>主體：${stripHtml(item.actor)}</div><div>動作：${stripHtml(item.action)}</div><div>短線（1-7天）：${biasSpan(stripHtml(item.bias || "震盪"))}</div></li>`)
        .join("")}</ul>`;

  root.innerHTML = `
    <h3>巨鯨風向：${biasSpan(whale.trend || "中性")}</h3>
    <div class="kv"><div>${whale.summary || "近期無足夠巨鯨線索"}</div></div>
    <div class="kv"><div>偏多：${whale.bull ?? 0}</div><div>偏空：${whale.bear ?? 0}</div><div>中性：${whale.neutral ?? 0}</div></div>
    ${detailList}
  `;
}

export function renderGlobalRisks(data) {
  const root = document.getElementById("global-risks");
  root.innerHTML = "";

  const risks = [...(data.globalRiskSignals || [])]
    .sort((a, b) => toTimestamp(b.time) - toTimestamp(a.time))
    .slice(0, 8);

  if (risks.length === 0) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = "<h3>目前外部風險訊號偏少</h3><p>仍建議持續觀察川普政策、戰爭與制裁消息。</p>";
    root.appendChild(card);
    return;
  }

  risks.forEach((risk) => {
    const translatedChange = translateRiskText(risk.keyChange || risk.title);
    const mergedHint = Number(risk.mergedCount || 1) > 1
      ? `<div class="kv"><div>已整合同類事件 ${risk.mergedCount} 則</div></div>`
      : "";
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3><a href="${risk.source}" target="_blank" rel="noreferrer">${risk.title}</a></h3>
      <div>${fmt.format(new Date(risk.time))}</div>
      <p class="change"><strong>具體變化：</strong>${translatedChange}</p>
      <p class="impact"><strong>對虛擬幣影響：</strong>${stripHtml(risk.cryptoImpact)}</p>
      <div class="kv"><div><strong>短線（1-7天）方向：</strong>${biasSpan(stripHtml(risk.shortTermBias || "震盪"))}</div></div>
      ${mergedHint}
    `;
    root.appendChild(card);
  });
}
