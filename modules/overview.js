/**
 * overview.js — renderMeta、renderOverallTrend、renderOverview
 * 對應前端：頂部更新時間、短中長線趨勢 Banner、市場概覽卡片群
 */

import { state } from './state.js';
import {
  fmt, stripHtml, biasSpan, colorizeBiasWords, colorizeBiasWordsKeepHtml,
  toNumber, signedSpan, probabilitySpan,
  translateFngClassification, translatePolicyTitle, translateRiskText
} from './utils.js';

// ── 降息機率估算（buildRateCutOutlook）─────────────────────────────
function buildRateCutOutlook(data) {
  const concrete = data.rateCutData;
  if (concrete?.mode === "concrete") {
    return {
      mode: "concrete",
      probability: Math.round(Number(concrete.nextCutProbability ?? 0)),
      monthLabel: concrete.nextMonthLabel || "待定",
      eventTitle: "聯邦基金利率路徑",
      basis: `觀測日：${concrete.observationDate ? fmt.format(new Date(concrete.observationDate)) : "未知"}`,
      sourceName: concrete.sourceName || "市場隱含機率",
      sourceUrl: concrete.sourceUrl || "",
      firstLikelyCutMonth: concrete.firstLikelyCutMonth || null,
      firstLikelyCutProbability: concrete.firstLikelyCutProbability ?? null
    };
  }

  const macroEvents = data.macroEvents || [];

  const upcomingFomc = macroEvents
    .filter((event) => event.country === "US" && event.eventType === "central-bank" && event.status === "upcoming")
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))[0] || null;

  const recentFomc = macroEvents
    .filter((event) => event.country === "US" && event.eventType === "central-bank" && event.status === "recent")
    .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))[0] || null;

  const recentCpi = macroEvents
    .filter((event) => event.eventType === "cpi" && event.status === "recent")
    .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))[0] || null;

  const recentNfp = macroEvents
    .filter((event) => event.eventType === "nfp" && event.status === "recent")
    .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))[0] || null;

  let score = 45;

  const recentRate = toNumber(recentFomc?.result?.actual);
  const previousRate = toNumber(recentFomc?.result?.previous);
  if (recentRate !== null && previousRate !== null) {
    if (recentRate < previousRate) score += 15;
    if (recentRate > previousRate) score -= 15;
  }

  if (recentCpi?.result?.shortTermBias === "偏漲") score += 10;
  if (recentCpi?.result?.shortTermBias === "偏跌") score -= 10;

  if (recentNfp?.result?.shortTermBias === "偏漲") score += 10;
  if (recentNfp?.result?.shortTermBias === "偏跌") score -= 10;

  const riskBear = (data.globalRiskSignals || []).filter((signal) => signal.shortTermBias === "偏跌").length;
  const riskBull = (data.globalRiskSignals || []).filter((signal) => signal.shortTermBias === "偏漲").length;
  if (riskBear > riskBull) score -= 5;
  if (riskBull > riskBear) score += 5;

  const probability = Math.max(5, Math.min(95, score));

  if (!upcomingFomc?.datetime) {
    return {
      mode: "estimate",
      probability,
      monthLabel: "待定",
      eventTitle: "下一次 FOMC",
      basis: "估算依據：FOMC/CPI/NFP/外部風險"
    };
  }

  const nextDate = new Date(upcomingFomc.datetime);
  const basis = [
    `FOMC：${recentFomc?.result?.actual || "未提供"}`,
    `CPI短線：${recentCpi?.result?.shortTermBias || "未提供"}`,
    `NFP短線：${recentNfp?.result?.shortTermBias || "未提供"}`,
    `外部風險偏向：${riskBear > riskBull ? "偏空" : riskBull > riskBear ? "偏多" : "中性"}`
  ].join(" / ");

  return {
    mode: "estimate",
    probability,
    monthLabel: `${nextDate.getFullYear()}年${nextDate.getMonth() + 1}月`,
    eventTitle: upcomingFomc.title,
    basis
  };
}

// ── renderMeta ────────────────────────────────────────────────────
export function renderMeta(data) {
  const sourceLabel = state._dataSource === "本地 API" ? "本地 API" : "Upstash";
  const sourceCls   = state._dataSource === "本地 API" ? "badge medium" : "badge low";
  const meta = document.getElementById("meta");
  meta.innerHTML = `最後更新：${fmt.format(new Date(data.generatedAt))}（UTC 來源整合）&nbsp;&nbsp;<span class="${sourceCls}" title="資料來源">${sourceLabel}</span>`;

  // 資料新鮮度警告：超過 30 分鐘顯示橙色橫幅
  const staleMs = Date.now() - new Date(data.generatedAt).getTime();
  const STALE_THRESHOLD = 30 * 60 * 1000;
  let banner = document.getElementById("stale-banner");
  if (staleMs > STALE_THRESHOLD) {
    const staleMin = Math.floor(staleMs / 60000);
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "stale-banner";
      document.querySelector(".hero").insertAdjacentElement("afterend", banner);
    }
    banner.className = "stale-banner";
    banner.textContent = `⚠ 資料已超過 ${staleMin} 分鐘未更新，請確認 keep-alive.mjs 是否正常運行`;
  } else if (banner) {
    banner.remove();
  }
}

// ── renderOverallTrend ────────────────────────────────────────────
export function renderOverallTrend(data) {
  const el = document.getElementById("overall-trend");
  const overview = data.marketOverview || {};
  const short = overview.shortTermTrend || "震盪";
  const mid   = overview.midTermTrend   || "震盪";
  const long  = overview.longTermTrend  || "震盪";
  const shortReason = overview.shortTrendReason || "短線理由尚未生成";
  const midReason   = overview.midTrendReason   || "中線理由尚未生成";
  const longReason  = overview.longTrendReason  || "長線理由尚未生成";
  const shortCond = overview.shortTermCondition || "";
  const midCond   = overview.midTermCondition   || "";
  const longCond  = overview.longTermCondition  || "";
  const external  = overview.externalRiskBias   || "外部風險中性";
  const title = "短/中/長線總趨勢（交易員評估｜每次更新重算）";

  function reasonLines(text = "") {
    const raw = stripHtml(text);
    return raw
      .split(/\r?\n|；|;|\|\|/g)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function colorizeMultiline(text = "") {
    const parts = String(text)
      .split(/\n+/g)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return "";
    return parts.map((p) => colorizeBiasWords(p)).join("<br>");
  }

  function parseReasonSections(text = "") {
    const keys = [
      "政治/政策", "央行/利率", "美/日政策", "機構資金流",
      "巨鯨/鏈上", "散戶/槓桿", "市場結構", "催化/節奏",
      "觀察指標", "失效條件"
    ];
    const sections = Object.fromEntries(keys.map((k) => [k, ""]));
    const raw = stripHtml(text).replace(/\r\n/g, "\n").trim();
    if (!raw) return { keys, sections, rawText: "" };

    const escaped = keys
      .slice()
      .sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(`(${escaped.join("|")})\\s*[:：]`, "g");
    const matches = Array.from(raw.matchAll(re));
    if (matches.length === 0) return { keys, sections, rawText: raw };

    for (let i = 0; i < matches.length; i++) {
      const key   = matches[i][1];
      const start = (matches[i].index ?? 0) + matches[i][0].length;
      const end   = i + 1 < matches.length ? (matches[i + 1].index ?? raw.length) : raw.length;
      let content = raw.slice(start, end).trim();
      content = content.replace(/^[\s\-–—.。；;:：]+/, "").trim();
      content = content.replace(/[；;]/g, "\n");
      sections[key] = content;
    }
    return { keys, sections, rawText: raw };
  }

  function renderBlock({ title, horizon, trend, condition, reason }) {
    const hasCondition = Boolean(stripHtml(condition));
    const trendText = hasCondition && /偏漲|偏多|上漲|多頭/.test(String(trend))
      ? `${trend}（有條件）`
      : String(trend);
    const parsed = parseReasonSections(reason);
    const { keys, sections } = parsed;
    const hasAnySection = keys.some((k) => Boolean(String(sections[k] || "").trim()));
    const fallbackText  = hasAnySection ? "" : (parsed.rawText || "");

    const conditionLine = hasCondition
      ? `<div class="reason-row"><div class="reason-key">附帶條件</div><div class="reason-val">${colorizeBiasWords(condition)}</div></div>`
      : "";

    return `
      <div class="trend-block">
        <div class="trend-block-head">
          <div class="trend-block-title">${title}</div>
          <div class="trend-block-horizon">${horizon}</div>
          <div class="trend-block-value">${biasSpan(trendText)}</div>
        </div>
        <div class="kv reason-kv">
          ${conditionLine}
          ${hasAnySection
            ? keys.map((k) => `
              <div class="reason-row">
                <div class="reason-key" style="font-size: 1.1em;">${k}</div>
                <div class="reason-val" style="font-size: 1.1em; color: #e2e8f0; line-height: 1.6;">${colorizeMultiline(String(sections[k] || "").trim() || "—")}</div>
              </div>
            `).join("")
            : `<div class="reason-row" style="grid-template-columns: 1fr;"><div class="reason-val" style="font-size: 1.15em; color: #e2e8f0; line-height: 1.6;">${colorizeMultiline(fallbackText || "—")}</div></div>`
          }
        </div>
      </div>
    `;
  }

  el.innerHTML = `
    <h3>${title}</h3>
    <div class="trend-grid">
      ${renderBlock({ title: "短線", horizon: "1-7天",   trend: short, condition: shortCond, reason: shortReason })}
      ${renderBlock({ title: "中線", horizon: "2-6週",   trend: mid,   condition: midCond,   reason: midReason   })}
      ${renderBlock({ title: "長線", horizon: "1-3個月", trend: long,  condition: longCond,  reason: longReason  })}
    </div>
    <div class="kv"><div><strong>外部風險：</strong>${biasSpan(external)}</div></div>
  `;
}

// ── renderOverview ────────────────────────────────────────────────
export function renderOverview(data) {
  const root = document.getElementById("overview-cards");
  root.innerHTML = "";

  const overview       = data.marketOverview || {};
  const marketIntel    = data.marketIntel    || {};
  const policySignals  = data.policySignals  || [];
  const ratesLatest    = data.ratesIntel?.latest || null;
  const liquidityIntel = data.liquidityIntel || {};
  const whale          = data.whaleTrend     || {};
  const nextHigh       = overview.nextHighImpact;
  const rateCutOutlook = buildRateCutOutlook(data);

  const highRisk = (data.cryptoSignals || [])
    .filter((signal) => signal.impact === "high")
    .sort((a, b) => new Date(b.time) - new Date(a.time))[0] || null;

  const parseUsdAmount = (text = "") => {
    const raw = String(text);
    const m = raw.match(/\$\s*([\d,.]+)\s*([kKmMbB])?/);
    if (m) {
      const n = Number(String(m[1]).replace(/,/g, ""));
      if (!Number.isFinite(n)) return null;
      const unit = String(m[2] || "").toUpperCase();
      if (unit === "K") return n * 1e3;
      if (unit === "M") return n * 1e6;
      if (unit === "B") return n * 1e9;
      return n;
    }
    const zh = raw.match(/([\d.]+)\s*(億|萬)/);
    if (zh) {
      const n = Number(zh[1]);
      if (!Number.isFinite(n)) return null;
      return zh[2] === "億" ? n * 1e8 : n * 1e4;
    }
    return null;
  };

  const days7 = 7 * 24 * 60 * 60 * 1000;
  const recentSignals = (data.cryptoSignals || []).filter((s) => {
    const t = new Date(s.time).getTime();
    return Number.isFinite(t) && (Date.now() - t) <= days7;
  });

  const metrics7d = data.cryptoSignalMetrics7d || null;

  let etfNetFlowUsd = 0;
  let etfCountWithAmount = 0;
  if (metrics7d && Number.isFinite(metrics7d.etfNetFlowUsd) && Number.isFinite(metrics7d.etfCountWithAmount)) {
    etfNetFlowUsd      = Number(metrics7d.etfNetFlowUsd);
    etfCountWithAmount = Number(metrics7d.etfCountWithAmount);
  } else {
    const etfSignals = recentSignals.filter((s) => {
      const blob = `${s.title || ""} ${s.keyChange || ""} ${s.zhTitle || ""}`;
      return /\bETF\b/i.test(blob) || /ETF/.test(blob);
    });
    for (const s of etfSignals) {
      const text   = `${s.keyChange || ""} ${s.title || ""} ${s.zhTitle || ""}`;
      const amount = parseUsdAmount(text);
      if (amount === null || amount < 5e6) continue;
      const isOut = /net\s+outflow|淨流出|outflow/i.test(text);
      const isIn  = /net\s+inflow|淨流入|inflow/i.test(text);
      if (isOut === isIn) continue;
      etfNetFlowUsd += isOut ? -amount : amount;
      etfCountWithAmount += 1;
    }
  }

  let liquidationTotalUsd = 0;
  let liquidationCountWithAmount = 0;
  if (metrics7d && Number.isFinite(metrics7d.liquidationTotalUsd) && Number.isFinite(metrics7d.liquidationCountWithAmount)) {
    liquidationTotalUsd        = Number(metrics7d.liquidationTotalUsd);
    liquidationCountWithAmount = Number(metrics7d.liquidationCountWithAmount);
  } else {
    const liquidationSignals = recentSignals.filter((s) => {
      const blob = `${s.title || ""} ${s.keyChange || ""} ${s.zhTitle || ""}`;
      return /清算|liquidation/i.test(blob);
    });
    for (const s of liquidationSignals) {
      const text = `${s.keyChange || ""} ${s.title || ""} ${s.zhTitle || ""}`;
      const m = text.match(/(?:liquidat(?:ion|ed)?|清算)[^$]{0,80}\$\s*([\d,.]+)\s*([kKmMbB])?/i);
      if (!m) continue;
      const n    = Number(String(m[1]).replace(/,/g, ""));
      if (!Number.isFinite(n)) continue;
      const unit = String(m[2] || "").toUpperCase();
      const amount = unit === "K" ? n * 1e3 : unit === "M" ? n * 1e6 : unit === "B" ? n * 1e9 : n;
      if (!Number.isFinite(amount) || amount < 1e6) continue;
      liquidationTotalUsd += Math.abs(amount);
      liquidationCountWithAmount += 1;
    }
  }

  const latestExternal     = (data.globalRiskSignals || []).sort((a, b) => new Date(b.time) - new Date(a.time))[0] || null;
  const latestExternalText = latestExternal
    ? translateRiskText(latestExternal.keyChange || latestExternal.title)
    : "目前外部風險訊號偏少";
  const latestExternalTimeText = latestExternal?.time ? fmt.format(new Date(latestExternal.time)) : "未知";

  const nextEventText = nextHigh?.datetime
    ? `${fmt.format(new Date(nextHigh.datetime))} ${nextHigh.title}`
    : "未來 7 天暫無高影響事件";

  const inferUpcomingExpectation = (event) => {
    if (!event) return { bias: "震盪", note: "目前無高影響事件" };
    const type = String(event.eventType || "").toLowerCase();
    const base = type === "cpi"          ? "通膨數據常直接改變降息預期，事件前後易急波動"
      : type === "nfp"                   ? "就業數據常改變美元/利率預期，事件前後易急波動"
      : type === "central-bank"          ? "央行決議/措辭是最強波動觸發點之一"
      : "高影響事件，注意波動放大";
    let bias = "震盪";
    if (Number.isFinite(rateCutOutlook?.probability)) {
      if (rateCutOutlook.probability >= 60) bias = "偏漲";
      if (rateCutOutlook.probability <= 40) bias = "偏跌";
    }
    if (String(overview.externalRiskBias || "").includes("偏空") && bias === "震盪") bias = "偏跌";
    const note = `依據：降息機率 ${Number.isFinite(rateCutOutlook?.probability) ? rateCutOutlook.probability : "—"}%／${overview.externalRiskBias || "外部風險中性"}；${base}`;
    return { bias, note };
  };

  const nextExpect   = inferUpcomingExpectation(nextHigh);
  const global       = marketIntel.global;
  const sentiment    = marketIntel.sentiment;

  const marketCapText = global?.totalMarketCapUsd ? `$${Math.round(global.totalMarketCapUsd / 1e9).toLocaleString()}B` : "—";
  const volText       = global?.totalVolumeUsd     ? `$${Math.round(global.totalVolumeUsd / 1e9).toLocaleString()}B`   : "—";
  const capChgText    = Number.isFinite(global?.marketCapChangePct24hUsd) ? signedSpan(global.marketCapChangePct24hUsd, { digits: 2, unit: "%" }) : "—";
  const btcDomText    = Number.isFinite(global?.btcDominancePct) ? `${global.btcDominancePct.toFixed(1)}%` : "—";
  const fngText       = Number.isFinite(sentiment?.fearGreedValue)
    ? `${sentiment.fearGreedValue}（${translateFngClassification(sentiment.fearGreedClassification || "")}）`
    : "—";

  const stable = liquidityIntel.stablecoins;
  const defi   = liquidityIntel.defi;
  const stableMcapText = Number.isFinite(stable?.totalMcapUsd)  ? `$${Math.round(stable.totalMcapUsd / 1e9).toLocaleString()}B`  : "—";
  const stableChgText  = Number.isFinite(stable?.change7dPct)   ? signedSpan(stable.change7dPct, { digits: 2, unit: "%" })        : "—";
  const defiTvlText    = Number.isFinite(defi?.totalTvlUsd)     ? `$${Math.round(defi.totalTvlUsd / 1e9).toLocaleString()}B`     : "—";
  const defiChgText    = Number.isFinite(defi?.change7dPct)     ? signedSpan(defi.change7dPct, { digits: 2, unit: "%" })          : "—";

  const latestPolicy      = (policySignals || []).slice().sort((a, b) => new Date(b.time) - new Date(a.time))[0] || null;
  const latestPolicyTitle = latestPolicy ? translatePolicyTitle(latestPolicy.title || latestPolicy.keyChange) : "—";
  const latestPolicyBias  = latestPolicy ? stripHtml(latestPolicy.shortTermBias || "震盪") : "震盪";

  const cards = [
    {
      title: "全市場（CoinGecko）",
      valueHtml: marketCapText,
      subLines: [`24h 市值變化：${capChgText}`, `24h 成交量：${volText}`, `BTC 市佔：${btcDomText}`]
    },
    {
      title: "情緒指標（Fear & Greed）",
      valueHtml: fngText,
      subLines: ["僅供情緒參考，建議搭配資金流/槓桿與宏觀事件判讀。"]
    },
    {
      title: "利率 / 殖利率（FRED）",
      valueHtml: `10Y：${ratesLatest?.y10y ? `${ratesLatest.y10y.toFixed(2)}%` : "—"}`,
      subLines: [
        `2Y：${ratesLatest?.y2y ? `${ratesLatest.y2y.toFixed(2)}%` : "—"}｜3M：${ratesLatest?.y3m ? `${ratesLatest.y3m.toFixed(2)}%` : "—"}`,
        `10Y-2Y：${signedSpan(ratesLatest?.spread10y2y, { digits: 2, unit: "%" })}｜10Y-3M：${signedSpan(ratesLatest?.spread10y3m, { digits: 2, unit: "%" })}`,
        ratesLatest?.date ? `資料日：${ratesLatest.date}` : ""
      ]
    },
    {
      title: "穩定幣流動性（DeFiLlama）",
      valueHtml: stableMcapText,
      subLines: Number.isFinite(stable?.change7dPct) ? [`近 7 日變化：${stableChgText}`] : []
    },
    {
      title: "DeFi TVL（DeFiLlama）",
      valueHtml: defiTvlText,
      subLines: Number.isFinite(defi?.change7dPct) ? [`近 7 日變化：${defiChgText}`] : []
    },
    {
      title: "政策 / 監管（官方）",
      valueHtml: latestPolicy ? biasSpan(latestPolicyBias) : "—",
      subLines: latestPolicy ? [`最新：${latestPolicyTitle}`] : ["—"],
      targetId: "policy-section"
    },
    {
      title: "ETF / 機構流向（7D，訊號整合）",
      valueHtml: etfCountWithAmount > 0
        ? signedSpan(etfNetFlowUsd / 1e6, { digits: 0, unit: "M", prefix: "$" })
        : "—",
      subLines: [etfCountWithAmount > 0 ? "近 7 日淨流向彙總（以可解析金額訊號估算）" : "近 7 日未抓到可解析金額的 ETF 流向訊號"],
      targetId: "crypto-section"
    },
    {
      title: "槓桿清算規模（7D，訊號整合）",
      valueHtml: liquidationCountWithAmount > 0
        ? `<span class="${liquidationTotalUsd >= 200e6 ? "bias-down" : liquidationTotalUsd >= 80e6 ? "bias-side" : "bias-muted"}">$${Math.round(liquidationTotalUsd / 1e6).toLocaleString()}M</span>`
        : "—",
      subLines: [liquidationCountWithAmount > 0 ? "近 7 日清算彙總（以可解析金額訊號估算）" : "近 7 日未抓到可解析金額的清算訊號"],
      targetId: "crypto-section"
    },
    {
      title: rateCutOutlook.mode === "concrete" ? "降息機率（市場隱含）" : "降息機率（交易員估算）",
      valueHtml: probabilitySpan(rateCutOutlook.probability),
      subLines: rateCutOutlook.mode === "concrete"
        ? [
          `可能時點：${rateCutOutlook.monthLabel}（${rateCutOutlook.eventTitle}）`,
          `${rateCutOutlook.basis}`,
          `來源：${rateCutOutlook.sourceName}${rateCutOutlook.firstLikelyCutMonth ? `；首次達 50% 月份：${rateCutOutlook.firstLikelyCutMonth}（${Math.round(rateCutOutlook.firstLikelyCutProbability || 0)}%）` : ""}`
        ]
        : [
          `可能時點：${rateCutOutlook.monthLabel}（${rateCutOutlook.eventTitle}）`,
          `依據：${rateCutOutlook.basis || "FOMC/CPI/NFP/外部風險"}`,
          "估算（非官方機率）"
        ],
      targetId: "macro-section"
    },
    {
      title: "下一個高影響事件",
      valueHtml: nextEventText,
      subLines: [
        `當前預期：${biasSpan(nextExpect.bias)}`,
        nextExpect.note,
        nextHigh?.impactHint ? `事件影響：${stripHtml(nextHigh.impactHint)}` : ""
      ],
      targetId: "macro-section"
    },
    {
      title: "高風險重點",
      valueHtml: highRisk ? stripHtml(highRisk.keyChange || highRisk.zhTitle || highRisk.title) : "目前無高風險訊號",
      subLines: highRisk ? [`短線（1-7天）：${stripHtml(highRisk.shortTermBias || "震盪")}`] : [],
      targetId: "crypto-section"
    },
    {
      title: "外部風險重點",
      valueHtml: latestExternalText,
      subLines: latestExternal
        ? [`時間：${latestExternalTimeText}`, `短線（1-7天）：${stripHtml(latestExternal.shortTermBias || "震盪")}`]
        : [],
      targetId: "risk-section"
    },
    {
      title: "巨鯨風向",
      valueHtml: biasSpan(whale.trend || "中性"),
      subLines: [whale.summary || "無足夠資料"],
      targetId: "whale-section"
    }
  ];

  cards.forEach((item) => {
    const card = document.createElement("article");
    card.className = "card";
    const titleHtml = item.targetId
      ? `<h3><a class="overview-link" href="#${item.targetId}">${item.title}</a></h3>`
      : `<h3>${item.title}</h3>`;
    const valueHtml = item.targetId
      ? `<a class="overview-link metric metric-link" href="#${item.targetId}">${item.valueHtml}</a>`
      : `<div class="metric">${item.valueHtml}</div>`;
    const normalizedSubLines = Array.isArray(item.subLines)
      ? item.subLines.filter(Boolean)
      : (item.sub ? String(item.sub).split("｜").map((part) => part.trim()).filter(Boolean) : []);
    const subHtml = normalizedSubLines.length
      ? `<div class="kv">${normalizedSubLines.map((line) => `<div>${colorizeBiasWordsKeepHtml(String(line))}</div>`).join("")}</div>`
      : "";
    card.innerHTML = `${titleHtml}${valueHtml}${subHtml}`;
    root.appendChild(card);
  });
}
