/**
 * calibrate-direction.mjs
 * ────────────────────────────────────────────────────────────────
 * 離線 LLM 校準工具（方案 1）
 * 用途：用 Claude API 對最近 N 筆新聞自動產生 pseudo-label，
 *       比對現有規則型分類結果，輸出 confusion matrix + 建議。
 *
 * 執行方式：
 *   node scripts/calibrate-direction.mjs              # 預設 300 筆
 *   node scripts/calibrate-direction.mjs --limit 500  # 指定筆數
 *   node scripts/calibrate-direction.mjs --report     # 輸出 JSON 報告
 *
 * 注意：
 *  - 此腳本僅供離線校準，不進入任何 realtime pipeline
 *  - 需要 ANTHROPIC_API_KEY 環境變數
 *  - 校準完後可刪除，不影響線上運作
 *  - 建議每季執行一次
 * ────────────────────────────────────────────────────────────────
 */

import { readFileSync } from "fs";
import { writeFileSync } from "fs";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "../gecko.db");

// ── CLI 參數 ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const LIMIT = (() => {
  const idx = args.indexOf("--limit");
  return idx >= 0 ? parseInt(args[idx + 1], 10) : 300;
})();
const OUTPUT_REPORT = args.includes("--report");

// ── 環境檢查 ────────────────────────────────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("❌ 需要 ANTHROPIC_API_KEY 環境變數");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const db = new Database(DB_PATH, { readonly: true });

// ── 複製分類邏輯（與 backend/routes/api.js 保持同步）──────────
// 注意：此處為校準用副本，修改規則時請同步更新 api.js
function classifyDirectionRules(content = "") {
  const tl = content.toLowerCase();
  const BEAR_TERMS = [
    [3, ["爆倉","清算","暴跌","崩盤","崩潰","liquidat","crash","collapse","margin call","bank run"]],
    [2, [
      "加息","收緊","鷹派","hawkish","tightening","rate hike","支持收緊","警告通脹","警告通膨","通脹威脅","通膨威脅",
      "禁止","打壓","制裁","ban","crackdown","sanction","seizure",
      "關稅","貿易戰","tariff","trade war",
      "戰爭","衝突","升溫","war","conflict","missile","airstrike","escalat",
      "流出","拋售","outflow","大跌",
    ]],
    [1, [
      "下跌","下滑","走低","回落","失守","跌破","decline","fell","drop","slump","tumble",
      "風險","擔憂","警告","risk","concern","warning","bearish",
      "利空","悲觀","下行","壓力","halt","暫停","賣出","售出","減持",
    ]],
  ];
  const BULL_TERMS = [
    [3, ["etf approved","etf批准","戰略儲備","strategic reserve","創新高","all-time high","institutional buy","機構買入"]],
    [2, [
      "降息","寬鬆","鴿派","dovish","easing","rate cut","支持降息","降息預期","降息週期",
      "批准","approved","approval","流入","買入","增持","inflow","buying","accumulate",
      "注資","刺激","stimulus","pivot","bailout","救市",
      "暴漲","突破","rally","surge","breakout",
    ]],
    [1, ["利好","積極","樂觀","上漲","走強","回升","反彈","支撐","bullish","positive","optimist","recover","rebound","growth","增長","買超"]],
  ];

  let bearScore = 0, bullScore = 0;
  for (const [w, kws] of BEAR_TERMS) for (const kw of kws) if (tl.includes(kw)) bearScore += w;
  for (const [w, kws] of BULL_TERMS) for (const kw of kws) if (tl.includes(kw)) bullScore += w;

  const t = content;
  if (/(不|未|沒有)\s*(降息|寬鬆|鴿派|批准|流入|買入)/.test(t)) bullScore = Math.max(0, bullScore - 2);
  if (/(不|未|沒有)\s*(加息|收緊|禁止|制裁|升溫|戰爭)/.test(t)) bearScore = Math.max(0, bearScore - 2);
  if (/(no sign of|not |avoid |prevent )\s*(rate cut|easing|approved|inflow)/i.test(t)) bullScore = Math.max(0, bullScore - 2);
  if (/(no sign of|not |avoid |prevent )\s*(rate hike|war|sanction|ban)/i.test(t)) bearScore = Math.max(0, bearScore - 2);

  if (bearScore === 0 && bullScore === 0) return "neutral";
  if (bearScore > bullScore) return "bearish";
  if (bullScore > bearScore) return "bullish";
  return "ambiguous";
}

// ── LLM 分類（單批 20 筆，降低 API 呼叫次數）──────────────────
async function classifyBatch(items) {
  const prompt = `你是一個專業的金融市場情緒分析師。
請對以下每則新聞判斷對加密資產市場的方向影響。

規則：
- bullish：對加密市場有正面影響（利多），例如降息、ETF批准、機構買入、地緣緊張緩解
- bearish：對加密市場有負面影響（利空），例如加息、監管禁令、戰爭升溫、大規模清算
- ambiguous：同時包含正面與負面訊號，難以判斷
- neutral：與加密市場走勢無明確關係，或純粹是中性事實陳述

請輸出 JSON 陣列，格式：[{"id":"...","label":"bullish|bearish|ambiguous|neutral","reason":"一句話理由"}]
只輸出 JSON，不要其他文字。

新聞列表：
${items.map(it => `{"id":"${it.id}","content":${JSON.stringify(it.content)}}`).join("\n")}`;

  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",  // 用 Haiku 降低成本
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  try {
    const text = res.content[0].text.trim();
    const jsonStr = text.startsWith("[") ? text : text.slice(text.indexOf("["));
    return JSON.parse(jsonStr);
  } catch {
    console.warn("  ⚠️  JSON 解析失敗，跳過此批");
    return [];
  }
}

// ── 主程式 ────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔍 CryptoPulse direction_en 校準工具 v2.2`);
  console.log(`   資料庫：${DB_PATH}`);
  console.log(`   樣本數：${LIMIT} 筆\n`);

  // 抓取樣本
  const rows = db.prepare(
    `SELECT id, content FROM jin10_news ORDER BY saved_at DESC LIMIT ?`
  ).all(LIMIT);

  if (rows.length === 0) {
    console.error("❌ 資料庫無資料");
    process.exit(1);
  }

  // 規則型分類
  const ruleResults = rows.map(r => ({
    id: r.id,
    content: r.content,
    rule: classifyDirectionRules(r.content),
  }));

  // LLM 分類（分批，每批 20 筆）
  const BATCH_SIZE = 20;
  const llmMap = new Map();
  let done = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    process.stdout.write(`  LLM 分類中... ${done}/${rows.length}\r`);
    try {
      const results = await classifyBatch(batch);
      for (const r of results) llmMap.set(r.id, r);
    } catch (e) {
      console.warn(`  ⚠️  批次 ${i}-${i + BATCH_SIZE} 失敗：${e.message}`);
    }
    done += batch.length;
    // 避免 rate limit
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`  LLM 分類完成：${llmMap.size}/${rows.length} 筆\n`);

  // ── 統計 ─────────────────────────────────────────────────────
  const LABELS = ["bullish", "bearish", "neutral", "ambiguous"];
  const ruleDist = Object.fromEntries(LABELS.map(l => [l, 0]));
  const llmDist = Object.fromEntries(LABELS.map(l => [l, 0]));
  const agreements = { agree: 0, disagree: 0 };
  const confusion = {};  // rule → llm → count

  for (const item of ruleResults) {
    const rLabel = item.rule;
    const llmItem = llmMap.get(item.id);
    const lLabel = llmItem?.label ?? "unknown";

    ruleDist[rLabel] = (ruleDist[rLabel] ?? 0) + 1;
    if (LABELS.includes(lLabel)) llmDist[lLabel] = (llmDist[lLabel] ?? 0) + 1;

    if (lLabel !== "unknown") {
      if (!confusion[rLabel]) confusion[rLabel] = {};
      confusion[rLabel][lLabel] = (confusion[rLabel][lLabel] ?? 0) + 1;
      if (rLabel === lLabel) agreements.agree++;
      else agreements.disagree++;
    }
  }

  const total = rows.length;
  const compared = agreements.agree + agreements.disagree;
  const accuracy = compared > 0 ? ((agreements.agree / compared) * 100).toFixed(1) : "N/A";

  console.log("📊 規則型分佈（v2.2）：");
  for (const l of LABELS) {
    const pct = ((ruleDist[l] / total) * 100).toFixed(1);
    const bar = "█".repeat(Math.round(pct / 2));
    console.log(`  ${l.padEnd(10)} ${String(ruleDist[l]).padStart(4)} (${pct.padStart(5)}%)  ${bar}`);
  }

  console.log("\n📊 LLM pseudo-label 分佈：");
  for (const l of LABELS) {
    const pct = ((llmDist[l] / compared) * 100).toFixed(1);
    const bar = "█".repeat(Math.round(pct / 2));
    console.log(`  ${l.padEnd(10)} ${String(llmDist[l]).padStart(4)} (${pct.padStart(5)}%)  ${bar}`);
  }

  console.log(`\n✅ 一致率：${accuracy}%  (${agreements.agree}/${compared} 筆)`);

  // Confusion matrix
  console.log("\n📋 Confusion Matrix（規則 → LLM）：");
  console.log("  rule\\llm   " + LABELS.map(l => l.padEnd(10)).join(""));
  for (const rLabel of LABELS) {
    const row = LABELS.map(lLabel => String(confusion[rLabel]?.[lLabel] ?? 0).padEnd(10)).join("");
    console.log(`  ${rLabel.padEnd(10)} ${row}`);
  }

  // 建議
  console.log("\n💡 建議：");
  const bearishLLM = llmDist["bearish"] / compared;
  const bearishRule = ruleDist["bearish"] / total;
  const bullishLLM = llmDist["bullish"] / compared;
  const bullishRule = ruleDist["bullish"] / total;

  if (bearishLLM - bearishRule > 0.05)
    console.log(`  ⚠️  規則 bearish 比 LLM 低 ${((bearishLLM - bearishRule) * 100).toFixed(1)}pp → 考慮放寬 bearish 詞庫或降低權重門檻`);
  else if (bearishRule - bearishLLM > 0.05)
    console.log(`  ⚠️  規則 bearish 比 LLM 高 ${((bearishRule - bearishLLM) * 100).toFixed(1)}pp → 考慮提高 bearish 門檻或縮減詞庫`);
  else
    console.log(`  ✅ bearish 分佈與 LLM 接近（差距 < 5pp），詞庫校準良好`);

  if (bullishLLM - bullishRule > 0.05)
    console.log(`  ⚠️  規則 bullish 比 LLM 低 ${((bullishLLM - bullishRule) * 100).toFixed(1)}pp → 考慮放寬 bullish 詞庫`);
  else if (bullishRule - bullishLLM > 0.05)
    console.log(`  ⚠️  規則 bullish 比 LLM 高 ${((bullishRule - bullishLLM) * 100).toFixed(1)}pp → 考慮提高 bullish 門檻`);
  else
    console.log(`  ✅ bullish 分佈與 LLM 接近（差距 < 5pp），詞庫校準良好`);

  if (parseFloat(accuracy) < 70)
    console.log(`  ⚠️  整體一致率 ${accuracy}% 偏低，建議人工抽查 confusion matrix 中主要分歧項`);
  else
    console.log(`  ✅ 整體一致率 ${accuracy}%，規則型分類器與 LLM 判斷相近`);

  // 輸出 JSON 報告
  if (OUTPUT_REPORT) {
    const reportPath = path.join(__dirname, "../tmp/calibration-report.json");
    const report = {
      generated_at: new Date().toISOString(),
      sample_size: total,
      compared,
      accuracy: parseFloat(accuracy),
      rule_dist: ruleDist,
      llm_dist: llmDist,
      confusion,
      items: ruleResults.map(item => ({
        id: item.id,
        content: item.content.slice(0, 100),
        rule: item.rule,
        llm: llmMap.get(item.id)?.label ?? "unknown",
        llm_reason: llmMap.get(item.id)?.reason ?? "",
        agree: item.rule === (llmMap.get(item.id)?.label ?? ""),
      })),
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📄 JSON 報告已輸出至：${reportPath}`);
  }

  console.log();
}

main().catch(e => { console.error(e); process.exit(1); });
