function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function fetchJson(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "crypto-macro-schedule-bot/1.0" }
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

function toMsTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (value > 1e12) return value; // ms
    if (value > 1e9) return value * 1000; // seconds
    return null;
  }
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    if (s.length >= 13) return n;
    if (s.length === 10) return n * 1000;
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return null;
  }
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

function stablecoinTotalUsd(point) {
  const a = point?.totalCirculating;
  if (Number.isFinite(Number(a))) return Number(a);
  const pegged = a?.peggedUSD;
  if (Number.isFinite(Number(pegged))) return Number(pegged);
  const direct = point?.totalCirculatingUSD ?? point?.peggedUSD ?? point?.total ?? point?.mcap ?? point?.value;
  if (Number.isFinite(Number(direct))) return Number(direct);
  return null;
}

function pickNearestAgo(series, daysAgo) {
  if (!Array.isArray(series) || series.length === 0) return null;
  const latest = series[series.length - 1];
  const latestDate = toMsTimestamp(latest.date ?? latest.timestamp ?? latest.time);
  if (!Number.isFinite(latestDate) || latestDate <= 0) return null;
  const target = latestDate - daysAgo * 24 * 60 * 60 * 1000;

  let best = null;
  let bestDiff = Infinity;
  for (const item of series) {
    const t = toMsTimestamp(item.date ?? item.timestamp ?? item.time);
    if (!Number.isFinite(t) || t <= 0) continue;
    const diff = Math.abs(t - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = item;
    }
  }
  return best;
}

function pctChange(now, prev) {
  if (!Number.isFinite(now) || !Number.isFinite(prev) || prev === 0) return null;
  return Number(((now - prev) / prev) * 100);
}

export async function collectLiquidityIntel() {
  const nowIso = new Date().toISOString();

  const [stableRes, chainsRes, defiChartsRes] = await Promise.all([
    fetchJson("https://stablecoins.llama.fi/stablecoincharts/all"),
    fetchJson("https://api.llama.fi/v2/chains"),
    fetchJson("https://api.llama.fi/charts")
  ]);

  // Stablecoins (try to infer shape)
  let stableLatestMcap = null;
  let stableChange7dPct = null;
  if (stableRes.ok) {
    const data = stableRes.data;
    const series = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
    if (series && series.length > 2) {
      const latest = series[series.length - 1];
      const prev7d = pickNearestAgo(series, 7);
      const latestVal = stablecoinTotalUsd(latest);
      const prevVal = prev7d ? stablecoinTotalUsd(prev7d) : null;
      stableLatestMcap = latestVal;
      stableChange7dPct = (latestVal !== null && prevVal !== null) ? pctChange(latestVal, prevVal) : null;
    }
  }

  // DeFi TVL
  let defiTotalTvl = null;
  let defiChange7dPct = null;
  if (defiChartsRes.ok && Array.isArray(defiChartsRes.data) && defiChartsRes.data.length > 10) {
    const series = defiChartsRes.data;
    const latest = series[series.length - 1];
    const prev7d = pickNearestAgo(series, 7);
    const latestVal = toNumber(latest.totalLiquidityUSD ?? latest.tvl ?? latest.value);
    const prevVal = prev7d ? toNumber(prev7d.totalLiquidityUSD ?? prev7d.tvl ?? prev7d.value) : null;
    defiTotalTvl = latestVal;
    defiChange7dPct = (latestVal !== null && prevVal !== null) ? pctChange(latestVal, prevVal) : null;
  } else if (chainsRes.ok && Array.isArray(chainsRes.data)) {
    const chains = chainsRes.data;
    const allRow = chains.find((c) => String(c?.name || "").toLowerCase() === "all");

    if (allRow && Number.isFinite(Number(allRow.tvl))) {
      defiTotalTvl = Number(allRow.tvl);
      // No reliable aggregate 7D change without historical series.
      defiChange7dPct = null;
    } else {
      const sum = chains.reduce((acc, c) => {
        const tvl = Number(c?.tvl);
        return Number.isFinite(tvl) ? acc + tvl : acc;
      }, 0);
      defiTotalTvl = Number.isFinite(sum) && sum > 0 ? sum : null;
      // change_7d is chain-level; no clean aggregate without historical. Leave null.
      defiChange7dPct = null;
    }
  }

  return {
    updatedAt: nowIso,
    sources: {
      defiLlamaStablecoins: stableRes.ok,
      defiLlamaChains: chainsRes.ok,
      defiLlamaCharts: defiChartsRes.ok
    },
    stablecoins: stableLatestMcap !== null
      ? {
          totalMcapUsd: stableLatestMcap,
          change7dPct: stableChange7dPct
        }
      : null,
    defi: defiTotalTvl !== null
      ? {
          totalTvlUsd: defiTotalTvl,
          change7dPct: defiChange7dPct
        }
      : null
  };
}
