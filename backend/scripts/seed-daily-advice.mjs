import { db, initializeDatabase } from "../database.js";

initializeDatabase();

const now = new Date().toISOString();

const entries = [
  {
    date: "2026-06-22",
    headline: "BTC 持倉成本線下方成交量驟縮，市場等待 FOMC 信號",
    what_happened: "昨日 BTC 合約多空比維持 0.95，24h 清算量 $48M（多頭佔 62%），資金費率回落至 0.003%。FRED 10Y 殖利率 4.32%，Fear & Greed 指數 58（貪婪）。",
    why_important: "FOMC 會議紀錄本週釋出，市場對降息預期分歧擴大。BTC 資金費率下行代表槓桿降溫，短期波動率收縮後往往有方向性突破。多頭清算比例偏高暗示空頭未充分建倉，反彈彈性仍存。",
    my_view: "當前 Regime 偏中性偏多，Gate 評分 6.2/10。聯準會鴿派信號若確認，短線有機會上攻。但 10Y 殖利率若上行突破 4.5%，需轉謹慎。",
    action_short: "等待 FOMC 紀錄釋出後方向確認，突破關鍵阻力再進場，止損設前低下 2%。",
    action_mid: "利率方向明朗前倉位控制在 30–50%，分批建倉。",
    action_long: "持續觀察機構淨流入趨勢（ETF 連續流入 > 5 天視為確認），長線佈局勿使用槓桿。",
    watch_indicators: "FOMC 紀錄（週三）、10Y 殖利率變化、BTC ETF 日流量、資金費率是否重回 0.01% 以上",
    overall_direction: "neutral",
    regime_label: "easing_early",
    author: "manual",
  },
];

const stmt = db.prepare(`
  INSERT INTO daily_advice
    (date, headline, what_happened, why_important, my_view,
     action_short, action_mid, action_long, watch_indicators,
     overall_direction, regime_label, author, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(date) DO NOTHING
`);

for (const e of entries) {
  stmt.run(
    e.date, e.headline, e.what_happened, e.why_important, e.my_view,
    e.action_short, e.action_mid, e.action_long, e.watch_indicators,
    e.overall_direction, e.regime_label, e.author, now, now
  );
  console.log(`Inserted: ${e.date}`);
}

console.log("Done.");
