/**
 * twseMarginCollector.js
 * 抓取台灣證交所「信用交易統計」（MI_MARGN）
 * 資料來源：TWSE 官方 API，免 key
 * 欄位：融資餘額（億元）、融券餘額（千股）、融資餘額增減
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

function toNumber(str) {
  const n = Number(String(str ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

async function fetchWithFallback(dateStr) {
  const d = new Date(dateStr);
  for (let i = 0; i < 7; i++) {
    const dd = new Date(d);
    dd.setDate(d.getDate() - i);
    const y = dd.getFullYear();
    const m = String(dd.getMonth() + 1).padStart(2, "0");
    const day = String(dd.getDate()).padStart(2, "0");
    const yyyymmdd = `${y}${m}${day}`;

    const url = `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${yyyymmdd}&selectType=MS`;
    const res = await fetchText(url);
    if (!res.ok) continue;

    let json;
    try { json = JSON.parse(res.text); } catch { continue; }
    if (json?.stat !== "OK") continue;
    // 新版 API：資料在 tables[0].data；舊版在 json.data
    const data = json.tables?.[0]?.data ?? json.data;
    if (!Array.isArray(data) || data.length === 0) continue;

    return { yyyymmdd, json, data };
  }
  return null;
}

export async function collectTwseMargin() {
  const nowIso = new Date().toISOString();
  const twNow = new Date(Date.now() + 8 * 3600 * 1000);
  const dateStr = twNow.toISOString().slice(0, 10);

  const fetched = await fetchWithFallback(dateStr);
  if (!fetched) {
    return {
      updatedAt: nowIso,
      dataDate: null,
      available: false,
      error: "無法取得 TWSE 融資融券資料"
    };
  }

  const { yyyymmdd, data: rows } = fetched;

  // 新版 API fields（6欄）: ["項目","買進","賣出","現金(券)償還","前日餘額","今日餘額"]
  // row[0]=項目, row[1]=買進, row[2]=賣出, row[3]=現金償還, row[4]=前日餘額, row[5]=今日餘額
  const marginRow = rows.find(r => String(r[0] ?? "").includes("融資金額")); // 仟元列
  const shortRow  = rows.find(r => String(r[0] ?? "").includes("融券"));

  // 融資餘額（仟元 → 億元；1億 = 10^5 仟元，保留1位小數）
  const marginBalance = marginRow ? (() => {
    const raw = toNumber(marginRow[5]); // 今日餘額
    return raw !== null ? Math.round(raw / 1e4) / 10 : null;
  })() : null;

  const marginPrev = marginRow ? (() => {
    const raw = toNumber(marginRow[4]); // 前日餘額
    return raw !== null ? Math.round(raw / 1e4) / 10 : null;
  })() : null;

  const marginChange = (marginBalance !== null && marginPrev !== null)
    ? Math.round((marginBalance - marginPrev) * 10) / 10
    : null;

  // 融券餘額（交易單位 ≒ 千股）
  const shortBalance = shortRow ? toNumber(shortRow[5]) : null; // 今日餘額
  const shortPrev    = shortRow ? toNumber(shortRow[4]) : null; // 前日餘額
  const shortChange  = (shortBalance !== null && shortPrev !== null)
    ? shortBalance - shortPrev
    : null;

  // 融券/融資比（簡易過熱指標）
  // 融資單位：億元；融券單位：千股，難以直接比，改用增減方向判斷
  const marginChangePct = (marginBalance && marginChange !== null)
    ? Math.round((marginChange / marginBalance) * 1000) / 10
    : null; // %

  return {
    updatedAt: nowIso,
    dataDate: `${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`,
    available: true,
    marginBalanceBillions: marginBalance,
    marginChangeBillions:  marginChange,
    marginChangePct,
    shortBalanceKShares:   shortBalance,
    shortChangeKShares:    shortChange,
    source: "TWSE MI_MARGN"
  };
}
