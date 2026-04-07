/**
 * deribitCollector.js — Deribit 選擇權數據（免費公開 API）
 *
 * 提供：
 *   - BTC 選擇權 Put/Call OI 比（反映市場對沖需求 vs 投機多頭）
 *   - 近月期權 Put/Call 成交量比（更即時的短線情緒）
 *
 * Put/Call ratio 解讀（反指標角度）：
 *   < 0.6  → 市場重押看漲（偏多信號，但過熱時反轉風險高）
 *   0.6~0.9 → 略偏多
 *   0.9~1.1 → 中性
 *   1.1~1.4 → 略偏空（市場加大下行對沖）
 *   > 1.4  → 恐慌性對沖（偏空信號）
 *
 * API：https://www.deribit.com/api/v2/public/get_book_summary_by_currency
 * 免費、無需 API key、CORS 友好
 */

const DERIBIT_BASE = "https://www.deribit.com/api/v2/public";

async function fetchDeribitOptions(currency = "BTC") {
  try {
    const url = `${DERIBIT_BASE}/get_book_summary_by_currency?currency=${currency}&kind=option`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: { "accept": "application/json" }
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, data: null };
    const json = await res.json();
    if (!Array.isArray(json.result)) return { ok: false, reason: "invalid response", data: null };
    return { ok: true, data: json.result };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e), data: null };
  }
}

function parseOptionType(instrumentName = "") {
  // BTC-28MAR26-100000-C → call；BTC-28MAR26-100000-P → put
  const parts = instrumentName.split("-");
  if (parts.length < 4) return null;
  const suffix = parts[parts.length - 1].toUpperCase();
  if (suffix === "C") return "call";
  if (suffix === "P") return "put";
  return null;
}

function parseExpiryMs(instrumentName = "") {
  // e.g. BTC-28MAR26-100000-C → "28MAR26"
  const parts = instrumentName.split("-");
  if (parts.length < 4) return null;
  try {
    const dateStr = parts[1]; // e.g. "28MAR26"
    const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
                     JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const day   = parseInt(dateStr.slice(0, 2), 10);
    const mon   = dateStr.slice(2, 5).toUpperCase();
    const yr    = parseInt("20" + dateStr.slice(5), 10);
    const month = months[mon];
    if (month === undefined || isNaN(day) || isNaN(yr)) return null;
    return new Date(yr, month, day).getTime();
  } catch {
    return null;
  }
}

function parseStrike(instrumentName = "") {
  // BTC-28MAR26-100000-C → 100000
  const parts = instrumentName.split("-");
  if (parts.length < 4) return null;
  const strike = parseFloat(parts[2]);
  return isNaN(strike) ? null : strike;
}

export async function collectDeribitOptions() {
  const nowMs  = Date.now();
  const d30ms  = 30  * 24 * 60 * 60 * 1000;
  const d7ms   =  7  * 24 * 60 * 60 * 1000;
  const d60ms  = 60  * 24 * 60 * 60 * 1000;

  const res = await fetchDeribitOptions("BTC");
  if (!res.ok) {
    console.warn(`[deribit] 無法取得資料：${res.reason}`);
    return { available: false, reason: res.reason };
  }

  const instruments = res.data;

  // ── 全部合約 Put/Call OI 比 ──────────────────────────────────
  let totalPutOI  = 0;
  let totalCallOI = 0;

  // ── 近月（30 天內到期）成交量 Put/Call 比 ──────────────────
  let nearPutVol  = 0;
  let nearCallVol = 0;

  // ── ATM IV：收集近期（7-60 天）各到期日的 ATM mark_iv ──────
  // spot 從第一個有 underlying_price 的合約取得
  let spot = null;
  const expiryGroups = {};  // expiryMs → [{ strike, type, mark_iv, dte_ms }]

  for (const inst of instruments) {
    const type    = parseOptionType(inst.instrument_name);
    const expiry  = parseExpiryMs(inst.instrument_name);
    if (!type || expiry === null) continue;

    if (spot === null && inst.underlying_price > 0) spot = Number(inst.underlying_price);

    const oi  = Number(inst.open_interest ?? 0);
    const vol = Number(inst.volume_usd ?? inst.volume ?? 0);

    if (type === "put")  { totalPutOI  += oi; } else { totalCallOI += oi; }

    if (expiry > nowMs && (expiry - nowMs) <= d30ms) {
      if (type === "put") nearPutVol += vol; else nearCallVol += vol;
    }

    // 收集近期合約 IV（7-60 天）
    const dte = expiry - nowMs;
    if (dte >= d7ms && dte <= d60ms) {
      const iv = Number(inst.mark_iv ?? 0);
      const strike = parseStrike(inst.instrument_name);
      if (iv > 0 && strike !== null) {
        if (!expiryGroups[expiry]) expiryGroups[expiry] = [];
        expiryGroups[expiry].push({ strike, type, iv, dte });
      }
    }
  }

  const totalOI = totalPutOI + totalCallOI;
  if (totalOI === 0) {
    return { available: false, reason: "no valid OI data" };
  }

  // ── 計算近月 ATM IV（DTE 加權平均）──────────────────────────
  let btc_iv = null;
  if (spot !== null && Object.keys(expiryGroups).length > 0) {
    let weightedIvSum = 0, weightSum = 0;
    for (const [, group] of Object.entries(expiryGroups)) {
      // 找最接近 spot 的 strike（ATM）
      const sorted = group.slice().sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
      // 取最近 2 個 strike（可能是 call/put 各一）的平均 IV
      const atm = sorted.slice(0, 4);
      if (atm.length === 0) continue;
      const avgIv = atm.reduce((s, e) => s + e.iv, 0) / atm.length;
      const dte = atm[0].dte;
      const weight = 1 / dte;  // 近期合約權重更高
      weightedIvSum += avgIv * weight;
      weightSum += weight;
    }
    if (weightSum > 0) {
      btc_iv = Number((weightedIvSum / weightSum).toFixed(2));  // IV%（如 60.5 表示 60.5%）
    }
  }

  const putCallOiRatio  = totalCallOI > 0 ? Number((totalPutOI  / totalCallOI).toFixed(4))  : null;
  const putCallVolRatio = nearCallVol > 0  ? Number((nearPutVol  / nearCallVol).toFixed(4))  : null;

  // 方向解讀（OI 比為主）
  const direction = putCallOiRatio === null  ? "unknown"
    : putCallOiRatio < 0.6  ? "bullish"   // 大量看漲倉位
    : putCallOiRatio < 0.9  ? "slightly_bullish"
    : putCallOiRatio < 1.1  ? "neutral"
    : putCallOiRatio < 1.4  ? "slightly_bearish"
    : "bearish";                           // 大量下行對沖

  console.log(`[deribit] P/C OI=${putCallOiRatio?.toFixed(3) ?? "N/A"}（${direction}）, 近月 Vol P/C=${putCallVolRatio?.toFixed(3) ?? "N/A"}, ATM IV=${btc_iv ?? "N/A"}%, 總合約數=${instruments.length}`);

  return {
    available: true,
    updatedAt: new Date().toISOString(),
    putCallOiRatio,
    putCallVolRatio,
    direction,
    btc_iv,             // 近月 ATM 隱含波動率（%，如 60.5），null = 無法計算
    totalPutOI:  Math.round(totalPutOI),
    totalCallOI: Math.round(totalCallOI),
    instrumentCount: instruments.length,
    source: "deribit_public"
  };
}
