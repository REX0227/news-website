/**
 * backfill-daily-advice.mjs
 *
 * 從 asset_comments / macro_comments / jin10_news 自動產生每日投資建議
 * 補齊 2026-02-01 至今所有日期（已有資料的日期跳過）
 *
 * 執行：node backend/scripts/backfill-daily-advice.mjs
 */

import { db, initializeDatabase } from "../database.js";

initializeDatabase();

const START_DATE = "2026-02-01";
const END_DATE   = new Date().toISOString().slice(0, 10);

// ── 中文對照 ──────────────────────────────────────────────────────────────────

const REGIME_ZH = {
  easing_early:     "早期寬鬆",
  easing_late:      "晚期寬鬆",
  tightening_early: "早期收緊",
  tightening_late:  "晚期收緊",
  neutral:          "中性",
  shock:            "衝擊",
};

const RISK_ZH = {
  low:      "低",
  moderate: "溫和",
  elevated: "偏高",
  high:     "高",
  extreme:  "極端",
};

// ── DB 查詢（找最近一筆，不超過當天結束）────────────────────────────────────

function getAsset(date) {
  return db.prepare(`
    SELECT regime_label, regime_confidence, score_short_term, score_mid_term,
           narrative_headline, full_json
    FROM asset_comments
    WHERE asset_class = 'crypto' AND date(computed_at) <= ?
    ORDER BY computed_at DESC LIMIT 1
  `).get(date);
}

function getMacro(date) {
  return db.prepare(`
    SELECT macro_regime_label, macro_regime_confidence, global_risk_level,
           global_risk_score, narrative_headline, full_json
    FROM macro_comments
    WHERE date(computed_at) <= ?
    ORDER BY computed_at DESC LIMIT 1
  `).get(date);
}

function getNews(date) {
  return db.prepare(`
    SELECT content, direction, confidence, published_at
    FROM jin10_news
    WHERE date(published_at) = ? AND confidence >= 70
    ORDER BY confidence DESC, published_at DESC
    LIMIT 4
  `).all(date);
}

// ── 內容生成 ─────────────────────────────────────────────────────────────────

function scoreToDir(s) {
  if (s == null) return "neutral";
  if (s >= 0.25)  return "bullish";
  if (s <= -0.25) return "bearish";
  return "neutral";
}

function headline(ac, mc, news) {
  // 優先 narrative_headline，其次新聞首條
  const nh = mc?.narrative_headline || ac?.narrative_headline;
  if (nh && nh.length > 4) return nh.slice(0, 80);
  if (news.length > 0) return news[0].content.slice(0, 75) + (news[0].content.length > 75 ? "…" : "");
  const regime = REGIME_ZH[ac?.regime_label || mc?.macro_regime_label] || "中性";
  return `市場處於${regime}階段，聚焦宏觀與資金流向`;
}

function whatHappened(ac, mc, news) {
  const parts = [];

  if (news.length > 0) {
    parts.push(news.slice(0, 3).map(n => `• ${n.content.slice(0, 90)}`).join("\n"));
  }

  const scores = [];
  if (ac?.score_short_term != null) scores.push(`短線 ${ac.score_short_term.toFixed(2)}`);
  if (ac?.score_mid_term   != null) scores.push(`中線 ${ac.score_mid_term.toFixed(2)}`);
  if (scores.length) parts.push(`系統訊號評分：${scores.join("，")}`);

  if (mc?.global_risk_level) {
    const risk = RISK_ZH[mc.global_risk_level] || mc.global_risk_level;
    parts.push(`全球風險：${risk}（分數 ${mc.global_risk_score?.toFixed(2) ?? "—"}）`);
  }

  return parts.join("\n") || "當日市場資料整理中，詳見訊號中心。";
}

function whyImportant(ac, mc) {
  try {
    const j = JSON.parse(ac?.full_json || "{}");
    if (j.narrative?.summary && j.narrative.summary.length > 10) return j.narrative.summary;
  } catch {}
  try {
    const j = JSON.parse(mc?.full_json || "{}");
    if (j.narrative?.summary && j.narrative.summary.length > 10) return j.narrative.summary;
  } catch {}

  const regime = REGIME_ZH[ac?.regime_label || mc?.macro_regime_label] || "中性";
  const risk   = RISK_ZH[mc?.global_risk_level] || "溫和";
  const conf   = ac?.regime_confidence != null ? `（置信度 ${Math.round(ac.regime_confidence * 100)}%）` : "";
  return `市場 Regime 為「${regime}」${conf}，全球風險水平${risk}。` +
    `需結合宏觀利率走向與加密資金費率、ETF 流量綜合研判後市方向。`;
}

function myView(ac, mc) {
  const regime = REGIME_ZH[ac?.regime_label || mc?.macro_regime_label] || "中性";
  const s  = ac?.score_short_term;
  const m  = ac?.score_mid_term;

  let bias;
  if (s == null) {
    bias = "訊號不足，保持觀望";
  } else if (s > 0.4 && (m == null || m > 0.2)) {
    bias = "短中線偏多，可積極參與上行機會，注意資金費率過熱時適度減倉";
  } else if (s > 0.2) {
    bias = "短線偏多但力度有限，輕倉介入為宜，突破確認再加碼";
  } else if (s < -0.4 && (m == null || m < -0.2)) {
    bias = "短中線偏空，建議降低倉位，空頭趨勢明確時可試空";
  } else if (s < -0.2) {
    bias = "短線偏弱，謹慎持有，現有多頭倉位加設保護性止損";
  } else {
    bias = "方向中性，區間震盪為主，等待突破方向確認再跟進";
  }

  return `Regime：${regime}。${bias}。`;
}

function actions(ac) {
  const s = ac?.score_short_term;
  if (s == null) {
    return {
      short: "等待訊號確立，不追漲殺跌，以觀望為主。",
      mid:   "倉位控制在 30–50%，待方向明確後再調整。",
      long:  "長線定投策略不受短期波動影響，持續執行。",
    };
  }
  if (s > 0.45) {
    return {
      short: "突破前高後積極加倉，止損設最近支撐下 2–3%，不追隔夜跳空。",
      mid:   "中線目標持倉 60–70%，利多持續則持有，利空訊號出現時分批減倉。",
      long:  "長線核心倉位持有，不因短波動輕易出場，可趁深回調補倉。",
    };
  }
  if (s > 0.2) {
    return {
      short: "輕倉試多，嚴格止損，不追高，等回踩支撐後再加碼。",
      mid:   "中線倉位 40–50%，方向更明確後上調。",
      long:  "長線持倉不變，回調至成本區可加倉。",
    };
  }
  if (s < -0.45) {
    return {
      short: "短線規避多頭倉位，空頭信號確認可輕倉做空，止損設前高上 2%。",
      mid:   "中線倉位降至 20% 以下，現金為王，等待企穩信號。",
      long:  "長線暫停加倉，持倉不追殺，等結構修復後再評估。",
    };
  }
  if (s < -0.2) {
    return {
      short: "短線謹慎，既有倉位加設止損，不輕易加倉。",
      mid:   "中線倉位控制在 30%，防禦為主。",
      long:  "長線視下跌為分批佈局機會，每跌 5% 補一次。",
    };
  }
  return {
    short: "短線無方向，區間操作，突破上下邊界再順勢跟進。",
    mid:   "中線持倉 40–50%，等 Regime 訊號收斂再決策。",
    long:  "長線持續定期定額，忽略短期雜訊。",
  };
}

function watchIndicators(mc, ac) {
  const items = ["BTC ETF 日淨流量（連續 3 天正流入視為確認）", "資金費率（>0.01% 需警惕過熱）", "10Y 美債殖利率"];
  const risk = mc?.global_risk_level;
  if (risk === "high" || risk === "extreme") {
    items.push("VIX 恐慌指數", "地緣風險快訊");
  }
  const label = mc?.macro_regime_label || ac?.regime_label || "";
  if (label.includes("tightening")) {
    items.push("CME FedWatch 降息機率");
  }
  if (label.includes("easing")) {
    items.push("穩定幣市值（TVL 增長代表資金入場）");
  }
  return items.join("、");
}

// ── 日期工具 ─────────────────────────────────────────────────────────────────

function dateRange(start, end) {
  const dates = [];
  const cur  = new Date(start + "T12:00:00Z");
  const last = new Date(end   + "T12:00:00Z");
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// ── 主程式 ────────────────────────────────────────────────────────────────────

const dates = dateRange(START_DATE, END_DATE);
console.log(`Backfilling ${dates.length} days: ${START_DATE} → ${END_DATE}`);

const stmt = db.prepare(`
  INSERT INTO daily_advice
    (date, headline, what_happened, why_important, my_view,
     action_short, action_mid, action_long, watch_indicators,
     overall_direction, regime_label, author, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(date) DO NOTHING
`);

let inserted = 0;
let skipped  = 0;

for (const date of dates) {
  const ac   = getAsset(date);
  const mc   = getMacro(date);
  const news = getNews(date);
  const acts = actions(ac);
  const now  = new Date().toISOString();

  const r = stmt.run(
    date,
    headline(ac, mc, news),
    whatHappened(ac, mc, news),
    whyImportant(ac, mc),
    myView(ac, mc),
    acts.short,
    acts.mid,
    acts.long,
    watchIndicators(mc, ac),
    scoreToDir(ac?.score_short_term),
    ac?.regime_label || mc?.macro_regime_label || "neutral",
    "auto",
    now,
    now
  );

  if (r.changes > 0) {
    inserted++;
    process.stdout.write(`\r  ${date} ✓  inserted:${inserted} skipped:${skipped}   `);
  } else {
    skipped++;
  }
}

console.log(`\nDone: ${inserted} inserted, ${skipped} skipped (already existed).`);
