/**
 * taiexCollector.js
 * 抓取加權指數（TAIEX）近 20 個交易日收盤價
 * 資料來源：Yahoo Finance chart API（^TWII）
 * 計算：5MA、20MA、近 5 日動能方向
 */

async function fetchText(url, { timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "CryptoPulse-TW-Bot/1.0" }
    });
    if (!res.ok) return { ok: false, status: res.status, text: "" };
    return { ok: true, text: await res.text() };
  } catch (e) {
    return { ok: false, text: "", error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

function ma(arr, n) {
  if (arr.length < n) return null;
  const slice = arr.slice(-n);
  return slice.reduce((s, v) => s + v, 0) / n;
}

export async function collectTaiex() {
  const nowIso = new Date().toISOString();

  // 抓取 30 個交易日資料（確保 20MA 夠用）
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&range=60d";
  const res = await fetchText(url);
  if (!res.ok) {
    return { updatedAt: nowIso, available: false, error: "無法取得 TAIEX 資料" };
  }

  let json;
  try { json = JSON.parse(res.text); } catch {
    return { updatedAt: nowIso, available: false, error: "TAIEX JSON 解析失敗" };
  }

  const result = json?.chart?.result?.[0];
  if (!result) {
    return { updatedAt: nowIso, available: false, error: "TAIEX 無有效結果" };
  }

  const timestamps = result.timestamp ?? [];
  const closes     = result.indicators?.quote?.[0]?.close ?? [];
  const volumes    = result.indicators?.quote?.[0]?.volume ?? [];

  // 過濾掉 null 收盤價
  const valid = timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    close: closes[i],
    volume: volumes[i]
  })).filter(d => d.close != null && Number.isFinite(d.close));

  if (valid.length < 2) {
    return { updatedAt: nowIso, available: false, error: "TAIEX 有效資料不足" };
  }

  const closePrices = valid.map(d => d.close);
  const latest      = valid[valid.length - 1];
  const prev        = valid[valid.length - 2];

  const ma5  = ma(closePrices, 5);
  const ma20 = ma(closePrices, 20);

  // 近 5 日動能（收盤相對 5 日前）
  const price5dAgo = valid.length >= 6 ? valid[valid.length - 6].close : null;
  const momentum5d = (price5dAgo !== null)
    ? Math.round(((latest.close - price5dAgo) / price5dAgo) * 1000) / 10  // %
    : null;

  // MA 方向
  let maDirection = "neutral";
  if (ma5 !== null && ma20 !== null) {
    if (ma5 > ma20 * 1.005) maDirection = "bullish";
    else if (ma5 < ma20 * 0.995) maDirection = "bearish";
  }

  // 近 5 日收盤（給前端畫迷你走勢）
  const recentCandles = valid.slice(-10).map(d => ({
    date: d.date,
    close: Math.round(d.close)
  }));

  return {
    updatedAt: nowIso,
    dataDate: latest.date,
    available: true,
    close: Math.round(latest.close),
    prevClose: Math.round(prev.close),
    changeAmt: Math.round(latest.close - prev.close),
    changePct: Math.round(((latest.close - prev.close) / prev.close) * 1000) / 10,
    ma5:  ma5  !== null ? Math.round(ma5)  : null,
    ma20: ma20 !== null ? Math.round(ma20) : null,
    maDirection,
    momentum5d,
    recentCandles,
    source: "Yahoo Finance ^TWII"
  };
}
