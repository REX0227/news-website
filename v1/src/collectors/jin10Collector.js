/**
 * jin10Collector.js — 金十數據快訊收集器
 *
 * 用途：
 *   A. 後端 proxy（/api/jin10）即時轉發，前端每 60 秒輪詢
 *   B. 每次主循環呼叫，將重要加密相關新聞寫入 SQLite jin10_news 表
 *
 * API：https://flash-api.jin10.com/get_flash_list
 * 免費公開，無需登入，需帶 x-app-id / x-version headers
 */

const JIN10_API = "https://flash-api.jin10.com/get_flash_list";
const JIN10_HEADERS = {
  "x-app-id": "bVBF4FyRTn5NJF5n",
  "x-version": "1.0.0",
  "accept": "application/json"
};

// 加密 / 總經相關關鍵字（中英文，繁簡體均收錄）
const CRYPTO_RELEVANT = /bitcoin|btc|eth|ethereum|crypto|blockchain|defi|stablecoin|etf|fed\b|fomc|rate cut|rate hike|inflation|tariff|dollar\b|dxy|risk asset|liquidity|比特幣|加密貨幣|以太坊|美聯儲|聯準會|降息|加息|關稅|風險資產|流動性|穩定幣|資金費率|清算|機構|ETF|比特|以太|美联储|联储|降息|加息|关税|流动性|稳定币|清算|风险资产|通胀|通膨|利率|联邦|鲍威尔|Powell|黄金|oil|原油|石油|霍尔木兹|制裁|sanctions|bonds|treasury|殖利率|公債|期货|期貨|trump|川普|特朗普|middle east|中東|中东|israel|以色列|iran|伊朗|gaza|加沙|lebanon|黎巴嫩|hamas|胡塞|houthi|strait of hormuz|战争|戰爭|war|conflict|衝突|冲突|missile|导弹|導彈|airstrike|空袭|空襲|nuclear|核武|geopolit|地緣|地缘|oil supply|供油|能源危機|能源危机/i;

// ── 規則型分析 ────────────────────────────────────────────────────────

function analyzeDirection(content = "") {
  const t = content.toLowerCase();
  const bullish = /(rate cut|easing|dovish|approved|approval|inflow|institutional buy|pivot|降息|寬鬆|批准|流入|買入|利好|正面|支持|注資)/i.test(t);
  const bearish = /(rate hike|hawkish|ban|crackdown|outflow|liquidat|seizure|halt|sanction|加息|收緊|禁止|打壓|流出|清算|賣出|暫停|制裁|利空)/i.test(t);

  if (bullish && !bearish) return "做多";
  if (bearish && !bullish) return "做空";
  if (bullish && bearish)  return "做空";  // 衝突時偏保守
  return "中性";
}

function calcConfidence(isImportant, direction, content = "") {
  let score = isImportant ? 4 : 2;
  const hasCoreKeyword = /(fed\b|fomc|bitcoin|btc|rate|美聯儲|比特幣|加息|降息)/i.test(content);
  if (hasCoreKeyword) score = Math.min(score + 1, 5);
  if (direction === "中性") score = Math.max(score - 1, 1);
  return score;
}

function buildCommentary(content = "", direction) {
  const t = content.toLowerCase();
  if (direction === "做多") {
    if (/(rate cut|降息)/i.test(t))         return "降息預期升溫，對加密市場偏利多。";
    if (/(inflow|流入|institutional buy)/i.test(t)) return "資金流入訊號，短線情緒偏多。";
    if (/(approval|批准|approved)/i.test(t)) return "監管利好訊號，市場情緒可能轉正。";
    if (/(easing|寬鬆|dovish)/i.test(t))    return "貨幣政策寬鬆預期，風險資產偏多。";
    return "宏觀訊號偏多，關注後續量能確認。";
  }
  if (direction === "做空") {
    if (/(rate hike|加息)/i.test(t))         return "加息預期升溫，風險資產短線承壓。";
    if (/(ban|禁止|crackdown|打壓)/i.test(t)) return "監管收緊訊號，市場情緒偏謹慎。";
    if (/(liquidat|清算)/i.test(t))           return "清算事件發生，注意連鎖槓桿風險。";
    if (/(tariff|關稅)/i.test(t))             return "關稅政策衝擊全球風險資產，偏空。";
    if (/(outflow|流出)/i.test(t))            return "資金流出訊號，短線情緒偏空。";
    if (/(war|戰爭|战争|missile|導彈|导弹|airstrike|空襲|空袭|nuclear|核武)/i.test(t)) return "地緣軍事衝突升溫，市場避險情緒上升，風險資產短線承壓。";
    if (/(middle east|中東|中东|iran|伊朗|israel|以色列|houthi|胡塞|hormuz)/i.test(t)) return "中東局勢緊張，油價與避險需求同步上升，加密市場短線偏空。";
    if (/(trump|川普|特朗普)/i.test(t))        return "川普政策聲明影響市場預期，需留意突發政策風險。";
    return "宏觀訊號偏空，建議謹慎控制倉位。";
  }
  return "消息面中性，等待更多數據確認方向。";
}

// ── 將 jin10 raw item 轉換為標準格式 ────────────────────────────────

export function normalizeJin10Item(item) {
  const content = String(item.data?.content || "").trim();
  const direction = analyzeDirection(content);
  const confidence = calcConfidence(Boolean(item.important), direction, content);
  const commentary = buildCommentary(content, direction);
  const link = item.data?.link || `https://flash.jin10.com/detail/${item.id}`;

  // jin10 time 格式：'2026-04-01 01:10:46'（CST = UTC+8）
  let published_at;
  try {
    published_at = new Date(String(item.time).replace(" ", "T") + "+08:00").toISOString();
  } catch {
    published_at = new Date().toISOString();
  }

  // score: [-1, +1]，方向 × 強度，與 factor 系統同一尺度
  const dirMultiplier = direction === "做多" ? 1 : direction === "做空" ? -1 : 0;
  const score = dirMultiplier * ((confidence - 1) / 4); // confidence 1→0.0, 5→1.0

  return {
    id: String(item.id),
    published_at,
    content,
    link,
    direction,
    confidence,
    score,
    commentary,
    is_important: item.important ? 1 : 0
  };
}

// ── 主要 export：抓取 + 篩選 + 分析 ────────────────────────────────

/**
 * 抓取金十快訊，回傳加密相關重要新聞
 * @param {object} opts
 * @param {boolean} opts.onlyImportant - 只回傳 important:true 的新聞（預設 true）
 * @param {number}  opts.limit         - 最多回傳幾筆（預設 30）
 * @param {number}  opts.maxRetries    - 連線失敗最多重試次數（預設 2）
 * @param {number}  opts.retryDelayMs  - 每次重試等待毫秒（預設 30000）
 */
export async function collectJin10News({ onlyImportant = true, limit = 30, maxRetries = 2, retryDelayMs = 30_000 } = {}) {
  const url = new URL(JIN10_API);
  url.searchParams.set("channel", "-8200");
  url.searchParams.set("vip", "1");

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`[jin10] 重試第 ${attempt} 次（等待 ${retryDelayMs / 1000}s 後）...`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    }

    try {
      const res = await fetch(url.toString(), {
        headers: JIN10_HEADERS,
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        console.warn(`[jin10] 第 ${attempt + 1} 次請求失敗：${lastError}`);
        continue;
      }

      const json = await res.json();
      const rawItems = Array.isArray(json.data) ? json.data : [];

      const filtered = rawItems.filter(item => {
        const content = item.data?.content || "";
        if (onlyImportant && !item.important) return false;
        return CRYPTO_RELEVANT.test(content);
      }).slice(0, limit);

      const items = filtered.map(normalizeJin10Item);

      const retryNote = attempt > 0 ? `（第 ${attempt + 1} 次嘗試成功）` : "";
      console.log(`[jin10] 取得 ${items.length} 筆加密相關快訊（原始 ${rawItems.length} 筆）${retryNote}`);
      return { ok: true, items };

    } catch (e) {
      lastError = e?.message || String(e);
      console.warn(`[jin10] 第 ${attempt + 1} 次請求異常：${lastError}`);
    }
  }

  console.warn(`[jin10] 已重試 ${maxRetries} 次，全部失敗：${lastError}`);
  return { ok: false, reason: lastError, items: [] };
}
