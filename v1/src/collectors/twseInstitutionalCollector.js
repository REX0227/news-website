/**
 * twseInstitutionalCollector.js
 * 抓取台灣證交所「三大法人買賣超彙總表」（BFI82U）
 * 資料來源：TWSE 官方 API，免 key，收盤後約 6PM 發布
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

function toNTD(str) {
  const n = Number(String(str ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

// 嘗試最近幾個交易日（TWSE 假日無資料）
async function fetchWithFallback(dateStr) {
  const candidates = [];
  const d = new Date(dateStr);
  // 往前找最多 7 天
  for (let i = 0; i < 7; i++) {
    const dd = new Date(d);
    dd.setDate(d.getDate() - i);
    const y = dd.getFullYear();
    const m = String(dd.getMonth() + 1).padStart(2, "0");
    const day = String(dd.getDate()).padStart(2, "0");
    candidates.push(`${y}${m}${day}`);
  }

  for (const yyyymmdd of candidates) {
    const url = `https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate=${yyyymmdd}&weekDate=&monthDate=`;
    const res = await fetchText(url);
    if (!res.ok) continue;

    let json;
    try { json = JSON.parse(res.text); } catch { continue; }
    if (json?.stat !== "OK" || !Array.isArray(json.data) || json.data.length === 0) continue;

    return { yyyymmdd, json };
  }
  return null;
}

export async function collectTwseInstitutional() {
  const nowIso = new Date().toISOString();
  // 台灣時間今日（+8）
  const twNow = new Date(Date.now() + 8 * 3600 * 1000);
  const dateStr = twNow.toISOString().slice(0, 10);

  const fetched = await fetchWithFallback(dateStr);
  if (!fetched) {
    return {
      updatedAt: nowIso,
      dataDate: null,
      available: false,
      error: "無法取得 TWSE 三大法人資料"
    };
  }

  const { yyyymmdd, json } = fetched;
  const rows = json.data;

  // 找各法人列（row[0] 為名稱）
  const find = (keyword) => rows.find(r => String(r[0] ?? "").includes(keyword));
  const foreignRow   = find("外資及陸資") || find("外資");
  const trustRow     = find("投信");
  const dealerRow    = find("自營商(自行買賣)") || find("自營商");
  const totalRow     = find("合計");

  // 買賣超金額（欄位 index 3，單位：千元）→ 轉億元（/1e5 *1000 = /1e5）
  const parseNetBuy = (row) => {
    if (!row) return null;
    // fields: ["單位名稱","買進金額","賣出金額","買賣超金額"]
    const raw = toNTD(row[3]);
    if (raw === null) return null;
    return Math.round(raw / 1e4) / 10; // 千元→億元（保留1位小數）
  };

  const foreignNetBuy = parseNetBuy(foreignRow);
  const trustNetBuy   = parseNetBuy(trustRow);
  const dealerNetBuy  = parseNetBuy(dealerRow);
  const totalNetBuy   = parseNetBuy(totalRow);

  return {
    updatedAt: nowIso,
    dataDate: `${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}`,
    available: true,
    foreignNetBuyBillions: foreignNetBuy,
    trustNetBuyBillions:   trustNetBuy,
    dealerNetBuyBillions:  dealerNetBuy,
    totalNetBuyBillions:   totalNetBuy,
    source: "TWSE BFI82U"
  };
}
