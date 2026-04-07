/**
 * vixDxyCollector.js — 免費抓取 VIX（CBOE 恐慌指數）與 DXY（美元指數）
 *
 * 資料來源：Yahoo Finance 非官方 JSON API（無需 API key）
 *   VIX: ^VIX
 *   DXY: DX-Y.NYB
 *
 * 輸出格式：
 *   { available: bool, updatedAt: ISO, vix: {...} | null, dxy: {...} | null }
 */

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const TIMEOUT_MS = 12000;

async function fetchYahoo(ticker) {
  const url = `${YAHOO_BASE}/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json"
      }
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, data: null };
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return { ok: false, reason: "No data in response", data: null };
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e), data: null };
  } finally {
    clearTimeout(t);
  }
}

function extractLatest(result) {
  // quotes.close 為每日收盤，取最後一個非 null 值
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] !== null && closes[i] !== undefined) {
      const ts = result?.timestamp?.[i];
      return {
        value: Number(closes[i].toFixed(4)),
        timestamp: ts ? new Date(ts * 1000).toISOString() : null,
        prevClose: i > 0 ? closes[i - 1] : null
      };
    }
  }
  return null;
}

export async function collectVixDxy() {
  const nowIso = new Date().toISOString();

  const [vixRes, dxyRes] = await Promise.all([
    fetchYahoo("^VIX"),
    fetchYahoo("DX-Y.NYB")
  ]);

  // ── VIX ───────────────────────────────────────────────────────
  let vix = null;
  if (vixRes.ok) {
    const latest = extractLatest(vixRes.data);
    if (latest?.value !== undefined) {
      const changePct = (latest.prevClose && latest.prevClose > 0)
        ? Number(((latest.value - latest.prevClose) / latest.prevClose * 100).toFixed(2))
        : null;
      vix = {
        value: latest.value,
        changePct,
        // VIX 反指標：高 VIX = 市場恐慌 = 偏空（但極端高 VIX 可能是底部）
        // 20 以下 = 低波動，30+ = 高恐慌，40+ = 極度恐慌
        level: latest.value >= 35 ? "extreme"
          : latest.value >= 25 ? "elevated"
          : latest.value >= 18 ? "normal"
          : "low",
        direction: latest.value >= 25 ? "bearish" : latest.value <= 14 ? "complacent" : "neutral",
        timestamp: latest.timestamp
      };
    }
  }

  // ── DXY ───────────────────────────────────────────────────────
  let dxy = null;
  if (dxyRes.ok) {
    const latest = extractLatest(dxyRes.data);
    if (latest?.value !== undefined) {
      const changePct = (latest.prevClose && latest.prevClose > 0)
        ? Number(((latest.value - latest.prevClose) / latest.prevClose * 100).toFixed(2))
        : null;
      dxy = {
        value: latest.value,
        changePct,
        // DXY 高 = 美元強 = 風險資產承壓（對加密偏空）
        // 參考：95 = 弱，100 = 中性，108+ = 強
        direction: latest.value >= 106 ? "bearish"
          : latest.value <= 97 ? "bullish"
          : "neutral",
        timestamp: latest.timestamp
      };
    }
  }

  const available = vix !== null || dxy !== null;

  if (!available) {
    console.warn(`[vixDxy] 無法取得資料 — VIX: ${vixRes.reason || "ok"}, DXY: ${dxyRes.reason || "ok"}`);
  } else {
    console.log(`[vixDxy] VIX=${vix?.value ?? "N/A"} (${vix?.level ?? "?"}), DXY=${dxy?.value ?? "N/A"} (${dxy?.direction ?? "?"})`);
  }

  return {
    available,
    updatedAt: nowIso,
    sources: { vix: vixRes.ok, dxy: dxyRes.ok },
    vix,
    dxy
  };
}
