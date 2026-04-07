/**
 * coinglassCollector.js — Coinglass V4 API：BTC 衍生品數據
 *
 * 為 V1 pipeline 提供衍生品核心 factor：
 *   - BTC 資金費率（8h，Binance）
 *   - BTC 未平倉合約（4h，聚合所有交易所）
 *   - BTC 全球多空比（帳戶數，Global Long/Short Account Ratio）
 *   - BTC Taker 買賣量（CVD proxy，4h）
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

  const [frRes, oiRes, lsRes, takerRes, liqRes, etfRes] = await Promise.all([
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
    }),
    // BTC 全球多空比（帳戶數，4h，Binance）
    fetchCg("/api/futures/global-long-short-account-ratio/history", {
      exchange: "Binance",
      symbol: "BTCUSDT",
      interval: "4h",
      limit: 3
    }),
    // BTC Taker 買賣量（CVD proxy，4h，Binance）
    fetchCg("/api/futures/taker-buy-sell-volume/history", {
      exchange: "Binance",
      symbol: "BTCUSDT",
      interval: "4h",
      limit: 3
    }),
    // BTC 7D 清算聚合（Binance+Bybit+OKX+Gate，1d，7根）
    fetchCg("/api/futures/liquidation/aggregated-history", {
      symbol: "BTC",
      exchange_list: "Binance,Bybit,OKX,Gate",
      interval: "1d",
      limit: 7
    }),
    // BTC ETF 7D 淨流量（美國現貨 ETF，1d）
    fetchCg("/api/etf/bitcoin/flow-history", { interval: "1d" })
  ]);

  // ── 資金費率 ────────────────────────────────────────────────
  let fundingRate = null;
  if (frRes.ok && Array.isArray(frRes.data) && frRes.data.length > 0) {
    const arr = frRes.data;
    const latest = arr[arr.length - 1];
    // Coinglass 返回 close 欄位（小數，如 0.0001 = 0.01%）
    const rate = toNum(latest.close ?? latest.fundingRate ?? latest.value);
    if (rate !== null) {
      // ── 趨勢：最近 6 期平均 vs 前 6 期平均 ─────────────────
      const getRate = e => toNum(e.close ?? e.fundingRate ?? e.value);
      const recent  = arr.slice(-6).map(getRate).filter(v => v !== null);
      const prev    = arr.slice(-12, -6).map(getRate).filter(v => v !== null);
      let trend = "flat", trend_direction = "neutral";
      if (recent.length >= 3 && prev.length >= 3) {
        const avgRecent = recent.reduce((s, v) => s + v, 0) / recent.length;
        const avgPrev   = prev.reduce((s, v) => s + v, 0) / prev.length;
        const delta = avgRecent - avgPrev;
        if (Math.abs(delta) > 0.0001) {
          trend = delta > 0 ? "rising" : "falling";
          // 費率上升 → 多頭加熱 → 偏空（bearish）；費率下降 → 偏多（bullish）
          trend_direction = delta > 0 ? "bearish" : "bullish";
        }
      }

      fundingRate = {
        rate8h: rate,                          // 小數形式，0.0001 = 0.01%
        rate8hPct: Number((rate * 100).toFixed(4)), // 百分比形式
        annualizedPct: Number((rate * 3 * 365 * 100).toFixed(2)), // 年化 %
        direction: rate > 0.0005 ? "bearish"   // 高正費率 = 多頭過熱 = 看跌
          : rate > 0 ? "neutral"
          : rate < -0.0005 ? "bullish"          // 高負費率 = 空頭過熱 = 看漲
          : "neutral",
        trend,           // "rising" | "falling" | "flat"
        trend_direction, // "bullish" | "bearish" | "neutral"（費率趨勢的多空含義）
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

  // ── 全球多空比（Long/Short Account Ratio）──────────────────
  let longShortRatio = null;
  if (lsRes.ok && Array.isArray(lsRes.data) && lsRes.data.length >= 2) {
    const arr = lsRes.data;
    const latest = arr[arr.length - 1];
    const prev = arr[arr.length - 2];
    // global_account_long_percent = 做多帳戶佔比（0~100），轉為 0~1
    const rawLong = toNum(latest.global_account_long_percent ?? latest.longAccount ?? latest.longRatio ?? latest.long);
    const rawShort = toNum(latest.global_account_short_percent ?? latest.shortAccount ?? latest.shortRatio ?? latest.short);
    const prevRawLong = toNum(prev.global_account_long_percent ?? prev.longAccount ?? prev.longRatio ?? prev.long);
    // 判斷是否需要除以 100（>1 表示百分比形式）
    const longPct = rawLong !== null ? (rawLong > 1 ? rawLong / 100 : rawLong) : null;
    const shortPct = rawShort !== null ? (rawShort > 1 ? rawShort / 100 : rawShort) : null;
    const prevLongPct = prevRawLong !== null ? (prevRawLong > 1 ? prevRawLong / 100 : prevRawLong) : null;
    if (longPct !== null) {
      longShortRatio = {
        longPct,                                              // 0~1
        shortPct: shortPct ?? (1 - longPct),
        lsRatio: shortPct && shortPct > 0 ? longPct / shortPct : null, // L/S 比值
        changePct: prevLongPct !== null ? Number((longPct - prevLongPct).toFixed(4)) : null,
        // 多空比反指標：多頭過多（>0.6）= 看跌；空頭過多（<0.4）= 看漲
        direction: longPct > 0.6 ? "bearish"
          : longPct < 0.4 ? "bullish"
          : "neutral",
        timestamp: latest.time ? new Date(Number(latest.time)).toISOString() : null
      };
    }
  } else if (lsRes.ok && Array.isArray(lsRes.data) && lsRes.data.length === 1) {
    const latest = lsRes.data[0];
    const rawLong = toNum(latest.global_account_long_percent ?? latest.longAccount ?? latest.longRatio ?? latest.long);
    const rawShort = toNum(latest.global_account_short_percent ?? latest.shortAccount ?? latest.shortRatio ?? latest.short);
    const longPct = rawLong !== null ? (rawLong > 1 ? rawLong / 100 : rawLong) : null;
    const shortPct = rawShort !== null ? (rawShort > 1 ? rawShort / 100 : rawShort) : null;
    if (longPct !== null) {
      longShortRatio = {
        longPct, shortPct: shortPct ?? (1 - longPct),
        lsRatio: shortPct && shortPct > 0 ? longPct / shortPct : null,
        changePct: null,
        direction: longPct > 0.6 ? "bearish" : longPct < 0.4 ? "bullish" : "neutral",
        timestamp: latest.time ? new Date(Number(latest.time)).toISOString() : null
      };
    }
  }

  // ── Taker 買賣量（CVD proxy）────────────────────────────────
  let takerVolume = null;
  if (takerRes.ok && Array.isArray(takerRes.data) && takerRes.data.length >= 2) {
    const arr = takerRes.data;
    let buyVol = 0;
    let sellVol = 0;
    // 累加最近 2 根 4h K 線的 CVD（約 8h）
    for (const bar of arr.slice(-2)) {
      buyVol += toNum(bar.taker_buy_volume_usd ?? bar.buyVolUsd ?? bar.takerBuyUsd ?? bar.buy) ?? 0;
      sellVol += toNum(bar.taker_sell_volume_usd ?? bar.sellVolUsd ?? bar.takerSellUsd ?? bar.sell) ?? 0;
    }
    if (buyVol > 0 || sellVol > 0) {
      const netUsd = buyVol - sellVol;
      const totalVol = buyVol + sellVol;
      takerVolume = {
        buyVolumeUsd: buyVol,
        sellVolumeUsd: sellVol,
        netUsd,                                               // 正 = 主動買壓
        netPct: totalVol > 0 ? Number((netUsd / totalVol * 100).toFixed(2)) : 0, // 佔比 %
        direction: netUsd > totalVol * 0.05 ? "bullish"
          : netUsd < -totalVol * 0.05 ? "bearish"
          : "neutral",
        timestamp: arr[arr.length - 1].time
          ? new Date(Number(arr[arr.length - 1].time)).toISOString() : null
      };
    }
  }

  // ── 7D 清算彙總 ─────────────────────────────────────────────
  let liquidation7d = null;
  if (liqRes.ok && Array.isArray(liqRes.data) && liqRes.data.length > 0) {
    let totalLong = 0;
    let totalShort = 0;
    for (const bar of liqRes.data) {
      totalLong += toNum(bar.aggregated_long_liquidation_usd) ?? 0;
      totalShort += toNum(bar.aggregated_short_liquidation_usd) ?? 0;
    }
    const totalUsd = totalLong + totalShort;
    if (totalUsd > 0) {
      liquidation7d = {
        totalUsd: Math.round(totalUsd),
        longUsd: Math.round(totalLong),
        shortUsd: Math.round(totalShort),
        exchanges: "Binance,Bybit,OKX,Gate",
        days: liqRes.data.length,
        source: "coinglass_aggregated"
      };
    }
  }

  // ── ETF 7D 淨流量 ──────────────────────────────────────────
  let etfFlow7d = null;
  if (etfRes.ok && Array.isArray(etfRes.data) && etfRes.data.length > 0) {
    // 取最後 7 筆，過濾掉當日未結算（flow_usd 為 0 且為最後一筆）
    const all = etfRes.data;
    let slice = all.slice(-7);
    // 若最後一筆為 0（當日未收盤），排除後再取 7 筆
    if (slice.length > 0 && (slice[slice.length - 1].flow_usd === 0 || slice[slice.length - 1].flow_usd === null)) {
      slice = all.slice(-8, -1);
    }
    const totalFlow = slice.reduce((sum, d) => sum + (toNum(d.flow_usd) ?? 0), 0);
    const tradingDays = slice.filter((d) => d.flow_usd !== 0 && d.flow_usd !== null).length;
    if (tradingDays > 0) {
      etfFlow7d = {
        netUsd: Math.round(totalFlow),
        tradingDays,
        source: "coinglass_etf",
        latestDate: new Date(slice[slice.length - 1].timestamp).toISOString().slice(0, 10)
      };
    }
  }

  const available = fundingRate !== null || openInterest !== null || longShortRatio !== null || takerVolume !== null;

  if (!available) {
    console.warn(`[coinglass] 無法取得資料 — FR: ${frRes.reason || "ok"}, OI: ${oiRes.reason || "ok"}, LS: ${lsRes.reason || "ok"}, Taker: ${takerRes.reason || "ok"}`);
  } else {
    console.log(`[coinglass] FR=${fundingRate?.rate8hPct ?? "N/A"}%, OI=$${openInterest ? (openInterest.totalUsd / 1e9).toFixed(1) + "B" : "N/A"}, LS=${longShortRatio ? (longShortRatio.longPct * 100).toFixed(1) + "%" : "N/A"}多, Taker=${takerVolume?.direction ?? "N/A"}, Liq7d=$${liquidation7d ? (liquidation7d.totalUsd / 1e6).toFixed(0) + "M" : "N/A"}, ETF7d=$${etfFlow7d ? (etfFlow7d.netUsd / 1e6).toFixed(0) + "M" : "N/A"}`);
  }

  return {
    available,
    updatedAt: nowIso,
    sources: {
      fundingRate: frRes.ok,
      openInterest: oiRes.ok,
      longShortRatio: lsRes.ok,
      takerVolume: takerRes.ok,
      liquidation7d: liqRes.ok,
      etfFlow7d: etfRes.ok
    },
    fundingRate,
    openInterest,
    longShortRatio,
    takerVolume,
    liquidation7d,
    etfFlow7d
  };
}
