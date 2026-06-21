/**
 * taifexForeignFuturesCollector.js
 * 抓取台灣期貨交易所「三大法人期貨交易」中 外資 TX 未平倉淨額口數
 * 資料來源：TAIFEX 公開網頁（免 key），POST 表單查詢
 *
 * 核心指標：外資未平倉淨額口數（正值=淨多/看多；負值=淨空/看空）
 */

async function fetchTaifexTable(dateStr) {
  const twNow = new Date(dateStr);
  const candidates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(twNow);
    d.setDate(twNow.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    candidates.push(`${y}/${m}/${day}`);
  }

  const url = "https://www.taifex.com.tw/cht/3/futContractsDate";

  for (const dateSlash of candidates) {
    const body = new URLSearchParams({
      queryStartDate: dateSlash,
      queryEndDate:   dateSlash,
      contractId: "TX",
      doQuery: "1"
    });

    let text;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "CryptoPulse-TW-Bot/1.0"
        },
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (!res.ok) continue;
      text = await res.text();
    } catch { continue; }

    // 第一個 <table> 含實際資料
    const tableMatch = text.match(/<table[\s\S]*?<\/table>/i);
    if (!tableMatch) continue;

    const cells = [...tableMatch[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;|\s+/g, " ").replace(/,/g, "").trim())
      .filter(Boolean);

    // 在 臺股期貨 之後找第一個 外資 cell
    const txIdx = cells.findIndex(c => c.includes("臺股期貨"));
    if (txIdx < 0) continue;

    // 外資 cell 名稱可能是「外資」或「外資及陸資」
    const foreignIdx = cells.findIndex((c, i) => i > txIdx && /^外資/.test(c));
    if (foreignIdx < 0) continue;

    // 12 個數值在 外資 之後
    const nums = [];
    for (let i = foreignIdx + 1; i < cells.length && nums.length < 12; i++) {
      const n = parseInt(cells[i]);
      if (Number.isFinite(n)) nums.push(n);
      else break;
    }
    if (nums.length < 12) continue;

    // 欄位順序（0-based）：
    // 0-5  = 交易多方口數/金額, 空方口數/金額, 淨額口數/金額
    // 6-11 = 未平倉多方口數/金額, 空方口數/金額, 淨額口數/金額 ← 我們要的是 index 10
    const netOI = nums[10]; // 未平倉淨額口數

    const yyyymmdd = dateSlash.replace(/\//g, "-");
    return { dataDate: yyyymmdd, netOI, longOI: nums[6], shortOI: nums[8] };
  }

  return null;
}

export async function collectTaifexForeignFutures() {
  const nowIso = new Date().toISOString();
  const twNow = new Date(Date.now() + 8 * 3600 * 1000);
  const dateStr = twNow.toISOString().slice(0, 10);

  const result = await fetchTaifexTable(dateStr).catch(() => null);

  if (!result) {
    return {
      updatedAt: nowIso,
      dataDate: null,
      available: false,
      error: "無法取得 TAIFEX 外資期貨部位"
    };
  }

  const { dataDate, netOI, longOI, shortOI } = result;
  return {
    updatedAt: nowIso,
    dataDate,
    available: true,
    netOI,       // 未平倉淨額口數（正=淨多，負=淨空）
    longOI,      // 多方未平倉口數
    shortOI,     // 空方未平倉口數
    source: "TAIFEX 三大法人期貨交易 TX"
  };
}
