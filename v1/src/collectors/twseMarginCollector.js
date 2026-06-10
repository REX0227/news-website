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
    if (json?.stat !== "OK" || !Array.isArray(json.data) || json.data.length === 0) continue;

    return { yyyymmdd, json };
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

  const { yyyymmdd, json } = fetched;
  const rows = json.data;

  // fields: ["買進(仟元)", "賣出(仟元)", "現金償還(仟元)", "前日餘額(仟元)", "今日餘額(仟元)", "增減(仟元)"]
  // row[0] = "融資(仟元)" or "融券(千股)"
  const marginRow = rows.find(r => String(r[0] ?? "").includes("融資"));
  const shortRow  = rows.find(r => String(r[0] ?? "").includes("融券"));

  // 融資餘額（仟元 → 億元）
  const marginBalance = marginRow ? (() => {
    const raw = toNumber(marginRow[4]); // 今日餘額
    return raw !== null ? Math.round(raw / 1e5) / 10 : null; // 仟元 → 億元
  })() : null;

  const marginPrev = marginRow ? (() => {
    const raw = toNumber(marginRow[3]); // 前日餘額
    return raw !== null ? Math.round(raw / 1e5) / 10 : null;
  })() : null;

  const marginChange = (marginBalance !== null && marginPrev !== null)
    ? Math.round((marginBalance - marginPrev) * 10) / 10
    : null;

  // 融券餘額（千股）
  const shortBalance = shortRow ? toNumber(shortRow[4]) : null;
  const shortPrev    = shortRow ? toNumber(shortRow[3]) : null;
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
