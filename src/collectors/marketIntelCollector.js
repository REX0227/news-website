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
      headers: {
        "User-Agent": "CryptoPulse/1.0 (+https://github.com/)"
      }
    });
    if (!res.ok) {
      return { ok: false, status: res.status, data: null };
    }
    const data = await res.json();
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

export async function collectMarketIntel() {
  const nowIso = new Date().toISOString();

  const [globalRes, fngRes] = await Promise.all([
    fetchJson("https://api.coingecko.com/api/v3/global"),
    fetchJson("https://api.alternative.me/fng/?limit=1&format=json")
  ]);

  const global = globalRes.ok ? globalRes.data?.data : null;
  const fng = fngRes.ok ? (Array.isArray(fngRes.data?.data) ? fngRes.data.data[0] : null) : null;

  const out = {
    updatedAt: nowIso,
    sources: {
      coingeckoGlobal: globalRes.ok,
      alternativeMeFng: fngRes.ok
    },
    global: global
      ? {
          totalMarketCapUsd: toNumber(global.total_market_cap?.usd),
          totalVolumeUsd: toNumber(global.total_volume?.usd),
          marketCapChangePct24hUsd: toNumber(global.market_cap_change_percentage_24h_usd),
          btcDominancePct: toNumber(global.market_cap_percentage?.btc),
          ethDominancePct: toNumber(global.market_cap_percentage?.eth)
        }
      : null,
    sentiment: fng
      ? {
          fearGreedValue: toNumber(fng.value),
          fearGreedClassification: String(fng.value_classification || ""),
          timestamp: fng.timestamp ? new Date(Number(fng.timestamp) * 1000).toISOString() : null
        }
      : null
  };

  return out;
}
