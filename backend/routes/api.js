import { Router } from "express";
import { db, saveSnapshot, getSnapshot, logUpdate } from "../database.js";

// ── News enrichment helpers (source-agnostic) ────────────────────────
// 所有 computed field 從 content 計算，與 source 無關。
// 未來接入 CoinDesk / Bloomberg / RSS 同樣走這套 pipeline。

const CLASSIFIER_VERSION = "v2.2.0";

/**
 * relevance_crypto: 0-1 分數，衡量新聞與加密市場的相關性。
 * >= 0.3 才進預設 API 回應（可用 ?include_low_relevance=true 關閉）。
 */
function scoreRelevance(content = "") {
  let score = 0;
  // Tier 1: 直接加密相關 (+0.5)
  if (/(bitcoin|btc|ethereum|eth|crypto|blockchain|defi|stablecoin|usdt|usdc|altcoin|比特幣|以太坊|加密貨幣|穩定幣|比特|以太)/i.test(content)) score += 0.5;
  // Tier 1: ETF + crypto (+0.3)
  if (/(etf.*(crypto|bitcoin|btc)|bitcoin.*etf|比特幣.*etf|etf.*比特)/i.test(content)) score += 0.3;
  // Tier 2: 主要宏觀 (+0.25)
  if (/(fed\b|fomc|federal reserve|rate cut|rate hike|美聯儲|聯準會|降息|加息)/i.test(content)) score += 0.25;
  if (/(cpi\b|ppi\b|nfp\b|inflation|core pce|unemployment|非農|通膨|通脹|就業數據)/i.test(content)) score += 0.2;
  // Tier 2: 資金流 / 清算 (+0.2)
  if (/(liquidat|funding rate|open interest|流動性|清算|資金費率|爆倉)/i.test(content)) score += 0.2;
  // Tier 3: 美股 / DXY / 地緣（間接影響）(+0.1-0.15)
  if (/(s&p|spx|nasdaq|ndx|us stock|dow jones|美股|標普)/i.test(content)) score += 0.15;
  if (/(dxy\b|dollar index|美元指數)/i.test(content)) score += 0.15;
  if (/(gold\b|oil\b|crude|wti|brent|黃金|原油)/i.test(content)) score += 0.1;
  if (/(geopolit|war\b|sanction|地緣|戰爭|制裁|霍爾木茲|荷莫茲)/i.test(content)) score += 0.1;
  // Noise penalty (Chinese commodity futures / non-financial click-bait)
  if (/(乙二醇|甲醇|橡膠|聚丙烯|螺紋鋼|豆粕|pta\b|焦炭|鐵礦石|棉花|玉米期貨|大豆)/i.test(content)) score -= 0.4;
  if (/(點擊查看|點擊解鎖|訂閱查看|點擊獲取|click to unlock|subscribe to)/i.test(content)) score -= 0.3;
  return Math.max(0, Math.min(1, score));
}

/**
 * category: crypto / macro / regulatory / geopolitical / commodity / general
 * 優先序：crypto > regulatory > macro > geopolitical > commodity > general
 * v2.2: 補中文國名（伊朗/以色列/胡塞/加薩），修正地緣政治嚴重漏判
 */
function classifyCategory(content = "") {
  if (/(bitcoin|btc|ethereum|eth|crypto|blockchain|defi|stablecoin|nft|比特幣|以太坊|加密貨幣|穩定幣)/i.test(content)) return "crypto";
  if (/(sec\b|cftc\b|regulation|ban\b|approve|permit|法規|監管|禁止|批准|許可)/i.test(content)) return "regulatory";
  if (/(fed\b|fomc|boj|ecb|pboc|cpi\b|ppi\b|nfp\b|pce\b|rate|yield|dxy|inflation|gdp\b|美聯儲|聯準會|日銀|人民銀行|利率|通膨|通脹|就業|美元指數)/i.test(content)) return "macro";
  if (/(war\b|missile|airstrike|sanction|geopolit|iran|israel|houthi|gaza|伊朗|以色列|胡塞|加薩|中東|戰爭|地緣|制裁|導彈|空襲|衝突)/i.test(content)) return "geopolitical";
  if (/(oil\b|crude|gold\b|commodity|乙二醇|甲醇|橡膠|鐵礦|農產品|原油|黃金|大宗|化工)/i.test(content)) return "commodity";
  return "general";
}

/**
 * event_type: fed_speech / data_release / etf_flow / liquidation_event /
 *             regulation / geopolitical_shock / trade_policy / central_bank / general
 *
 * v2.2: 改用 entities-based 匹配為主，解決舊版雙詞距離過嚴導致 100% general 的問題。
 * 接受 entities 陣列（由 extractEntities 預先計算）加速判斷。
 */
function classifyEventType(content = "", entities = []) {
  const t = content;
  const ent = new Set(entities);

  // 1. 清算事件（有金額數字）— 最具體，優先
  if (/(liquidat|清算|爆倉).{0,80}(\d|million|billion|億|百萬|\$)/i.test(t) ||
      /(\$[\d.]+|\d[\d,]*\s*(million|billion|億|百萬)).{0,80}(liquidat|清算|爆倉)/i.test(t)) return "liquidation_event";

  // 2. ETF 資金流
  if ((ent.has("ETF") || /\betf\b/i.test(t)) &&
      /(flow|inflow|outflow|net|billion|million|流入|流出|淨流|净流|外流|\d)/i.test(t)) return "etf_flow";

  // 3. 數據發布（寬鬆：有指標詞 + 數字/發布動詞/統計術語）
  if ((ent.has("CPI") || ent.has("NFP") || ent.has("PPI") || ent.has("PCE") || ent.has("GDP")) &&
      /(\d|%|公布|發布|出爐|初值|終值|預期|前值|同比|環比|年增|月增|actual|release|revised|beat|miss)/i.test(t)) return "data_release";

  // 4. 貿易政策
  if (ent.has("Tariff") || /(tariff|trade war|trade policy|關稅|貿易戰|貿易政策)/i.test(t)) return "trade_policy";

  // 5. 監管
  if (ent.has("SEC") || ent.has("CFTC") ||
      /(sec\b|cftc\b).{0,80}(crypto|bitcoin|btc|加密|比特|approve|ban|批准|禁止)/i.test(t) ||
      /(crypto|bitcoin|加密|比特).{0,80}(sec\b|cftc\b|regulation|approve|ban\b|法規|監管|批准|禁止)/i.test(t)) return "regulation";

  // 6. Fed 講話（寬鬆：Fed/Powell/FOMC + 任何發言動詞或中文冒號引述）
  if ((ent.has("Fed") || ent.has("FOMC") || ent.has("Powell")) &&
      /(speak|warn|testif|said|says|alert|speech|言論|警告|表示|聲明|講話|強調|指出|認為|稱|：|:)/i.test(t)) return "fed_speech";

  // 7. 中央銀行決策
  if ((ent.has("BOJ") || ent.has("ECB") || /\bpboc\b|人民銀行/i.test(t)) &&
      /(rate|decision|meeting|policy|利率|決議|會議|政策|降息|加息|寬鬆|收緊)/i.test(t)) return "central_bank";
  if ((ent.has("Fed") || ent.has("FOMC")) &&
      /(rate|decision|meeting|利率|決議|會議|加息|降息)/i.test(t)) return "central_bank";

  // 8. 地緣衝突（補中文國名：伊朗/以色列/胡塞/加薩）
  if ((ent.has("Iran") || ent.has("Israel") || /伊朗|以色列|胡塞|加薩/i.test(t)) &&
      /(war|attack|missile|sanction|conflict|bomb|airstr|升溫|緊張|戰爭|攻擊|導彈|制裁|空襲|衝突)/i.test(t)) return "geopolitical_shock";
  if (/(霍爾木茲|荷莫茲|strait of hormuz)/i.test(t)) return "geopolitical_shock";
  if (/(war\b|missile|airstrike|戰爭|導彈|空襲).{0,80}(market|supply|oil|energy|市場|供應|原油|能源)/i.test(t)) return "geopolitical_shock";

  // 9. 實體存在但未命中更具體分類的 fallback
  if (ent.has("Powell") || ent.has("FOMC")) return "fed_speech";
  if (ent.has("Fed") && /(rate|利率|hawk|dove|鷹|鴿)/i.test(t)) return "fed_speech";
  if (ent.has("BOJ") || ent.has("ECB")) return "central_bank";
  if (ent.has("CPI") || ent.has("NFP") || ent.has("PPI") || ent.has("PCE") || ent.has("GDP")) return "data_release";

  return "general";
}

/**
 * entities: 從內容中提取重要實體名稱。
 */
function extractEntities(content = "") {
  const checks = [
    [/\bFed\b|Federal Reserve|美聯儲|聯準會/i, "Fed"],
    [/\bFOMC\b/i, "FOMC"],
    [/Powell|鮑威爾/i, "Powell"],
    [/\bCPI\b/i, "CPI"], [/\bNFP\b|非農就業/i, "NFP"], [/\bPPI\b/i, "PPI"],
    [/\bPCE\b/i, "PCE"], [/\bGDP\b/i, "GDP"],
    [/\bBTC\b|Bitcoin|比特幣/i, "BTC"], [/\bETH\b|Ethereum|以太坊/i, "ETH"],
    [/\bSOL\b|Solana/i, "SOL"], [/\bXRP\b|Ripple/i, "XRP"],
    [/\bETF\b/i, "ETF"], [/\bSEC\b/i, "SEC"], [/\bCFTC\b/i, "CFTC"],
    [/Trump|川普|特朗普/i, "Trump"],
    [/Iran|伊朗/i, "Iran"], [/Israel|以色列/i, "Israel"],
    [/\bDXY\b|Dollar Index|美元指數/i, "DXY"], [/\bVIX\b/i, "VIX"],
    [/\bGold\b|黃金/i, "Gold"], [/\bOil\b|原油|WTI\b|Brent\b/i, "Oil"],
    [/\bBOJ\b|日本央行|日銀/i, "BOJ"], [/\bECB\b|歐央行/i, "ECB"],
    [/MicroStrategy|Strategy\b/i, "MicroStrategy"],
    [/BlackRock|貝萊德/i, "BlackRock"],
    [/Tariff|關稅/i, "Tariff"],
    [/S&P|SPX\b|S&P 500/i, "SPX"], [/Nasdaq|NDX\b/i, "NDX"],
  ];
  const found = [];
  for (const [rx, name] of checks) {
    if (rx.test(content)) found.push(name);
  }
  return found;
}

/**
 * is_clickbait: 截斷式新聞（結尾含「點擊查看」等）。
 */
function isClickbait(content = "") {
  return /(點擊查看|點擊解鎖|訂閱查看|點擊獲取|click to unlock|subscribe to view|更多詳情請|查看更多$)/i.test(content.trim());
}

/**
 * direction_en (v2.2): 加權詞庫多空分類器。
 * 回傳: "bullish" | "bearish" | "neutral" | "ambiguous"
 *
 * 設計原則：
 *  - 三層加權詞庫（高/中/低，權重 3/2/1），取代純計數閾值
 *  - 任何方向的淨主導（bearScore > bullScore 或反之）即輸出方向
 *  - 雙方均有訊號且相近 → ambiguous；雙方均無 → neutral
 *  - 簡單否定句（不降息/not rate hike 等）做 -2 調整
 *  - 不呼叫 LLM，純規則型，零延遲
 */
function classifyDirectionV2(content = "") {
  const t = content;
  const tl = t.toLowerCase();

  // ── 加權詞庫 [weight, keywords[]] ──────────────────────────────
  const BEAR_TERMS = [
    [3, [
      // 繁體
      "爆倉","清算","暴跌","崩盤","崩潰",
      // 簡體
      "崩盘","崩溃",
      // 英文
      "liquidat","crash","collapse","margin call","bank run",
    ]],
    [2, [
      // 貨幣緊縮（繁+簡）
      "加息","收緊","收紧","鷹派","鹰派","hawkish","tightening","rate hike","支持收緊","支持收紧","警告通脹","警告通膨","通脹威脅","通膨威脅",
      // 制裁/禁令（繁+簡）
      "禁止","打壓","打压","制裁","ban","crackdown","sanction","seizure",
      // 貿易衝突（繁+簡）
      "關稅","关税","貿易戰","贸易战","tariff","trade war",
      // 地緣衝突（繁+簡）
      "戰爭","战争","衝突","冲突","升溫","升温","war","conflict","missile","airstrike","escalat",
      "封锁","拦截","受阻","中断","袭击","轰炸",
      // 資金外流（繁+簡，補 外流）
      "流出","外流","拋售","抛售","outflow","大跌",
    ]],
    [1, [
      // 價格下行（繁+簡）
      "下跌","下滑","走低","回落","失守","跌破","承壓","承压","decline","fell","drop","slump","tumble",
      // 情緒/風險（繁+簡）
      "風險","风险","擔憂","担忧","警告","risk","concern","warning","bearish",
      // 市場負面（繁+簡）
      "利空","悲觀","悲观","下行","壓力","压力","訴訟","诉讼","halt","暫停","暂停","賣出","卖出","售出","減持","减持",
      // 新增：常見簡體金融負面詞
      "拒绝","受阻","中断","封禁","处罚","罚款","违规","暂停","冻结","查处",
    ]],
  ];

  const BULL_TERMS = [
    [3, [
      // ETF 批准
      "etf approved","etf批准",
      // 加密戰略儲備（限定加密幣語境，避免誤觸美國石油儲備 SPR）
      "比特幣戰略儲備","比特币战略储备","加密戰略儲備","加密战略储备","crypto strategic reserve","bitcoin reserve",
      // 歷史新高
      "創新高","创新高","all-time high","ath",
      // 機構買入
      "institutional buy","機構買入","机构买入",
    ]],
    [2, [
      // 貨幣寬鬆（繁+簡）
      "降息","寬鬆","宽松","鴿派","鸽派","dovish","easing","rate cut","支持降息","降息預期","降息预期","降息週期",
      // 批准/流入（繁+簡）
      "批准","approved","approval","流入","買入","买入","增持","inflow","buying","accumulate",
      // 刺激/救市（繁+簡）
      "注資","注资","刺激","stimulus","pivot","bailout","救市",
      // 價格突破（繁+簡）
      "暴漲","暴涨","突破","rally","surge","breakout",
      // 新增：常見簡體金融正面詞
      "走高","攀升","上升","飙升","飆升","大涨","提振","回暖","复苏",
    ]],
    [1, [
      // 一般正面（繁+簡）
      "利好","積極","积极","樂觀","乐观","上漲","上涨","走強","走强","回升","反彈","反弹","支撐","支撑",
      "bullish","positive","optimist","recover","rebound","growth","增長","增长","買超","买超",
      // 新增：常見正面詞
      "看涨","牛市","做多","多头","净买入","净流入",
    ]],
  ];

  let bearScore = 0, bullScore = 0;
  for (const [w, kws] of BEAR_TERMS) {
    for (const kw of kws) if (tl.includes(kw)) bearScore += w;
  }
  for (const [w, kws] of BULL_TERMS) {
    for (const kw of kws) if (tl.includes(kw)) bullScore += w;
  }

  // ── 否定句調整（常見中英文否定 + 正/負面詞組合）──────────────
  // 允許否定詞與目標詞之間有最多 6 個字（例：「不支持降息」「未考慮寬鬆」）
  // 否定句（繁簡通用：不/未/沒有/没有 + 正/負面詞，允許中間隔最多6個字）
  if (/(不|未|沒有|没有)\S{0,6}(降息|寬鬆|宽松|鴿派|鸽派|批准|流入|買入|买入)/.test(t)) bullScore = Math.max(0, bullScore - 2);
  if (/(不|未|沒有|没有)\S{0,6}(加息|收緊|收紧|禁止|制裁|升溫|升温|戰爭|战争)/.test(t)) bearScore = Math.max(0, bearScore - 2);
  if (/(no sign of|not |avoid |prevent )\S{0,20}(rate cut|easing|approved|inflow)/i.test(t)) bullScore = Math.max(0, bullScore - 2);
  if (/(no sign of|not |avoid |prevent )\S{0,20}(rate hike|war|sanction|ban)/i.test(t)) bearScore = Math.max(0, bearScore - 2);

  // ── 判斷邏輯 ─────────────────────────────────────────────────
  if (bearScore === 0 && bullScore === 0) return "neutral";
  if (bearScore > bullScore) return "bearish";
  if (bullScore > bearScore) return "bullish";
  return "ambiguous"; // 兩方訊號相當
}

/**
 * enrichNewsItem: 將 DB row 加上所有 computed fields。
 * 保留舊欄位（backward compat），新欄位都在同一層。
 */
function enrichNewsItem(row) {
  const relevance_crypto = Number(scoreRelevance(row.content).toFixed(3));
  const entities = extractEntities(row.content);          // 先抽 entities
  const direction_en = classifyDirectionV2(row.content);
  const event_type = classifyEventType(row.content, entities); // entities 傳入，避免重複抽取
  const category = classifyCategory(row.content);
  const clickbait = isClickbait(row.content);
  const available_at = row.saved_at;

  let ingest_lag_seconds = null;
  const pub_ms = new Date(row.published_at).getTime();
  const sav_ms = new Date(row.saved_at).getTime();
  if (Number.isFinite(pub_ms) && Number.isFinite(sav_ms)) {
    ingest_lag_seconds = Math.round((sav_ms - pub_ms) / 1000);
  }

  return {
    // Primary identity
    id: row.id,
    source: "jin10",
    source_id: row.id,
    source_url: row.link,
    // Time
    published_at: row.published_at,
    available_at,
    ingest_lag_seconds,
    // Content
    content: row.content,
    is_clickbait: clickbait,
    // Classification
    relevance_crypto,
    category,
    entities,
    event_type,
    direction_en,
    classifier_version: CLASSIFIER_VERSION,
    // Legacy fields (backward compat)
    confidence: row.confidence,
    is_important: row.is_important,
    link: row.link,
    direction: row.direction,       // 舊版中文，保留給舊 client
    commentary: row.commentary,
    saved_at: row.saved_at,
  };
}

/** 計算 per-source 新鮮度 meta */
function buildSourcesMeta() {
  const row = db.prepare(`
    SELECT saved_at FROM jin10_news ORDER BY saved_at DESC LIMIT 1
  `).get();
  if (!row) return { jin10: { latest_saved_at: null, age_seconds: null } };
  const age = Math.round((Date.now() - new Date(row.saved_at).getTime()) / 1000);
  return { jin10: { latest_saved_at: row.saved_at, age_seconds: age } };
}

// ── Jin10 live-proxy helpers (legacy, for /api/jin10 only) ──────────
const JIN10_API = "https://flash-api.jin10.com/get_flash_list";
const JIN10_HEADERS = { "x-app-id": "bVBF4FyRTn5NJF5n", "x-version": "1.0.0", "accept": "application/json" };
const CRYPTO_RELEVANT = /bitcoin|btc|eth|ethereum|crypto|blockchain|defi|stablecoin|etf|fed\b|fomc|rate cut|rate hike|inflation|tariff|dollar\b|dxy|risk asset|liquidity|比特幣|加密貨幣|以太坊|美聯儲|聯準會|降息|加息|關稅|風險資產|流動性|穩定幣|比特|以太|美联储|联储|关税|流动性|稳定币|清算|风险资产|通胀|通膨|利率|联邦|鲍威尔|Powell|黄金|oil|原油|石油|霍尔木兹|制裁|sanctions|bonds|treasury|殖利率|公債|期货|期貨|trump|川普|特朗普|middle east|中東|中东|israel|以色列|iran|伊朗|gaza|加沙|lebanon|黎巴嫩|hamas|胡塞|houthi|strait of hormuz|战争|戰爭|war|conflict|衝突|冲突|missile|导弹|導彈|airstrike|空袭|空襲|nuclear|核武|geopolit|地緣|地缘|oil supply|供油|能源危機|能源危机/i;

function jin10Direction(content = "") {
  const t = content.toLowerCase();
  const bull = /(rate cut|easing|dovish|approved|approval|inflow|institutional buy|pivot|降息|寬鬆|批准|流入|買入|利好|支持|注資)/i.test(t);
  const bear = /(rate hike|hawkish|ban|crackdown|outflow|liquidat|seizure|halt|sanction|加息|收緊|禁止|打壓|流出|清算|賣出|暫停|制裁|利空)/i.test(t);
  if (bull && !bear) return "做多";
  if (bear) return "做空";
  return "中性";
}
function jin10Confidence(isImportant, direction, content = "") {
  let s = isImportant ? 4 : 2;
  if (/(fed\b|fomc|bitcoin|btc|rate|美聯儲|比特幣|加息|降息)/i.test(content)) s = Math.min(s + 1, 5);
  if (direction === "中性") s = Math.max(s - 1, 1);
  return s;
}
function jin10Commentary(content = "", direction) {
  const t = content.toLowerCase();
  if (direction === "做多") {
    if (/(rate cut|降息)/i.test(t))  return "降息預期升溫，對加密市場偏利多。";
    if (/(inflow|流入)/i.test(t))    return "資金流入訊號，短線情緒偏多。";
    if (/(approval|批准)/i.test(t))  return "監管利好訊號，市場情緒可能轉正。";
    return "宏觀訊號偏多，關注後續量能確認。";
  }
  if (direction === "做空") {
    if (/(rate hike|加息)/i.test(t))  return "加息預期升溫，風險資產短線承壓。";
    if (/(ban|禁止|crackdown)/i.test(t)) return "監管收緊訊號，市場情緒偏謹慎。";
    if (/(liquidat|清算)/i.test(t))   return "清算事件發生，注意連鎖槓桿風險。";
    if (/(tariff|關稅)/i.test(t))     return "關稅政策衝擊全球風險資產，偏空。";
    if (/(war|戰爭|战争|missile|導彈|导弹|airstrike|空襲|空袭|nuclear|核武)/i.test(t)) return "地緣軍事衝突升溫，市場避險情緒上升，風險資產短線承壓。";
    if (/(middle east|中東|中东|iran|伊朗|israel|以色列|houthi|胡塞|hormuz)/i.test(t)) return "中東局勢緊張，油價與避險需求同步上升，加密市場短線偏空。";
    if (/(trump|川普|特朗普)/i.test(t)) return "川普政策聲明影響市場預期，需留意突發政策風險。";
    return "宏觀訊號偏空，建議謹慎控制倉位。";
  }
  return "消息面中性，等待更多數據確認方向。";
}
function normalizeJin10Item(item) {
  const content = String(item.data?.content || "").trim();
  const direction = jin10Direction(content);
  const confidence = jin10Confidence(Boolean(item.important), direction, content);
  const commentary = jin10Commentary(content, direction);
  const link = item.data?.link || `https://flash.jin10.com/detail/${item.id}`;
  let published_at;
  try { published_at = new Date(String(item.time).replace(" ", "T") + "+08:00").toISOString(); }
  catch { published_at = new Date().toISOString(); }
  return { id: String(item.id), published_at, content, link, direction, confidence, commentary, is_important: item.important ? 1 : 0 };
}

const router = Router();

// ────────────────────────────────────────────────────────────────────
// GET /api/health
// ────────────────────────────────────────────────────────────────────
router.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ────────────────────────────────────────────────────────────────────
// GET /api/news  ← P-1-0 / P0-1 / P0-2 / P0-3 / P1-4 / P1-7 修正
//
// Source-agnostic news 端點。永遠從 SQLite 讀，不直接打上游。
// 上游可用性問題透過 sources.{source}.age_seconds 透明揭露。
//
// Query params:
//   limit              int   預設 30，最大 200
//   since              ISO   cursor（published_at >= since）
//   source             str   "jin10"（未來可多值逗號分隔）
//   category           str   crypto|macro|regulatory|geopolitical|commodity|general
//   event_type         str   fed_speech|data_release|etf_flow|liquidation_event|
//                            regulation|trade_policy|central_bank|geopolitical_shock|general
//   direction          str   bullish|bearish|neutral|ambiguous
//   relevance_min      float 預設 0.3（[0,1]）
//   min_confidence     int   1-5，基於舊 confidence 欄位
//   include_low_relevance bool "true" = 不套 relevance filter
// ────────────────────────────────────────────────────────────────────
router.get("/news", (req, res) => {
  const {
    limit, since, source,
    category, event_type, direction,
    relevance_min, min_confidence,
    include_low_relevance
  } = req.query;

  const limitNum = Math.min(Number(limit) || 30, 200);
  const relevanceMin = include_low_relevance === "true" ? 0 : Math.max(0, Math.min(1, Number(relevance_min ?? 0.3)));
  const confMin = min_confidence ? Math.max(1, Math.min(5, Number(min_confidence))) : null;

  // Fetch 5× requested (to allow in-memory filtering after relevance scoring)
  // Cap at 1000 to prevent huge scans
  const fetchLimit = Math.min(limitNum * 5, 1000);

  let rows;
  if (since) {
    rows = db.prepare(`
      SELECT * FROM jin10_news
      WHERE published_at >= ?
      ORDER BY published_at DESC
      LIMIT ?
    `).all(since, fetchLimit);
  } else {
    rows = db.prepare(`
      SELECT * FROM jin10_news
      ORDER BY published_at DESC
      LIMIT ?
    `).all(fetchLimit);
  }

  // Enrich
  let items = rows.map(enrichNewsItem);

  // Filter: source (always "jin10" for now — future: multi-source)
  if (source) {
    const allowed = String(source).toLowerCase().split(",").map(s => s.trim());
    items = items.filter(i => allowed.includes(i.source));
  }
  // Filter: relevance
  items = items.filter(i => i.relevance_crypto >= relevanceMin);
  // Filter: category
  if (category) items = items.filter(i => i.category === String(category).toLowerCase());
  // Filter: event_type
  if (event_type) items = items.filter(i => i.event_type === String(event_type));
  // Filter: direction
  if (direction) items = items.filter(i => i.direction_en === String(direction).toLowerCase());
  // Filter: confidence (legacy field)
  if (confMin !== null) items = items.filter(i => Number(i.confidence) >= confMin);

  items = items.slice(0, limitNum);

  res.json({
    ok: true,
    count: items.length,
    sources: buildSourcesMeta(),
    filters_applied: {
      relevance_min: relevanceMin,
      source: source || null,
      category: category || null,
      event_type: event_type || null,
      direction: direction || null,
      min_confidence: confMin
    },
    items
  });
});

// ────────────────────────────────────────────────────────────────────
// GET /api/news/history  ← P1-6 / P1-7
//
// 分頁歷史查詢，backtest 必要。
//
// Query params:
//   limit              int   預設 100，最大 1000
//   offset             int   分頁偏移
//   from               ISO   時間窗起點（published_at >= from）
//   to                 ISO   時間窗終點（published_at <= to）
//   since              ISO   cursor，live polling 用（published_at >= since）
//   source / category / event_type / direction / relevance_min /
//   min_confidence / include_low_relevance：同 /api/news
// ────────────────────────────────────────────────────────────────────
router.get("/news/history", (req, res) => {
  const {
    limit, offset, from, to, since,
    source, category, event_type, direction,
    relevance_min, min_confidence,
    include_low_relevance
  } = req.query;

  const limitNum = Math.min(Number(limit) || 100, 1000);
  const offsetNum = Math.max(Number(offset) || 0, 0);
  const relevanceMin = include_low_relevance === "true" ? 0 : Math.max(0, Math.min(1, Number(relevance_min ?? 0)));
  const confMin = min_confidence ? Math.max(1, Math.min(5, Number(min_confidence))) : null;

  // Build time filter
  const conditions = [];
  const params = [];
  if (from)  { conditions.push("published_at >= ?"); params.push(from); }
  if (to)    { conditions.push("published_at <= ?"); params.push(to); }
  if (since) { conditions.push("published_at >= ?"); params.push(since); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  // When no time filter but have in-memory filters, fetch extra
  const dbFetchLimit = (category || event_type || direction || relevanceMin > 0 || confMin)
    ? Math.min(limitNum * 5, 5000)
    : limitNum;
  const dbOffset = (category || event_type || direction || relevanceMin > 0 || confMin) ? 0 : offsetNum;

  const rows = db.prepare(`
    SELECT * FROM jin10_news
    ${where}
    ORDER BY published_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, dbFetchLimit, dbOffset);

  let items = rows.map(enrichNewsItem);

  if (source) {
    const allowed = String(source).toLowerCase().split(",").map(s => s.trim());
    items = items.filter(i => allowed.includes(i.source));
  }
  if (relevanceMin > 0) items = items.filter(i => i.relevance_crypto >= relevanceMin);
  if (category) items = items.filter(i => i.category === String(category).toLowerCase());
  if (event_type) items = items.filter(i => i.event_type === String(event_type));
  if (direction) items = items.filter(i => i.direction_en === String(direction).toLowerCase());
  if (confMin !== null) items = items.filter(i => Number(i.confidence) >= confMin);

  const total = items.length;
  items = items.slice(offsetNum, offsetNum + limitNum);

  res.json({
    ok: true,
    count: items.length,
    total_matched: total,
    limit: limitNum,
    offset: offsetNum,
    sources: buildSourcesMeta(),
    items
  });
});

// ────────────────────────────────────────────────────────────────────
// DEPRECATED: /api/jin10  →  使用 /api/news?source=jin10
// 保留作向後相容，直接打上游（原始行為）。
// ────────────────────────────────────────────────────────────────────
router.get("/jin10", async (_req, res) => {
  res.setHeader("Deprecation", 'date="2026-10-01T00:00:00Z"');
  res.setHeader("Sunset", "2026-10-01T00:00:00Z");
  res.setHeader("Link", '</api/news>; rel="successor-version"');
  res.setHeader("X-Deprecated-Message", "Use GET /api/news instead. /api/jin10 will be removed 2026-10-01.");
  try {
    const url = new URL(JIN10_API);
    url.searchParams.set("channel", "-8200");
    url.searchParams.set("vip", "1");
    const upstream = await fetch(url.toString(), {
      headers: JIN10_HEADERS,
      signal: AbortSignal.timeout(15000)
    });
    if (!upstream.ok) return res.status(502).json({ ok: false, items: [], reason: `jin10 HTTP ${upstream.status}` });
    const json = await upstream.json();
    const rawItems = Array.isArray(json.data) ? json.data : [];
    const items = rawItems
      .filter(item => CRYPTO_RELEVANT.test(item.data?.content || ""))
      .slice(0, 30)
      .map(normalizeJin10Item);
    res.json({ ok: true, fetchedAt: new Date().toISOString(), count: items.length, items });
  } catch (e) {
    res.status(502).json({ ok: false, items: [], reason: String(e?.message || e) });
  }
});

// ────────────────────────────────────────────────────────────────────
// DEPRECATED: /api/jin10/history  →  使用 /api/news/history?source=jin10
// ────────────────────────────────────────────────────────────────────
router.get("/jin10/history", (req, res) => {
  res.setHeader("Deprecation", 'date="2026-10-01T00:00:00Z"');
  res.setHeader("Sunset", "2026-10-01T00:00:00Z");
  res.setHeader("Link", '</api/news/history>; rel="successor-version"');
  res.setHeader("X-Deprecated-Message", "Use GET /api/news/history instead. /api/jin10/history will be removed 2026-10-01.");
  try {
    const limit  = Math.min(parseInt(req.query.limit  || "100", 10), 500);
    const offset = Math.max(parseInt(req.query.offset || "0",   10), 0);
    const rows = db.prepare(`
      SELECT id, published_at, content, link, direction, confidence, commentary, is_important, saved_at
      FROM jin10_news
      ORDER BY published_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    res.json({ ok: true, count: rows.length, items: rows });
  } catch (e) {
    res.status(500).json({ ok: false, items: [], reason: String(e?.message || e) });
  }
});

// ────────────────────────────────────────────────────────────────────
// GET /api/dashboard - returns latest dashboard snapshot
// ────────────────────────────────────────────────────────────────────
router.get("/dashboard", (_req, res) => {
  const snapshot = getSnapshot("crypto_dashboard:latest");
  if (!snapshot) {
    return res.status(404).json({
      error: "No dashboard data available. Run the update script first."
    });
  }
  res.json(snapshot.data);
});

// GET /api/dashboard/updated
router.get("/dashboard/updated", (_req, res) => {
  const snapshot = getSnapshot("crypto_dashboard:latest");
  if (!snapshot) {
    return res.status(404).json({ lastUpdated: null });
  }
  res.json({ lastUpdated: snapshot.updatedAt });
});

// GET /api/macro-events - optional ?country=US&days=7
router.get("/macro-events", (req, res) => {
  const snapshot = getSnapshot("crypto_dashboard:latest");
  if (!snapshot) {
    return res.status(404).json({ error: "No data available." });
  }
  let events = snapshot.data.macroEvents || [];
  const { country, days } = req.query;
  if (country) {
    events = events.filter((e) => String(e.country || "").toUpperCase() === String(country).toUpperCase());
  }
  if (days) {
    const daysNum = parseInt(days, 10);
    if (Number.isFinite(daysNum) && daysNum > 0) {
      const cutoff = new Date(Date.now() + daysNum * 24 * 60 * 60 * 1000).toISOString();
      const past = new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000).toISOString();
      events = events.filter((e) => {
        const dt = e.datetime || "";
        return dt >= past && dt <= cutoff;
      });
    }
  }
  res.json({ events, count: events.length });
});

// GET /api/signals
router.get("/signals", (_req, res) => {
  const snapshot = getSnapshot("crypto_dashboard:latest");
  if (!snapshot) {
    return res.status(404).json({ error: "No data available." });
  }
  const signals = snapshot.data.cryptoSignals || [];
  res.json({ signals, count: signals.length });
});

// GET /api/update-log
router.get("/update-log", (_req, res) => {
  const rows = db
    .prepare("SELECT id, status, collectors_ran, error_message, created_at FROM update_log ORDER BY id DESC LIMIT 10")
    .all();
  res.json({ log: rows });
});

// POST /api/dashboard
router.post("/dashboard", (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Invalid request body. Expected JSON object." });
  }
  try {
    saveSnapshot("crypto_dashboard:latest", body);
    const collectorsRan = Array.isArray(body.macroEvents) ? 1 : 0;
    logUpdate("success", collectorsRan, null);
    res.json({
      ok: true,
      savedAt: new Date().toISOString(),
      macroEventCount: (body.macroEvents || []).length,
      signalCount: (body.cryptoSignals || []).length
    });
  } catch (err) {
    logUpdate("error", 0, String(err.message));
    res.status(500).json({ error: "Failed to save dashboard data.", detail: err.message });
  }
});

export default router;
