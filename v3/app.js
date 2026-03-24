const UPSTASH_URL = "https://guided-spider-19708.upstash.io";
const UPSTASH_READ_TOKEN = "Akz8AAIgcDE18SAeYebRfjHOi1t_RtbOFNv2r3NHF0kLYfDIUMnEOw";
const UPSTASH_KEY = "cryptopulse:database:coinglass:derivatives";

const ASSETS = [
  {
    id: "BTC",
    label: "BTC",
    pair: "Binance:BTCUSDT",
    etfKey: "bitcoin"
  },
  {
    id: "ETH",
    label: "ETH",
    pair: "Binance:ETHUSDT",
    etfKey: "ethereum"
  }
];

const STREAM_CATALOG = {
  openInterestAggregated: {
    label: "總持倉量 OI",
    description: "整體衍生品未平倉量，適合觀察市場槓桿是否在擴張或收縮。"
  },
  openInterestAggregatedStablecoinMargin: {
    label: "穩定幣保證金 OI",
    description: "觀察以穩定幣保證金為主的倉位變化，通常較偏向主流合約資金。"
  },
  openInterestAggregatedCoinMargin: {
    label: "幣本位保證金 OI",
    description: "觀察幣本位部位的堆積情況，常用來看市場是否偏向長期持幣型槓桿。"
  },
  aggregatedLiquidation: {
    label: "聚合清算",
    description: "只看風險出清，不把清算直接視為偏多；重點在長短雙邊誰被洗掉。"
  },
  fundingRate: {
    label: "Funding Rate",
    description: "Binance 永續合約資金費率，可觀察多空誰在付費。"
  },
  topLongShortAccountRatio: {
    label: "大戶帳戶多空比",
    description: "看大戶帳戶數量分布，比較偏向情緒與站隊。"
  },
  topLongShortPositionRatio: {
    label: "大戶持倉多空比",
    description: "看大戶實際倉位傾向，比帳戶數更接近真實押注方向。"
  },
  globalLongShortAccountRatio: {
    label: "全市場多空比",
    description: "看整體市場帳戶分布，有助於判讀散戶/中型資金偏向。"
  },
  aggregatedTakerBuySellVolume: {
    label: "主動買賣量",
    description: "用 taker 主動成交方向看即時攻擊性買盤或賣盤是否占優。"
  },
  aggregatedCvd: {
    label: "CVD",
    description: "累積成交量差，常用來觀察趨勢是否有真實主動流支撐。"
  },
  futuresBasis: {
    label: "期貨基差",
    description: "看永續 / 期貨結構是否擴張，常用於判讀情緒與期限結構。"
  },
  etfFlowHistory: {
    label: "ETF Flow",
    description: "日線 ETF 淨流入/流出，直接反映現貨 ETF 資金偏向。"
  },
  bitcoinEtfNetAssets: {
    label: "Bitcoin ETF 淨資產",
    description: "追蹤比特幣 ETF 總淨資產與日變化，用於看機構承接規模。"
  },
  hyperliquidWhaleAlert: {
    label: "Hyperliquid Whale Alert",
    description: "最新巨鯨開倉/平倉事件，反映大額資金剛剛做了什麼動作。"
  },
  hyperliquidWhalePosition: {
    label: "Hyperliquid Whale Position",
    description: "目前仍在場上的 Hyperliquid 大戶倉位，適合看大部位方向、槓桿與 PnL。"
  },
  hyperliquidWalletPositionDistribution: {
    label: "Hyperliquid Wallet Position Distribution",
    description: "依倉位層級統計地址數、多空偏向與盈虧分布，可快速看巨鯨族群站哪邊。"
  }
};

const compactNumberFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2
});

const compactUsdFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2
});

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getRecordTime(record) {
  if (!record || typeof record !== "object") return 0;
  return Number(record.time ?? record.timestamp ?? 0) || 0;
}

function formatDateTime(value) {
  const time = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(time) || time <= 0) return "—";
  return new Intl.DateTimeFormat("zh-Hant", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC"
  }).format(new Date(time));
}

function formatCompactUsd(value, { signed = false } = {}) {
  const num = toNumber(value);
  if (num === null) return "—";
  const abs = compactUsdFormatter.format(Math.abs(num));
  const prefix = signed && num > 0 ? "+" : num < 0 ? "-" : "";
  return `${prefix}$${abs}`;
}

function formatCompactNumber(value, { signed = false } = {}) {
  const num = toNumber(value);
  if (num === null) return "—";
  const abs = compactNumberFormatter.format(Math.abs(num));
  const prefix = signed && num > 0 ? "+" : num < 0 ? "-" : "";
  return `${prefix}${abs}`;
}

function formatRatio(value) {
  const num = toNumber(value);
  if (num === null) return "—";
  return num.toFixed(2);
}

function formatPercent(value, { factor = 1, signed = false, digits = 2 } = {}) {
  const num = toNumber(value);
  if (num === null) return "—";
  const actual = num * factor;
  const prefix = signed && actual > 0 ? "+" : actual < 0 ? "-" : "";
  return `${prefix}${Math.abs(actual).toFixed(digits)}%`;
}

function classBySign(value, { invert = false, flatThreshold = 0 } = {}) {
  const num = toNumber(value);
  if (num === null) return "text-muted";
  if (Math.abs(num) <= flatThreshold) return "text-flat";
  if (num > 0) return invert ? "text-down" : "text-up";
  return invert ? "text-up" : "text-down";
}

function spanByClass(text, className) {
  return `<span class="${className}">${escapeHtml(text)}</span>`;
}

function formatDeltaHtml(value, formatter, { invert = false, flatThreshold = 0 } = {}) {
  const num = toNumber(value);
  if (num === null) return spanByClass("—", "text-muted");
  const className = classBySign(num, { invert, flatThreshold });
  return `<span class="${className}">${escapeHtml(formatter(num))}</span>`;
}

function getStream(payload, streamKey) {
  return payload?.streams?.[streamKey] || { series: {}, meta: {}, interval: "—" };
}

function getSeries(payload, streamKey, seriesKey) {
  const stream = getStream(payload, streamKey);
  const series = stream?.series?.[seriesKey];
  return Array.isArray(series) ? series : [];
}

function getSnapshotList(payload, streamKey, seriesKey = "latest") {
  return getSeries(payload, streamKey, seriesKey);
}

function latest(series) {
  return Array.isArray(series) && series.length ? series[series.length - 1] : null;
}

function previous(series) {
  return Array.isArray(series) && series.length > 1 ? series[series.length - 2] : null;
}

function sumLast(series, key, count) {
  const list = Array.isArray(series) ? series.slice(-count) : [];
  return list.reduce((sum, item) => sum + (toNumber(item?.[key]) || 0), 0);
}

function lastNValues(series, key, count = 30) {
  return (Array.isArray(series) ? series.slice(-count) : [])
    .map((item) => toNumber(item?.[key]))
    .filter((value) => value !== null);
}

function sparklineSvg(values) {
  if (!Array.isArray(values) || values.length < 2) {
    return '<svg class="sparkline" viewBox="0 0 220 64" role="img" aria-label="資料不足"><path class="sparkline-bg" d="M0 32 H220" /></svg>';
  }

  const width = 220;
  const height = 64;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 8) - 4;
    return [Number(x.toFixed(2)), Number(y.toFixed(2))];
  });

  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join(" ");
  const area = `${line} L ${points[points.length - 1][0]} ${height} L ${points[0][0]} ${height} Z`;

  return `
    <svg class="sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="最近趨勢">
      <path class="sparkline-bg" d="M0 ${height / 2} H${width}" />
      <path class="sparkline-area" d="${area}" />
      <path class="sparkline-line" d="${line}" />
    </svg>
  `;
}

function metricCard({ title, main, sub = "", rows = [], sparkline = "", note = "" }) {
  return `
    <article class="metric-card">
      <h4>${escapeHtml(title)}</h4>
      <div class="metric-main">${main}</div>
      ${sub ? `<div class="metric-sub">${sub}</div>` : ""}
      ${rows.length ? `
        <div class="metric-inline-list">
          ${rows.map((row) => `
            <div class="metric-inline-row">
              <span>${escapeHtml(row.label)}</span>
              <span>${row.value}</span>
            </div>
          `).join("")}
        </div>
      ` : ""}
      ${sparkline}
      ${note ? `<div class="mini-note">${escapeHtml(note)}</div>` : ""}
    </article>
  `;
}

function assetSummary(payload, asset) {
  const oiSeries = getSeries(payload, "openInterestAggregated", asset.id);
  const liqSeries = getSeries(payload, "aggregatedLiquidation", asset.id);
  const fundingSeries = getSeries(payload, "fundingRate", asset.pair);
  const globalRatioSeries = getSeries(payload, "globalLongShortAccountRatio", asset.pair);
  const topAccountSeries = getSeries(payload, "topLongShortAccountRatio", asset.pair);
  const topPositionSeries = getSeries(payload, "topLongShortPositionRatio", asset.pair);
  const takerSeries = getSeries(payload, "aggregatedTakerBuySellVolume", asset.id);
  const cvdSeries = getSeries(payload, "aggregatedCvd", asset.id);
  const basisSeries = getSeries(payload, "futuresBasis", asset.pair);

  const oiLatest = latest(oiSeries);
  const oiPrev = previous(oiSeries);
  const liqLatest = latest(liqSeries);
  const fundingLatest = latest(fundingSeries);
  const globalLatest = latest(globalRatioSeries);
  const topAccountLatest = latest(topAccountSeries);
  const topPositionLatest = latest(topPositionSeries);
  const takerLatest = latest(takerSeries);
  const cvdLatest = latest(cvdSeries);
  const basisLatest = latest(basisSeries);

  return {
    asset,
    oiSeries,
    liqSeries,
    fundingSeries,
    globalRatioSeries,
    topAccountSeries,
    topPositionSeries,
    takerSeries,
    cvdSeries,
    basisSeries,
    oiLatest,
    oiPrev,
    liqLatest,
    fundingLatest,
    globalLatest,
    topAccountLatest,
    topPositionLatest,
    takerLatest,
    cvdLatest,
    basisLatest,
    oiChange: (toNumber(oiLatest?.closeUsd) || 0) - (toNumber(oiPrev?.closeUsd) || 0),
    fundingPct: (toNumber(fundingLatest?.close) || 0) * 100,
    netTaker: toNumber(takerLatest?.netTakerVolumeUsd) || 0,
    cvd: toNumber(cvdLatest?.cumulativeVolumeDeltaUsd) || 0,
    basis: toNumber(basisLatest?.closeBasis),
    basisChange: toNumber(basisLatest?.closeChange),
    liquidation: toNumber(liqLatest?.totalLiquidationUsd) || 0
  };
}

function renderHeroMeta(payload) {
  const streamKeys = Object.keys(payload?.streams || {});
  const totalSeries = streamKeys.reduce((sum, key) => sum + Object.keys(payload?.streams?.[key]?.series || {}).length, 0);
  const latestTimes = streamKeys.flatMap((key) => {
    const seriesMap = payload?.streams?.[key]?.series || {};
    return Object.values(seriesMap)
      .map((series) => getRecordTime(latest(series)))
      .filter((value) => Number.isFinite(value) && value > 0);
  });
  const latestPoint = latestTimes.length ? Math.max(...latestTimes) : 0;

  $("hero-meta").innerHTML = `
    <article class="meta-card">
      <div class="meta-label">最後更新</div>
      <div class="meta-value">${escapeHtml(payload?.updatedAt ? formatDateTime(new Date(payload.updatedAt).getTime()) : "—")}</div>
    </article>
    <article class="meta-card">
      <div class="meta-label">最新資料點時間</div>
      <div class="meta-value">${escapeHtml(formatDateTime(latestPoint))}</div>
    </article>
    <article class="meta-card">
      <div class="meta-label">追蹤 stream 數</div>
      <div class="meta-value">${escapeHtml(String(streamKeys.length))}</div>
    </article>
    <article class="meta-card">
      <div class="meta-label">追蹤 series 數</div>
      <div class="meta-value">${escapeHtml(String(totalSeries))}</div>
    </article>
  `;
}

function renderOverview(payload) {
  const btc = assetSummary(payload, ASSETS[0]);
  const eth = assetSummary(payload, ASSETS[1]);
  const btcEtfSeries = getSeries(payload, "etfFlowHistory", "bitcoin");
  const ethEtfSeries = getSeries(payload, "etfFlowHistory", "ethereum");
  const btcEtfLatest = latest(btcEtfSeries);
  const ethEtfLatest = latest(ethEtfSeries);
  const netAssetSeries = getSeries(payload, "bitcoinEtfNetAssets", "bitcoin");
  const netAssetLatest = latest(netAssetSeries);

  const cards = [
    {
      title: "BTC 總 OI",
      value: formatCompactUsd(btc.oiLatest?.closeUsd),
      note: `4h 變化 ${stripHtmlValue(formatDeltaHtml(btc.oiChange, (v) => formatCompactUsd(v, { signed: true })))}｜最新 ${formatDateTime(getRecordTime(btc.oiLatest))}`,
      className: classBySign(btc.oiChange)
    },
    {
      title: "ETH 總 OI",
      value: formatCompactUsd(eth.oiLatest?.closeUsd),
      note: `4h 變化 ${stripHtmlValue(formatDeltaHtml(eth.oiChange, (v) => formatCompactUsd(v, { signed: true })))}｜最新 ${formatDateTime(getRecordTime(eth.oiLatest))}`,
      className: classBySign(eth.oiChange)
    },
    {
      title: "BTC 清算風險",
      value: formatCompactUsd(btc.liquidation),
      note: `長單 ${formatCompactUsd(btc.liqLatest?.longLiquidationUsd)}｜短單 ${formatCompactUsd(btc.liqLatest?.shortLiquidationUsd)}`,
      className: classBySign(btc.liquidation, { invert: true, flatThreshold: 1000000 })
    },
    {
      title: "ETH 清算風險",
      value: formatCompactUsd(eth.liquidation),
      note: `長單 ${formatCompactUsd(eth.liqLatest?.longLiquidationUsd)}｜短單 ${formatCompactUsd(eth.liqLatest?.shortLiquidationUsd)}`,
      className: classBySign(eth.liquidation, { invert: true, flatThreshold: 1000000 })
    },
    {
      title: "BTC Funding",
      value: formatPercent(btc.fundingLatest?.close, { factor: 100, signed: true, digits: 3 }),
      note: `8h 高低 ${formatPercent(btc.fundingLatest?.high, { factor: 100, digits: 3 })} / ${formatPercent(btc.fundingLatest?.low, { factor: 100, digits: 3 })}`,
      className: classBySign(btc.fundingPct)
    },
    {
      title: "ETH Funding",
      value: formatPercent(eth.fundingLatest?.close, { factor: 100, signed: true, digits: 3 }),
      note: `8h 高低 ${formatPercent(eth.fundingLatest?.high, { factor: 100, digits: 3 })} / ${formatPercent(eth.fundingLatest?.low, { factor: 100, digits: 3 })}`,
      className: classBySign(eth.fundingPct)
    },
    {
      title: "Bitcoin ETF 當日流向",
      value: formatCompactUsd(btcEtfLatest?.flowUsd, { signed: true }),
      note: `近 7 日累積 ${formatCompactUsd(sumLast(btcEtfSeries, "flowUsd", 7), { signed: true })}`,
      className: classBySign(btcEtfLatest?.flowUsd)
    },
    {
      title: "Ethereum ETF 當日流向",
      value: formatCompactUsd(ethEtfLatest?.flowUsd, { signed: true }),
      note: `近 7 日累積 ${formatCompactUsd(sumLast(ethEtfSeries, "flowUsd", 7), { signed: true })}`,
      className: classBySign(ethEtfLatest?.flowUsd)
    },
    {
      title: "Bitcoin ETF 淨資產",
      value: formatCompactUsd(netAssetLatest?.netAssetsUsd),
      note: `日變化 ${formatCompactUsd(netAssetLatest?.changeUsd, { signed: true })}`,
      className: classBySign(netAssetLatest?.changeUsd)
    }
  ];

  $("overview-cards").innerHTML = cards
    .map((card) => `
      <article class="overview-card">
        <div class="overview-title">${escapeHtml(card.title)}</div>
        <div class="overview-value ${card.className}">${escapeHtml(card.value)}</div>
        <div class="overview-note">${escapeHtml(card.note)}</div>
      </article>
    `)
    .join("");
}

function stripHtmlValue(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || div.innerText || "";
}

function renderRadar(payload) {
  const rows = ASSETS.map((asset) => {
    const summary = assetSummary(payload, asset);
    return `
      <tr>
        <td><strong>${escapeHtml(asset.label)}</strong></td>
        <td>${escapeHtml(formatCompactUsd(summary.oiLatest?.closeUsd))}</td>
        <td>${formatDeltaHtml(summary.liquidation, (v) => formatCompactUsd(v), { invert: true, flatThreshold: 1000000 })}</td>
        <td>${formatDeltaHtml(summary.fundingPct, (v) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}%`, { flatThreshold: 0.005 })}</td>
        <td>${ratioHtml(summary.globalLatest?.longShortRatio)}</td>
        <td>${ratioHtml(summary.topAccountLatest?.longShortRatio)}</td>
        <td>${ratioHtml(summary.topPositionLatest?.longShortRatio)}</td>
        <td>${formatDeltaHtml(summary.netTaker, (v) => formatCompactUsd(v, { signed: true }))}</td>
        <td>${formatDeltaHtml(summary.cvd, (v) => formatCompactUsd(v, { signed: true }))}</td>
        <td>${formatDeltaHtml(summary.basisChange, (v) => `${v >= 0 ? "+" : ""}${Number(v).toFixed(4)}`)}<div class="mini-note">現值 ${escapeHtml(summary.basis === null ? "—" : summary.basis.toFixed(4))}</div></td>
      </tr>
    `;
  });

  $("asset-radar-body").innerHTML = rows.join("");
}

function ratioHtml(value) {
  const num = toNumber(value);
  if (num === null) return spanByClass("—", "text-muted");
  const className = num > 1.02 ? "text-up" : num < 0.98 ? "text-down" : "text-flat";
  return spanByClass(num.toFixed(2), className);
}

function renderAssetPanels(payload) {
  $("asset-panels").innerHTML = ASSETS.map((asset) => buildAssetPanel(payload, asset)).join("");
}

function shortenAddress(value) {
  const text = String(value || "").trim();
  if (text.length <= 12) return text || "—";
  return `${text.slice(0, 6)}..${text.slice(-4)}`;
}

function whaleActionInfo(item) {
  const action = Number(item?.positionAction);
  const size = toNumber(item?.positionSize) || 0;
  const isLong = size > 0;
  if (action === 1 && isLong) return { label: "開多", className: "whale-action-open" };
  if (action === 1 && size < 0) return { label: "開空", className: "whale-action-open" };
  if (action === 2 && isLong) return { label: "平多", className: "whale-action-close" };
  if (action === 2 && size < 0) return { label: "平空", className: "whale-action-close" };
  return { label: "未知", className: "whale-action-neutral" };
}

function whaleSideInfo(item) {
  const size = toNumber(item?.positionSize) || 0;
  if (size > 0) return { label: "多", className: "whale-side-long" };
  if (size < 0) return { label: "空", className: "whale-side-short" };
  return { label: "中性", className: "whale-side-neutral" };
}

function whaleTierLabel(groupName) {
  const map = {
    shrimp: "小蝦",
    fish: "小魚",
    dolphin: "海豚",
    apex_predator: "掠食者",
    small_whale: "小鯨",
    whale: "鯨魚",
    tidal_whale: "巨潮鯨",
    leviathan: "利維坦"
  };
  return map[groupName] || groupName || "—";
}

function whaleBiasLabel(value) {
  const map = {
    bearish: "偏空",
    slightly_bearish: "略偏空",
    indecisive: "中性",
    bullish: "偏多",
    very_bullish: "很偏多",
    slightly_bullish: "略偏多"
  };
  return map[value] || value || "—";
}

function whaleOverviewClass(actionClassName) {
  if (actionClassName === "whale-action-open") return "text-up";
  if (actionClassName === "whale-action-close") return "text-down";
  return "text-flat";
}

function renderWhales(payload) {
  const alerts = getSnapshotList(payload, "hyperliquidWhaleAlert")
    .slice()
    .sort((a, b) => getRecordTime(b) - getRecordTime(a));
  const positions = getSnapshotList(payload, "hyperliquidWhalePosition")
    .slice()
    .sort((a, b) => (toNumber(b?.positionValueUsd) || 0) - (toNumber(a?.positionValueUsd) || 0));
  const distributions = getSnapshotList(payload, "hyperliquidWalletPositionDistribution")
    .slice()
    .sort((a, b) => (toNumber(a?.minimumAmount) || 0) - (toNumber(b?.minimumAmount) || 0));

  const totalPositionUsd = positions.reduce((sum, item) => sum + (toNumber(item?.positionValueUsd) || 0), 0);
  const netDirectionalUsd = positions.reduce((sum, item) => {
    const size = toNumber(item?.positionSize) || 0;
    const value = toNumber(item?.positionValueUsd) || 0;
    return sum + (size >= 0 ? value : -value);
  }, 0);
  const longCount = positions.filter((item) => (toNumber(item?.positionSize) || 0) > 0).length;
  const shortCount = positions.filter((item) => (toNumber(item?.positionSize) || 0) < 0).length;
  const recentOpenCount = alerts.filter((item) => Number(item?.positionAction) === 1).length;
  const recentCloseCount = alerts.filter((item) => Number(item?.positionAction) === 2).length;
  const latestAlert = alerts[0] || null;
  const strongestTier = distributions
    .slice()
    .sort((a, b) => Math.abs(toNumber(b?.biasScore) || 0) - Math.abs(toNumber(a?.biasScore) || 0))[0] || null;

  $("whale-overview").innerHTML = [
    {
      title: "最新警報數",
      value: formatCompactNumber(alerts.length),
      note: `開倉 ${recentOpenCount}｜平倉 ${recentCloseCount}`,
      className: "text-flat"
    },
    {
      title: "在場大戶總倉值",
      value: formatCompactUsd(totalPositionUsd),
      note: `多單 ${longCount}｜空單 ${shortCount}`,
      className: "text-up"
    },
    {
      title: "方向性淨倉值",
      value: formatCompactUsd(netDirectionalUsd, { signed: true }),
      note: "正值代表大戶整體偏多，負值代表偏空",
      className: classBySign(netDirectionalUsd)
    },
    {
      title: "最強偏向族群",
      value: strongestTier ? whaleTierLabel(strongestTier.groupName) : "—",
      note: strongestTier ? `${whaleBiasLabel(strongestTier.biasRemark)}｜Bias ${Number(strongestTier.biasScore || 0).toFixed(2)}` : "尚無分布資料",
      className: strongestTier ? classBySign(strongestTier.biasScore, { flatThreshold: 0.08 }) : "text-muted"
    },
    {
      title: "最新巨鯨動作",
      value: latestAlert ? shortenAddress(latestAlert.user) : "—",
      note: latestAlert ? `${latestAlert.symbol}｜${whaleActionInfo(latestAlert).label}｜${formatCompactUsd(latestAlert.positionValueUsd)}` : "尚無巨鯨警報",
      className: latestAlert ? whaleOverviewClass(whaleActionInfo(latestAlert).className) : "text-muted"
    }
  ].map((card) => `
    <article class="overview-card">
      <div class="overview-title">${escapeHtml(card.title)}</div>
      <div class="overview-value ${card.className}">${escapeHtml(card.value)}</div>
      <div class="overview-note">${escapeHtml(card.note)}</div>
    </article>
  `).join("");

  $("whale-alert-body").innerHTML = alerts.slice(0, 12).map((item) => {
    const action = whaleActionInfo(item);
    return `
      <tr>
        <td>${escapeHtml(formatDateTime(getRecordTime(item)))}</td>
        <td><span class="mono">${escapeHtml(shortenAddress(item.user))}</span></td>
        <td>${escapeHtml(item.symbol || "—")}</td>
        <td><span class="whale-action ${action.className}">${escapeHtml(action.label)}</span></td>
        <td>${formatDeltaHtml(item.positionValueUsd, (v) => formatCompactUsd(v))}</td>
        <td>
          ${escapeHtml(formatCompactNumber(item.entryPrice))}
          <div class="mini-note">強平 ${escapeHtml(formatCompactNumber(item.liquidationPrice))}</div>
        </td>
      </tr>
    `;
  }).join("") || `
    <tr>
      <td colspan="6" class="text-muted">目前尚未同步到巨鯨警報資料。</td>
    </tr>
  `;

  $("whale-position-body").innerHTML = positions.slice(0, 12).map((item) => {
    const side = whaleSideInfo(item);
    return `
      <tr>
        <td><span class="mono">${escapeHtml(shortenAddress(item.user))}</span></td>
        <td>${escapeHtml(item.symbol || "—")}</td>
        <td><span class="whale-side ${side.className}">${escapeHtml(side.label)}</span></td>
        <td>${formatDeltaHtml(item.positionValueUsd, (v) => formatCompactUsd(v))}</td>
        <td>${formatDeltaHtml(item.unrealizedPnlUsd, (v) => formatCompactUsd(v, { signed: true }))}</td>
        <td>${escapeHtml(item.leverage ? `${Number(item.leverage).toFixed(0)}x ${item.marginMode || ""}`.trim() : "—")}</td>
        <td>${escapeHtml(formatDateTime(item.updateTime || item.time))}</td>
      </tr>
    `;
  }).join("") || `
    <tr>
      <td colspan="7" class="text-muted">目前尚未同步到大戶持倉資料。</td>
    </tr>
  `;

  $("whale-distribution").innerHTML = distributions.map((item) => `
    <article class="whale-tier-card">
      <div class="whale-tier-title-row">
        <h3>${escapeHtml(whaleTierLabel(item.groupName))}</h3>
        <span class="whale-tag ${classBySign(item.biasScore, { flatThreshold: 0.08 })}">${escapeHtml(whaleBiasLabel(item.biasRemark))}</span>
      </div>
      <div class="metric-main ${classBySign(item.biasScore, { flatThreshold: 0.08 })}">${escapeHtml(formatCompactUsd(item.positionUsd))}</div>
      <div class="metric-inline-list">
        <div class="metric-inline-row"><span>持倉地址</span><span>${escapeHtml(formatCompactNumber(item.positionAddressCount))} (${escapeHtml(formatPercent(item.positionAddressPercent))})</span></div>
        <div class="metric-inline-row"><span>Long / Short</span><span>${escapeHtml(formatPercent(item.longPositionUsdPercent))} / ${escapeHtml(formatPercent(item.shortPositionUsdPercent))}</span></div>
        <div class="metric-inline-row"><span>獲利 / 虧損地址</span><span>${escapeHtml(formatPercent(item.profitAddressPercent))} / ${escapeHtml(formatPercent(item.lossAddressPercent))}</span></div>
        <div class="metric-inline-row"><span>倉位區間</span><span>${escapeHtml(`${formatCompactNumber(item.minimumAmount)} - ${formatCompactNumber(item.maximumAmount)}`)}</span></div>
      </div>
      <div class="whale-tag-row">
        <span class="whale-tag">Bias ${escapeHtml(Number(item.biasScore || 0).toFixed(2))}</span>
        <span class="whale-tag">總地址 ${escapeHtml(formatCompactNumber(item.allAddressCount))}</span>
      </div>
    </article>
  `).join("") || `<article class="whale-tier-card"><div class="text-muted">目前尚未同步到倉位分布資料。</div></article>`;
}

function buildAssetPanel(payload, asset) {
  const summary = assetSummary(payload, asset);
  const stableSeries = getSeries(payload, "openInterestAggregatedStablecoinMargin", asset.id);
  const coinSeries = getSeries(payload, "openInterestAggregatedCoinMargin", asset.id);
  const stableLatest = latest(stableSeries);
  const stablePrev = previous(stableSeries);
  const coinLatest = latest(coinSeries);
  const coinPrev = previous(coinSeries);

  const cards = [
    metricCard({
      title: "總持倉量 OI",
      main: escapeHtml(formatCompactUsd(summary.oiLatest?.closeUsd)),
      sub: `最新時間 ${formatDateTime(getRecordTime(summary.oiLatest))}`,
      rows: [
        {
          label: "4h 變化",
          value: formatDeltaHtml(summary.oiChange, (v) => formatCompactUsd(v, { signed: true }))
        },
        {
          label: "區間高低",
          value: `${escapeHtml(formatCompactUsd(summary.oiLatest?.highUsd))} / ${escapeHtml(formatCompactUsd(summary.oiLatest?.lowUsd))}`
        }
      ],
      sparkline: sparklineSvg(lastNValues(summary.oiSeries, "closeUsd")),
      note: "越高不代表一定偏多，重點是看增長是否配合資金費率與主動成交方向。"
    }),
    metricCard({
      title: "穩定幣保證金 OI",
      main: escapeHtml(formatCompactNumber(stableLatest?.close)),
      sub: "同樣是 4h 結構序列",
      rows: [
        {
          label: "4h 變化",
          value: formatDeltaHtml((toNumber(stableLatest?.close) || 0) - (toNumber(stablePrev?.close) || 0), (v) => formatCompactNumber(v, { signed: true }))
        },
        {
          label: "區間高低",
          value: `${escapeHtml(formatCompactNumber(stableLatest?.high))} / ${escapeHtml(formatCompactNumber(stableLatest?.low))}`
        }
      ],
      sparkline: sparklineSvg(lastNValues(stableSeries, "close")),
      note: "適合拿來觀察主流 USDT/USDC 保證金部位是否持續加槓桿。"
    }),
    metricCard({
      title: "幣本位保證金 OI",
      main: escapeHtml(formatCompactNumber(coinLatest?.close)),
      sub: "同樣是 4h 結構序列",
      rows: [
        {
          label: "4h 變化",
          value: formatDeltaHtml((toNumber(coinLatest?.close) || 0) - (toNumber(coinPrev?.close) || 0), (v) => formatCompactNumber(v, { signed: true }))
        },
        {
          label: "區間高低",
          value: `${escapeHtml(formatCompactNumber(coinLatest?.high))} / ${escapeHtml(formatCompactNumber(coinLatest?.low))}`
        }
      ],
      sparkline: sparklineSvg(lastNValues(coinSeries, "close")),
      note: "幣本位部位通常更容易反映持幣者是否願意用資產本身放大敞口。"
    }),
    metricCard({
      title: "清算壓力",
      main: spanByClass(formatCompactUsd(summary.liquidation), classBySign(summary.liquidation, { invert: true, flatThreshold: 1000000 })),
      sub: `最新時間 ${formatDateTime(getRecordTime(summary.liqLatest))}`,
      rows: [
        {
          label: "長單清算",
          value: escapeHtml(formatCompactUsd(summary.liqLatest?.longLiquidationUsd))
        },
        {
          label: "短單清算",
          value: escapeHtml(formatCompactUsd(summary.liqLatest?.shortLiquidationUsd))
        }
      ],
      sparkline: sparklineSvg(lastNValues(summary.liqSeries, "totalLiquidationUsd")),
      note: "清算是風險指標，不直接等於利多；越大代表最近這一段槓桿出清越劇烈。"
    }),
    metricCard({
      title: "Funding / Basis",
      main: spanByClass(formatPercent(summary.fundingLatest?.close, { factor: 100, signed: true, digits: 3 }), classBySign(summary.fundingPct, { flatThreshold: 0.005 })),
      sub: `Basis 現值 ${summary.basis === null ? "—" : summary.basis.toFixed(4)}`,
      rows: [
        {
          label: "Funding 高低",
          value: `${escapeHtml(formatPercent(summary.fundingLatest?.high, { factor: 100, digits: 3 }))} / ${escapeHtml(formatPercent(summary.fundingLatest?.low, { factor: 100, digits: 3 }))}`
        },
        {
          label: "Basis 變化",
          value: formatDeltaHtml(summary.basisChange, (v) => `${v >= 0 ? "+" : ""}${Number(v).toFixed(4)}`)
        }
      ],
      sparkline: sparklineSvg(lastNValues(summary.fundingSeries, "close")),
      note: "Funding 看誰在付費；Basis 看期限結構是否在擴張。兩者一起看比較有判讀價值。"
    }),
    metricCard({
      title: "多空結構",
      main: ratioHtml(summary.topPositionLatest?.longShortRatio),
      sub: "主標顯示大戶持倉多空比",
      rows: [
        {
          label: "全市場",
          value: `${ratioHtml(summary.globalLatest?.longShortRatio)} <span class="text-muted">(${formatPercent(summary.globalLatest?.longPercent)} / ${formatPercent(summary.globalLatest?.shortPercent)})</span>`
        },
        {
          label: "大戶帳戶",
          value: `${ratioHtml(summary.topAccountLatest?.longShortRatio)} <span class="text-muted">(${formatPercent(summary.topAccountLatest?.longPercent)} / ${formatPercent(summary.topAccountLatest?.shortPercent)})</span>`
        },
        {
          label: "大戶持倉",
          value: `${ratioHtml(summary.topPositionLatest?.longShortRatio)} <span class="text-muted">(${formatPercent(summary.topPositionLatest?.longPercent)} / ${formatPercent(summary.topPositionLatest?.shortPercent)})</span>`
        }
      ],
      sparkline: sparklineSvg(lastNValues(summary.topPositionSeries, "longShortRatio")),
      note: "若大戶帳戶偏空、但大戶持倉偏多，常代表少數大部位與大多數帳戶站位不同。"
    }),
    metricCard({
      title: "主動買賣量",
      main: spanByClass(formatCompactUsd(summary.netTaker, { signed: true }), classBySign(summary.netTaker)),
      sub: "正值代表主動買盤較強，負值代表主動賣盤較強",
      rows: [
        {
          label: "主動買量",
          value: escapeHtml(formatCompactUsd(summary.takerLatest?.takerBuyVolumeUsd))
        },
        {
          label: "主動賣量",
          value: escapeHtml(formatCompactUsd(summary.takerLatest?.takerSellVolumeUsd))
        }
      ],
      sparkline: sparklineSvg(lastNValues(summary.takerSeries, "netTakerVolumeUsd")),
      note: "這是 4h 即時攻擊方向；與 OI 同步上升時，通常更值得注意。"
    }),
    metricCard({
      title: "CVD",
      main: spanByClass(formatCompactUsd(summary.cvd, { signed: true }), classBySign(summary.cvd)),
      sub: "累積成交量差",
      rows: [
        {
          label: "Taker 買量",
          value: escapeHtml(formatCompactUsd(summary.cvdLatest?.takerBuyVolumeUsd))
        },
        {
          label: "Taker 賣量",
          value: escapeHtml(formatCompactUsd(summary.cvdLatest?.takerSellVolumeUsd))
        }
      ],
      sparkline: sparklineSvg(lastNValues(summary.cvdSeries, "cumulativeVolumeDeltaUsd")),
      note: "CVD 偏強通常代表漲勢比較有主動流支撐；偏弱時則較容易出現上攻無量。"
    })
  ];

  return `
    <section class="asset-panel">
      <div class="asset-panel-head">
        <div>
          <h3>${escapeHtml(asset.label)} 衍生品結構</h3>
          <div class="stream-note">以最新 4h / 8h 資料整理，不顯示價格，只看槓桿與資金流。</div>
        </div>
        <div class="asset-badge">${escapeHtml(asset.pair)}</div>
      </div>
      <div class="asset-panel-grid">
        ${cards.join("")}
      </div>
    </section>
  `;
}

function renderEtf(payload) {
  const flowCards = ASSETS.map((asset) => buildEtfFlowCard(payload, asset));
  flowCards.push(buildBitcoinNetAssetCard(payload));
  $("etf-panels").innerHTML = flowCards.join("");
}

function buildEtfFlowCard(payload, asset) {
  const series = getSeries(payload, "etfFlowHistory", asset.etfKey);
  const item = latest(series);
  const recent7d = sumLast(series, "flowUsd", 7);
  const recent30d = sumLast(series, "flowUsd", 30);
  const breakdown = Array.isArray(item?.etfFlows) ? item.etfFlows.slice().sort((a, b) => Math.abs(b.flowUsd) - Math.abs(a.flowUsd)).slice(0, 5) : [];

  return `
    <article class="etf-card">
      <div class="etf-card-head">
        <h3>${escapeHtml(asset.label === "BTC" ? "Bitcoin ETF Flow" : "Ethereum ETF Flow")}</h3>
        <div class="asset-badge">${escapeHtml(asset.etfKey)}</div>
      </div>
      <div class="metric-main ${classBySign(item?.flowUsd)}">${escapeHtml(formatCompactUsd(item?.flowUsd, { signed: true }))}</div>
      <div class="etf-note">最新日資料：${escapeHtml(formatDateTime(getRecordTime(item)))}</div>
      <div class="metric-inline-list">
        <div class="metric-inline-row"><span>近 7 日</span><span>${formatDeltaHtml(recent7d, (v) => formatCompactUsd(v, { signed: true }))}</span></div>
        <div class="metric-inline-row"><span>近 30 日</span><span>${formatDeltaHtml(recent30d, (v) => formatCompactUsd(v, { signed: true }))}</span></div>
      </div>
      ${sparklineSvg(lastNValues(series, "flowUsd"))}
      ${breakdown.length ? `
        <table class="mini-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>最新流向</th>
            </tr>
          </thead>
          <tbody>
            ${breakdown.map((row) => `
              <tr>
                <td>${escapeHtml(row.ticker)}</td>
                <td>${formatDeltaHtml(row.flowUsd, (v) => formatCompactUsd(v, { signed: true }))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      ` : `<div class="etf-note">此日未提供 ETF ticker breakdown。</div>`}
    </article>
  `;
}

function buildBitcoinNetAssetCard(payload) {
  const series = getSeries(payload, "bitcoinEtfNetAssets", "bitcoin");
  const item = latest(series);

  return `
    <article class="etf-card">
      <div class="etf-card-head">
        <h3>Bitcoin ETF 淨資產</h3>
        <div class="asset-badge">bitcoin</div>
      </div>
      <div class="metric-main">${escapeHtml(formatCompactUsd(item?.netAssetsUsd))}</div>
      <div class="etf-note">最新日資料：${escapeHtml(formatDateTime(getRecordTime(item)))}</div>
      <div class="metric-inline-list">
        <div class="metric-inline-row"><span>日變化</span><span>${formatDeltaHtml(item?.changeUsd, (v) => formatCompactUsd(v, { signed: true }))}</span></div>
        <div class="metric-inline-row"><span>近 7 日變化</span><span>${formatDeltaHtml(sumLast(series, "changeUsd", 7), (v) => formatCompactUsd(v, { signed: true }))}</span></div>
        <div class="metric-inline-row"><span>近 30 日變化</span><span>${formatDeltaHtml(sumLast(series, "changeUsd", 30), (v) => formatCompactUsd(v, { signed: true }))}</span></div>
      </div>
      ${sparklineSvg(lastNValues(series, "netAssetsUsd"))}
      <div class="etf-note">這裡看的是 ETF 總承接規模，不是幣價；適合搭配 ETF 日流量一起看。</div>
    </article>
  `;
}

function renderCatalog(payload) {
  const streamKeys = Object.keys(payload?.streams || {});
  $("stream-catalog").innerHTML = streamKeys.map((streamKey) => {
    const stream = getStream(payload, streamKey);
    const seriesKeys = Object.keys(stream?.series || {});
    const latestTime = Math.max(...seriesKeys.map((seriesKey) => getRecordTime(latest(stream.series?.[seriesKey]))).filter((value) => value > 0), 0);
    const meta = STREAM_CATALOG[streamKey] || { label: streamKey, description: "" };
    return `
      <article class="catalog-card">
        <h3>${escapeHtml(meta.label)}</h3>
        <div class="catalog-desc">${escapeHtml(meta.description)}</div>
        <div class="metric-inline-list">
          <div class="stream-row"><span>stream key</span><span>${escapeHtml(streamKey)}</span></div>
          <div class="stream-row"><span>interval</span><span>${escapeHtml(stream.interval || "—")}</span></div>
          <div class="stream-row"><span>series</span><span>${escapeHtml(seriesKeys.join(", ") || "—")}</span></div>
          <div class="stream-row"><span>最後資料點</span><span>${escapeHtml(formatDateTime(latestTime))}</span></div>
        </div>
      </article>
    `;
  }).join("");
}

async function fetchPayload() {
  const response = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(UPSTASH_KEY)}`, {
    headers: {
      Authorization: `Bearer ${UPSTASH_READ_TOKEN}`
    }
  });

  if (!response.ok) {
    throw new Error(`無法從 Upstash 讀取資料（${response.status}）`);
  }

  const payload = await response.json();
  const result = payload?.result;
  if (typeof result === "string") {
    return JSON.parse(result);
  }
  if (result && typeof result === "object") {
    return result;
  }
  throw new Error("Upstash 回傳格式異常");
}

function renderAll(payload) {
  renderHeroMeta(payload);
  renderOverview(payload);
  renderRadar(payload);
  renderAssetPanels(payload);
  renderWhales(payload);
  renderEtf(payload);
  renderCatalog(payload);
}

async function bootstrap() {
  try {
    const payload = await fetchPayload();
    renderAll(payload);
  } catch (error) {
    const el = document.getElementById("overview-cards");
    if (el) el.innerHTML = `<p style="color:#f87171;padding:16px;">資料載入失敗：${escapeHtml(error?.message || "未知錯誤")}<br><small style="color:#94a3b8;">Coinglass 資料尚未寫入，請確認 database-side 已執行</small></p>`;
  }
}

bootstrap();
