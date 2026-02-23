import dayjs from "dayjs";

async function fetchFredSeries(seriesId) {
  const response = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`);
  if (!response.ok) {
    throw new Error(`FRED series fetch failed: ${seriesId}`);
  }

  const csv = await response.text();
  const lines = csv.split(/\r?\n/).slice(1);
  const points = lines
    .map((line) => {
      const [date, value] = line.split(",");
      const numeric = Number(value);
      if (!date || Number.isNaN(numeric)) return null;
      return { date, value: numeric };
    })
    .filter(Boolean);

  return points;
}

function formatPct(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function cpiAnalysis(latest, previous) {
  const pct = ((latest.value - previous.value) / previous.value) * 100;
  const direction = pct > 0.2 ? "通膨壓力偏升" : pct < 0 ? "通膨壓力回落" : "通膨變化溫和";
  const shortTermBias = pct > 0.2 ? "偏跌" : pct < 0 ? "偏漲" : "震盪";
  return {
    actual: latest.value.toFixed(2),
    previous: previous.value.toFixed(2),
    unit: "指數",
    period: latest.date,
    analysis: `最新月變動 ${formatPct(pct)}，${direction}。`,
    cryptoImpact: pct > 0.2 ? "通膨高於前期，市場擔憂降息延後，風險資產承壓。" : "通膨壓力降溫，有利風險資產情緒修復。",
    shortTermBias
  };
}

function ppiAnalysis(latest, previous) {
  const pct = ((latest.value - previous.value) / previous.value) * 100;
  const direction = pct > 0.3 ? "上游價格壓力偏高" : pct < 0 ? "上游價格壓力緩和" : "上游價格變動中性";
  const shortTermBias = pct > 0.3 ? "偏跌" : pct < 0 ? "偏漲" : "震盪";
  return {
    actual: latest.value.toFixed(2),
    previous: previous.value.toFixed(2),
    unit: "指數",
    period: latest.date,
    analysis: `最新月變動 ${formatPct(pct)}，${direction}。`,
    cryptoImpact: pct > 0.3 ? "上游價格壓力升溫，可能推升通膨預期，對幣市偏空。" : "上游價格壓力回落，市場風險偏好有望回升。",
    shortTermBias
  };
}

function nfpAnalysis(latest, previous) {
  const change = latest.value - previous.value;
  const direction = change >= 200 ? "就業動能強" : change <= 50 ? "就業動能偏弱" : "就業動能中性";
  const shortTermBias = change >= 200 ? "偏跌" : change <= 50 ? "偏漲" : "震盪";
  return {
    actual: `${change >= 0 ? "+" : ""}${Math.round(change)}K`,
    previous: `${Math.round(previous.value)}K（前月總就業）`,
    unit: "千人",
    period: latest.date,
    analysis: `非農月增 ${change >= 0 ? "+" : ""}${Math.round(change)}K，${direction}。`,
    cryptoImpact: change >= 200 ? "就業過熱提高緊縮預期，對 BTC/ETH 短線偏空。" : "就業降溫有助寬鬆預期，對 BTC/ETH 短線偏多。",
    shortTermBias
  };
}

function fedFundsAnalysis(latest, previous) {
  const delta = latest.value - previous.value;
  const direction = Math.abs(delta) < 0.01 ? "利率大致持平" : delta > 0 ? "利率偏緊" : "利率偏鬆";
  const shortTermBias = delta > 0 ? "偏跌" : delta < 0 ? "偏漲" : "震盪";
  return {
    actual: `${latest.value.toFixed(2)}%`,
    previous: `${previous.value.toFixed(2)}%`,
    unit: "%",
    period: latest.date,
    analysis: `有效聯邦基金利率較前期 ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%，${direction}。`,
    cryptoImpact: delta > 0 ? "利率上行壓抑風險資產估值，幣市承壓。" : "利率回落有利風險資產估值修復。",
    shortTermBias
  };
}

function getLatestTwo(points) {
  if (!points || points.length < 2) return null;
  const latest = points[points.length - 1];
  const previous = points[points.length - 2];
  return { latest, previous };
}

function getPairForEventDate(points, eventDate) {
  if (!points || points.length < 2) return null;

  const eventTs = dayjs(eventDate).valueOf();
  let idx = -1;

  for (let i = 0; i < points.length; i += 1) {
    const pointTs = dayjs(points[i].date).valueOf();
    if (pointTs <= eventTs) {
      idx = i;
    } else {
      break;
    }
  }

  if (idx <= 0) return getLatestTwo(points);

  return {
    latest: points[idx],
    previous: points[idx - 1]
  };
}

export async function enrichRecentMacroResults(events) {
  const [cpiSeries, ppiSeries, nfpSeries, fedFundsSeries] = await Promise.allSettled([
    fetchFredSeries("CPIAUCSL"),
    fetchFredSeries("PPIACO"),
    fetchFredSeries("PAYEMS"),
    fetchFredSeries("FEDFUNDS")
  ]);

  const cpiPoints = cpiSeries.status === "fulfilled" ? cpiSeries.value : null;
  const ppiPoints = ppiSeries.status === "fulfilled" ? ppiSeries.value : null;
  const nfpPoints = nfpSeries.status === "fulfilled" ? nfpSeries.value : null;
  const fedPoints = fedFundsSeries.status === "fulfilled" ? fedFundsSeries.value : null;

  return events.map((event) => {
    if (event.status !== "recent") return event;

    const title = String(event.title || "");

    if (/CPI/i.test(title) && cpiPoints) {
      const pair = getPairForEventDate(cpiPoints, event.datetime);
      if (!pair) return event;
      return { ...event, result: cpiAnalysis(pair.latest, pair.previous), resultSource: "https://fred.stlouisfed.org/series/CPIAUCSL" };
    }

    if (/PPI/i.test(title) && ppiPoints) {
      const pair = getPairForEventDate(ppiPoints, event.datetime);
      if (!pair) return event;
      return { ...event, result: ppiAnalysis(pair.latest, pair.previous), resultSource: "https://fred.stlouisfed.org/series/PPIACO" };
    }

    if (/非農|NFP/i.test(title) && nfpPoints) {
      const pair = getPairForEventDate(nfpPoints, event.datetime);
      if (!pair) return event;
      return { ...event, result: nfpAnalysis(pair.latest, pair.previous), resultSource: "https://fred.stlouisfed.org/series/PAYEMS" };
    }

    if (/FOMC/i.test(title) && fedPoints) {
      const pair = getPairForEventDate(fedPoints, event.datetime);
      if (!pair) return event;
      return { ...event, result: fedFundsAnalysis(pair.latest, pair.previous), resultSource: "https://fred.stlouisfed.org/series/FEDFUNDS" };
    }

    if (/BOJ/i.test(title)) {
      return {
        ...event,
        result: {
          actual: "請見官網聲明",
          previous: "-",
          unit: "-",
          period: dayjs(event.datetime).format("YYYY-MM-DD"),
          analysis: "日本央行會議結果以官方聲明內容為主，重點觀察措辭對日圓與風險資產的影響。",
          cryptoImpact: "若日圓與美元利差預期變動，BTC/ETH 常出現短線波動放大。",
          shortTermBias: "震盪"
        },
        resultSource: event.source
      };
    }

    return event;
  });
}
