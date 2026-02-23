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

function pickNearestAgo(series, daysAgo) {
  if (!Array.isArray(series) || series.length === 0) return null;
  const latest = series[series.length - 1];
  const latestDate = new Date(latest.date || latest.timestamp || latest.time || 0).getTime();
  if (!Number.isFinite(latestDate) || latestDate <= 0) return null;
  const target = latestDate - daysAgo * 24 * 60 * 60 * 1000;

  let best = null;
  let bestDiff = Infinity;
  for (const item of series) {
    const t = new Date(item.date || item.timestamp || item.time || 0).getTime();
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

  const [stableRes, chainsRes] = await Promise.all([
    fetchJson("https://stablecoins.llama.fi/stablecoincharts/all"),
    fetchJson("https://api.llama.fi/v2/chains")
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
      const latestVal = toNumber(latest.totalCirculating?.peggedUSD ?? latest.totalCirculatingUSD ?? latest.peggedUSD ?? latest.total ?? latest.mcap ?? latest.value);
      const prevVal = prev7d ? toNumber(prev7d.totalCirculating?.peggedUSD ?? prev7d.totalCirculatingUSD ?? prev7d.peggedUSD ?? prev7d.total ?? prev7d.mcap ?? prev7d.value) : null;
      stableLatestMcap = latestVal;
      stableChange7dPct = (latestVal !== null && prevVal !== null) ? pctChange(latestVal, prevVal) : null;
    }
  }

  // DeFi TVL
  let defiTotalTvl = null;
  let defiChange7dPct = null;
  if (chainsRes.ok && Array.isArray(chainsRes.data)) {
    const chains = chainsRes.data;
    const allRow = chains.find((c) => String(c?.name || "").toLowerCase() === "all");

    if (allRow && Number.isFinite(Number(allRow.tvl))) {
      defiTotalTvl = Number(allRow.tvl);
      if (Number.isFinite(Number(allRow.change_7d))) defiChange7dPct = Number(allRow.change_7d);
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
      defiLlamaChains: chainsRes.ok
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
