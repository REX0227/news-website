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
const UPSTASH_URL = "https://guided-spider-19708.upstash.io";
const UPSTASH_READ_TOKEN = "Akz8AAIgcDE18SAeYebRfjHOi1t_RtbOFNv2r3NHF0kLYfDIUMnEOw";
const UPSTASH_KEY = "crypto_dashboard:latest";

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

function toTimestamp(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : -1;
}

function biasClass(text = "") {
  const t = String(text);
  if (/待確認|待公布|待判讀|判讀中|待AI評估/i.test(t)) return "bias-muted";
  if (/偏漲|偏多|上漲|多頭|\bup\b/i.test(t)) return "bias-up";
  if (/偏跌|偏空|下跌|空頭|\bdown\b/i.test(t)) return "bias-down";
  return "bias-side";
}

function biasSpan(text = "") {
  return `<span class="${biasClass(text)}">${text || "震盪"}</span>`;
}

function colorizeBiasWords(text = "") {
  return stripHtml(text)
    .replace(/待公布後判讀|待公布|待確認|待判讀|判讀中|待AI評估/g, '<span class="bias-muted">$&</span>')
    .replace(/偏漲|偏多|上漲|多頭/g, '<span class="bias-up">$&</span>')
    .replace(/偏跌|偏空|下跌|空頭/g, '<span class="bias-down">$&</span>')
    .replace(/震盪/g, '<span class="bias-side">$&</span>');
}

function toNumber(value) {
  const num = Number(String(value ?? "").replace(/[^\d.+-]/g, ""));
  return Number.isFinite(num) ? num : null;
}

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
      mode: "model",
      probability,
      monthLabel: "待定",
      eventTitle: "下一次 FOMC",
      basis: "模型：FOMC/CPI/NFP/外部風險"
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
    mode: "model",
    probability,
    monthLabel: `${nextDate.getFullYear()}年${nextDate.getMonth() + 1}月`,
    eventTitle: upcomingFomc.title,
    basis
  };
}

function probabilitySpan(probability) {
  const cls = probability >= 60 ? "bias-up" : probability <= 40 ? "bias-down" : "bias-side";
  return `<span class="${cls}">${probability}%</span>`;
}

function signedSpan(value, { digits = 2, unit = "", reverse = false, prefix = "" } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const cls = n > 0 ? (reverse ? "bias-down" : "bias-up") : n < 0 ? (reverse ? "bias-up" : "bias-down") : "bias-side";
  const sign = n > 0 ? "+" : "";
  const text = `${prefix}${sign}${n.toFixed(digits)}${unit}`;
  return `<span class="${cls}">${text}</span>`;
}

function colorizeBiasWordsKeepHtml(text = "") {
  return String(text)
    .replace(/待公布後判讀|待公布|待確認|待判讀|判讀中|待AI評估/g, '<span class="bias-muted">$&</span>')
    .replace(/偏漲|偏多|上漲|多頭/g, '<span class="bias-up">$&</span>')
    .replace(/偏跌|偏空|下跌|空頭/g, '<span class="bias-down">$&</span>')
    .replace(/震盪/g, '<span class="bias-side">$&</span>');
}

function translateFngClassification(value = "") {
  const v = String(value || "").toLowerCase();
  if (v.includes("extreme fear")) return "極度恐懼";
  if (v.includes("fear")) return "恐懼";
  if (v.includes("neutral")) return "中性";
  if (v.includes("extreme greed")) return "極度貪婪";
  if (v.includes("greed")) return "貪婪";
  return String(value || "");
}

function translatePolicyTitle(text = "") {
  let t = stripHtml(text);
  const replacements = [
    [/Federal Reserve Board/gi, "聯準會理事會"],
    [/Federal Reserve/gi, "聯準會"],
    [/White House/gi, "白宮"],
    [/U\.S\. Treasury/gi, "美國財政部"],
    [/Treasury/gi, "財政部"],
    [/SEC\b/gi, "SEC"],
    [/CFTC\b/gi, "CFTC"],
    [/announces?/gi, "宣布"],
    [/announced/gi, "宣布"],
    [/approval of application/gi, "批准申請"],
    [/approves?/gi, "批准"],
    [/application/gi, "申請"],
    [/final rule/gi, "最終規則"],
    [/press release/gi, "新聞稿"],
    [/statement/gi, "聲明"],
    [/charges?/gi, "指控"],
    [/lawsuit/gi, "訴訟"],
    [/settlement/gi, "和解"],
    [/penalt(y|ies)/gi, "罰款"],
    [/sanctions?/gi, "制裁"],
    [/tariffs?/gi, "關稅"],
    [/crypto/gi, "加密"],
    [/\s{2,}/g, " "]
  ];

  for (const [re, rep] of replacements) {
    t = t.replace(re, rep);
  }
  const out = t.replace(/\s+/g, " ").trim();
  return out || stripHtml(text);
}

function translatePolicySourceName(text = "") {
  const t = String(text || "").toLowerCase();
  if (t.includes("whitehouse")) return "白宮";
  if (t.includes("treasury")) return "美國財政部";
  if (t.includes("federal reserve")) return "聯準會";
  if (t === "sec") return "SEC";
  if (t === "cftc") return "CFTC";
  return stripHtml(text) || "官方來源";
}

function translateRiskText(text = "") {
  const clean = stripHtml(text)
    .replace(/\s+-\s+[^-]+$/g, "")
    .trim();

  if (/Supreme Court.*reversal.*Trump.*tariff.*clarity/i.test(clean)) {
    return "美國最高法院推翻川普關稅措施，可能讓政策方向更明確";
  }

  let translated = clean;
  const replacements = [
    [/Supreme Court/gi, "美國最高法院"],
    [/Trump(?:'s)?/gi, "川普"],
    [/tariffs?/gi, "關稅"],
    [/reversal/gi, "推翻"],
    [/could bring/gi, "可能帶來"],
    [/clarity/gi, "更明確方向"],
    [/policy/gi, "政策"],
    [/trade/gi, "貿易"],
    [/war/gi, "戰爭"],
    [/sanctions?/gi, "制裁"],
    [/interest rates?/gi, "利率"],
    [/Fed/gi, "聯準會"],
    [/FOMC/gi, "FOMC"],
    [/BOJ/gi, "日本央行"],
    [/crypto/gi, "加密市場"]
  ];

  for (const [pattern, replacement] of replacements) {
    translated = translated.replace(pattern, replacement);
  }

  return translated;
}

async function loadData() {
  const upstashResponse = await fetch(`${UPSTASH_URL}/get/${UPSTASH_KEY}`, {
    headers: {
      Authorization: `Bearer ${UPSTASH_READ_TOKEN}`
    }
  });

  if (!upstashResponse.ok) {
    throw new Error("無法從 Upstash 載入最新資料");
  }

  const payload = await upstashResponse.json();
  const result = payload?.result;

  if (typeof result === "string") {
    return JSON.parse(result);
  }

  if (result && typeof result === "object") {
    return result;
  }

  throw new Error("Upstash 回傳資料格式異常");
}

function renderMeta(data) {
  document.getElementById("meta").textContent = `最後更新：${fmt.format(new Date(data.generatedAt))}（UTC 來源整合）`;
}

function renderOverallTrend(data) {
  const el = document.getElementById("overall-trend");
  const overview = data.marketOverview || {};
  const short = overview.shortTermTrend || "待AI評估";
  const mid = overview.midTermTrend || "待AI評估";
  const long = overview.longTermTrend || "待AI評估";
  const shortReason = overview.shortTrendReason || "短線理由尚未生成";
  const midReason = overview.midTrendReason || "中線理由尚未生成";
  const longReason = overview.longTrendReason || "長線理由尚未生成";
  const shortCond = overview.shortTermCondition || "";
  const midCond = overview.midTermCondition || "";
  const longCond = overview.longTermCondition || "";
  const external = overview.externalRiskBias || "外部風險中性";
  const mode = overview.trendModelMeta?.mode || "fallback";
  const model = `${mode}/${overview.trendModelMeta?.model || "rule-based"}`;
  const title = mode === "manual_trader" ? "短/中/長線總趨勢（交易員判斷）" : "短/中/長線總趨勢（模型評估）";

  function reasonLines(text = "") {
    const raw = stripHtml(text);
    return raw
      .split(/\r?\n|；|;|\|\|/g)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function normalizeReasonLine(line = "") {
    return String(line)
      .replace(/^\uFEFF/, "")
      .replace(/^[\s\-•\u2022]+/, "")
      .trim();
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
      "政治/政策",
      "央行/利率",
      "美/日政策",
      "機構資金流",
      "巨鯨/鏈上",
      "散戶/槓桿",
      "市場結構",
      "催化/節奏",
      "觀察指標",
      "失效條件"
    ];
    const sections = Object.fromEntries(keys.map((k) => [k, ""]));

    const raw = stripHtml(text)
      .replace(/\r\n/g, "\n")
      .trim();

    if (!raw) return { keys, sections, rawText: "" };

    const escaped = keys
      .slice()
      .sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(`(${escaped.join("|")})\\s*[:：]`, "g");
    const matches = Array.from(raw.matchAll(re));

    if (matches.length === 0) {
      return { keys, sections, rawText: raw };
    }

    for (let i = 0; i < matches.length; i += 1) {
      const key = matches[i][1];
      const start = (matches[i].index ?? 0) + matches[i][0].length;
      const end = i + 1 < matches.length ? (matches[i + 1].index ?? raw.length) : raw.length;
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
    const keys = parsed.keys;
    const sections = parsed.sections;

    const hasAnySection = keys.some((k) => Boolean(String(sections[k] || "").trim()));
    const fallbackText = hasAnySection ? "" : (parsed.rawText || "");

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
                <div class="reason-key">${k}</div>
                <div class="reason-val">${colorizeMultiline(String(sections[k] || "").trim() || "—")}</div>
              </div>
            `).join("")
            : `<div class="reason-row"><div class="reason-key">說明</div><div class="reason-val">${colorizeMultiline(fallbackText || "—")}</div></div>`
          }
        </div>
      </div>
    `;
  }

  el.innerHTML = `
    <h3>${title}</h3>
    <div class="trend-grid">
      ${renderBlock({
        title: "短線",
        horizon: "1-7天",
        trend: short,
        condition: shortCond,
        reason: shortReason
      })}
      ${renderBlock({
        title: "中線",
        horizon: "2-6週",
        trend: mid,
        condition: midCond,
        reason: midReason
      })}
      ${renderBlock({
        title: "長線",
        horizon: "1-3個月",
        trend: long,
        condition: longCond,
        reason: longReason
      })}
    </div>
    <div class="kv"><div><strong>外部風險：</strong>${biasSpan(external)}</div><div><strong>模型：</strong>${model}</div></div>
  `;
}

function renderOverview(data) {
  const root = document.getElementById("overview-cards");
  root.innerHTML = "";

  const overview = data.marketOverview || {};
  const marketIntel = data.marketIntel || {};
  const policySignals = data.policySignals || [];
  const ratesLatest = data.ratesIntel?.latest || null;
  const liquidityIntel = data.liquidityIntel || {};
  const whale = data.whaleTrend || {};
  const nextHigh = overview.nextHighImpact;
  const rateCutOutlook = buildRateCutOutlook(data);

  const highRisk = (data.cryptoSignals || [])
    .filter((signal) => signal.impact === "high")
    .sort((a, b) => new Date(b.time) - new Date(a.time))[0] || null;

  const parseUsdAmount = (text = "") => {
    const raw = String(text);
    // $288M / 1.2B / 300,000,000
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

    // 3.2 億 / 5000 萬
    const zh = raw.match(/([\d.]+)\s*(億|萬)/);
    if (zh) {
      const n = Number(zh[1]);
      if (!Number.isFinite(n)) return null;
      const unit = zh[2];
      if (unit === "億") return n * 1e8;
      if (unit === "萬") return n * 1e4;
    }

    return null;
  };

  const days7 = 7 * 24 * 60 * 60 * 1000;
  const recentSignals = (data.cryptoSignals || [])
    .filter((s) => {
      const t = new Date(s.time).getTime();
      return Number.isFinite(t) && (Date.now() - t) <= days7;
    });

  const etfSignals = recentSignals.filter((s) => /\bETF\b/i.test(String(s.title || "")) || /\bETF\b/i.test(String(s.keyChange || "")));
  let etfNetFlowUsd = 0;
  let etfCountWithAmount = 0;
  for (const s of etfSignals) {
    const text = `${s.keyChange || ""} ${s.title || ""}`;
    const amount = parseUsdAmount(text);
    if (amount === null) continue;
    const isOut = /流出|淨流出|outflow/i.test(text);
    const isIn = /流入|淨流入|inflow/i.test(text);
    const signed = isOut && !isIn ? -amount : amount;
    etfNetFlowUsd += signed;
    etfCountWithAmount += 1;
  }
  const etfNetFlowText = etfCountWithAmount > 0
    ? `${etfNetFlowUsd >= 0 ? "+" : "-"}$${Math.round(Math.abs(etfNetFlowUsd) / 1e6).toLocaleString()}M`
    : "—";

  const liquidationSignals = recentSignals.filter((s) => /清算|liquidation/i.test(String(s.title || "")) || /清算|liquidation/i.test(String(s.keyChange || "")));
  let liquidationTotalUsd = 0;
  let liquidationCountWithAmount = 0;
  for (const s of liquidationSignals) {
    const text = `${s.keyChange || ""} ${s.title || ""}`;
    const amount = parseUsdAmount(text);
    if (amount === null) continue;
    liquidationTotalUsd += Math.abs(amount);
    liquidationCountWithAmount += 1;
  }
  const liquidationText = liquidationCountWithAmount > 0
    ? `$${Math.round(liquidationTotalUsd / 1e6).toLocaleString()}M`
    : "—";

  const latestExternal = (data.globalRiskSignals || [])
    .sort((a, b) => new Date(b.time) - new Date(a.time))[0] || null;

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

    const base = type === "cpi"
      ? "通膨數據常直接改變降息預期，事件前後易急波動"
      : type === "nfp"
        ? "就業數據常改變美元/利率預期，事件前後易急波動"
        : type === "central-bank"
          ? "央行決議/措辭是最強波動觸發點之一"
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

  const nextExpect = inferUpcomingExpectation(nextHigh);

  const global = marketIntel.global;
  const sentiment = marketIntel.sentiment;

  const marketCapText = global?.totalMarketCapUsd
    ? `$${Math.round(global.totalMarketCapUsd / 1e9).toLocaleString()}B`
    : "—";
  const volText = global?.totalVolumeUsd
    ? `$${Math.round(global.totalVolumeUsd / 1e9).toLocaleString()}B`
    : "—";
  const capChgText = Number.isFinite(global?.marketCapChangePct24hUsd)
    ? signedSpan(global.marketCapChangePct24hUsd, { digits: 2, unit: "%" })
    : "—";
  const btcDomText = Number.isFinite(global?.btcDominancePct)
    ? `${global.btcDominancePct.toFixed(1)}%`
    : "—";
  const fngText = Number.isFinite(sentiment?.fearGreedValue)
    ? `${sentiment.fearGreedValue}（${translateFngClassification(sentiment.fearGreedClassification || "")}）`
    : "—";

  const y10Text = Number.isFinite(ratesLatest?.y10y) ? `${ratesLatest.y10y.toFixed(2)}%` : "—";
  const y2Text = Number.isFinite(ratesLatest?.y2y) ? `${ratesLatest.y2y.toFixed(2)}%` : "—";
  const y3mText = Number.isFinite(ratesLatest?.y3m) ? `${ratesLatest.y3m.toFixed(2)}%` : "—";
  const spread10y2yText = Number.isFinite(ratesLatest?.spread10y2y) ? `${ratesLatest.spread10y2y.toFixed(2)}%` : "—";
  const spread10y3mText = Number.isFinite(ratesLatest?.spread10y3m) ? `${ratesLatest.spread10y3m.toFixed(2)}%` : "—";

  const stable = liquidityIntel.stablecoins;
  const defi = liquidityIntel.defi;

  const stableMcapText = Number.isFinite(stable?.totalMcapUsd)
    ? `$${Math.round(stable.totalMcapUsd / 1e9).toLocaleString()}B`
    : "—";
  const stableChgText = Number.isFinite(stable?.change7dPct)
    ? signedSpan(stable.change7dPct, { digits: 2, unit: "%" })
    : "—";
  const defiTvlText = Number.isFinite(defi?.totalTvlUsd)
    ? `$${Math.round(defi.totalTvlUsd / 1e9).toLocaleString()}B`
    : "—";
  const defiChgText = Number.isFinite(defi?.change7dPct)
    ? signedSpan(defi.change7dPct, { digits: 2, unit: "%" })
    : "—";

  const latestPolicy = (policySignals || [])
    .slice()
    .sort((a, b) => new Date(b.time) - new Date(a.time))[0] || null;
  const latestPolicyTitle = latestPolicy ? translatePolicyTitle(latestPolicy.title || latestPolicy.keyChange) : "—";
  const latestPolicyBias = latestPolicy ? stripHtml(latestPolicy.shortTermBias || "震盪") : "震盪";

  const cards = [
    {
      title: "全市場（CoinGecko）",
      valueHtml: marketCapText,
      subLines: [
        `24h 市值變化：${capChgText}`,
        `24h 成交量：${volText}`,
        `BTC 市佔：${btcDomText}`
      ]
    },
    {
      title: "情緒指標（Fear & Greed）",
      valueHtml: fngText,
      subLines: ["僅供情緒參考，建議搭配資金流/槓桿與宏觀事件判讀。"]
    },
    {
      title: "利率 / 殖利率（FRED）",
      valueHtml: `10Y：${y10Text}`,
      subLines: [
        `2Y：${y2Text}｜3M：${y3mText}`,
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
      title: rateCutOutlook.mode === "concrete" ? "降息機率（市場隱含）" : "降息機率（模型估算）",
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
          "模型評估（非官方機率）"
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
        ? [
          `時間：${latestExternalTimeText}`,
          `短線（1-7天）：${stripHtml(latestExternal.shortTermBias || "震盪")}`
        ]
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

function renderPolicySignals(data) {
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
    const title = translatePolicyTitle(item.title || item.keyChange || "");
    const sourceName = translatePolicySourceName(item.sourceName || "官方來源");
    const impact = stripHtml(item.impact || "medium");
    const bias = stripHtml(item.shortTermBias || "震盪");

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

function renderSignals(data) {
  const root = document.getElementById("crypto-signals");
  root.innerHTML = "";

  let signals = data.cryptoSignals || [];
  if (onlyHighImpact) signals = signals.filter((signal) => signal.impact === "high");
  signals = [...signals].sort((a, b) => toTimestamp(b.time) - toTimestamp(a.time));

  signals.forEach((signal) => {
    const summary = stripHtml(signal.zhSummary || signal.summary || "");
    const impactText = stripHtml(signal.cryptoImpact || "市場影響評估中");
    const analysisText = stripHtml(signal.cryptoAnalysis || "等待更多資料補充分析");
    const changeText = stripHtml(signal.keyChange || "關鍵變化整理中");
    const shortBias = stripHtml(signal.shortTermBias || "震盪");
    const mergedHint = Number(signal.mergedCount || 1) > 1
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

function renderWhale(data) {
  const root = document.getElementById("whale-trend");
  const whale = data.whaleTrend || {};
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

function renderGlobalRisks(data) {
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

function renderAll(data) {
  renderMeta(data);
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
