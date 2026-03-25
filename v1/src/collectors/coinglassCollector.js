/**
 * coinglassCollector.js — Coinglass V4 API：BTC 資金費率 + 未平倉合約
 *
 * 為 V1 pipeline 提供衍生品核心 factor：
 *   - BTC 資金費率（8h，Binance）
 *   - BTC 未平倉合約（4h，聚合所有交易所）
 *
 * 需要 COINGLASS_API_KEY 環境變數
 */

const BASE_URL = "https://open-api-v4.coinglass.com";

async function fetchCg(path, query = {}) {
  const apiKey = process.env.COINGLASS_API_KEY;
  if (!apiKey) return { ok: false, reason: "COINGLASS_API_KEY not set", data: null };

  const params = new URLSearchParams(query).toString();
  const url = `${BASE_URL}${path}${params ? "?" + params : ""}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "accept": "application/json",
        "CG-API-KEY": apiKey
      }
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, data: null };
    const json = await res.json();
    if (String(json.code) !== "0") return { ok: false, reason: json.msg || "API error", data: null };
    return { ok: true, data: Array.isArray(json.data) ? json.data : json.data };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e), data: null };
  } finally {
    clearTimeout(t);
  }
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function collectCoinglassDerivatives() {
  const nowIso = new Date().toISOString();

  const [frRes, oiRes] = await Promise.all([
    // BTC 資金費率（8h，Binance）
    fetchCg("/api/futures/funding-rate/history", {
      exchange: "Binance",
      symbol: "BTCUSDT",
      interval: "8h",
      limit: 3
    }),
    // BTC 未平倉合約（4h，聚合）
    fetchCg("/api/futures/open-interest/aggregated-history", {
      symbol: "BTC",
      interval: "4h",
      exchange_list: "Binance,Bybit,Gate,Hyperliquid",
      limit: 3
    })
  ]);

  // ── 資金費率 ────────────────────────────────────────────────
  let fundingRate = null;
  if (frRes.ok && Array.isArray(frRes.data) && frRes.data.length > 0) {
    const latest = frRes.data[frRes.data.length - 1];
    // Coinglass 返回 close 欄位（小數，如 0.0001 = 0.01%）
    const rate = toNum(latest.close ?? latest.fundingRate ?? latest.value);
    if (rate !== null) {
      fundingRate = {
        rate8h: rate,                          // 小數形式，0.0001 = 0.01%
        rate8hPct: Number((rate * 100).toFixed(4)), // 百分比形式
        annualizedPct: Number((rate * 3 * 365 * 100).toFixed(2)), // 年化 %
        direction: rate > 0.0005 ? "bearish"   // 高正費率 = 多頭過熱 = 看跌
          : rate > 0 ? "neutral"
          : rate < -0.0005 ? "bullish"          // 高負費率 = 空頭過熱 = 看漲
          : "neutral",
        exchange: "Binance",
        symbol: "BTCUSDT",
        timestamp: latest.time ? new Date(Number(latest.time)).toISOString() : null
      };
    }
  }

  // ── 未平倉合約 ──────────────────────────────────────────────
  let openInterest = null;
  if (oiRes.ok && Array.isArray(oiRes.data) && oiRes.data.length >= 2) {
    const arr = oiRes.data;
    const latest = arr[arr.length - 1];
    const prev = arr[arr.length - 2];

    const latestUsd = toNum(latest.close ?? latest.closeUsd ?? latest.openInterest ?? latest.value);
    const prevUsd = toNum(prev.close ?? prev.closeUsd ?? prev.openInterest ?? prev.value);

    if (latestUsd !== null) {
      const changePct = (latestUsd !== null && prevUsd !== null && prevUsd > 0)
        ? Number(((latestUsd - prevUsd) / prevUsd * 100).toFixed(3))
        : null;
      openInterest = {
        totalUsd: latestUsd,
        change4hPct: changePct,
        direction: changePct !== null
          ? (changePct > 1 ? "increasing" : changePct < -1 ? "decreasing" : "stable")
          : "unknown",
        timestamp: latest.time ? new Date(Number(latest.time)).toISOString() : null
      };
    }
  } else if (oiRes.ok && Array.isArray(oiRes.data) && oiRes.data.length === 1) {
    const latest = oiRes.data[0];
    const latestUsd = toNum(latest.close ?? latest.closeUsd ?? latest.openInterest ?? latest.value);
    if (latestUsd !== null) {
      openInterest = {
        totalUsd: latestUsd,
        change4hPct: null,
        direction: "unknown",
        timestamp: latest.time ? new Date(Number(latest.time)).toISOString() : null
      };
    }
  }

  const available = fundingRate !== null || openInterest !== null;

  if (!available) {
    console.warn(`[coinglass] 無法取得資料 — FR: ${frRes.reason || "ok"}, OI: ${oiRes.reason || "ok"}`);
  } else {
    console.log(`[coinglass] FR=${fundingRate?.rate8hPct ?? "N/A"}%, OI=$${openInterest ? (openInterest.totalUsd / 1e9).toFixed(1) + "B" : "N/A"}`);
  }

  return {
    available,
    updatedAt: nowIso,
    sources: {
      fundingRate: frRes.ok,
      openInterest: oiRes.ok
    },
    fundingRate,
    openInterest
  };
}
