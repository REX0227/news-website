/**
 * data-audit.mjs — 資料範圍稽核
 *
 * 確認各資料來源的歷史覆蓋範圍，以及開發期（≤2026-01-31）
 * 與測試期（≥2026-02-01）各自的有效資料量。
 *
 * 執行：node backend/scripts/data-audit.mjs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const DB_PATH    = path.join(__dirname, "..", "gecko.db");

const DEV_CUTOFF  = "2026-01-31T23:59:59Z";
const TEST_START  = "2026-02-01T00:00:00Z";

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

function fmt(v) { return v ?? "—"; }

function printSection(title) {
  console.log(`\n${"─".repeat(72)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(72));
}

// ── 1. jin10_news 各來源 ──────────────────────────────────────────────────────

printSection("1. jin10_news — 新聞來源覆蓋");

const newsStats = db.prepare(`
  SELECT
    source,
    MIN(published_at) AS earliest,
    MAX(published_at) AS latest,
    COUNT(*) AS total,
    SUM(CASE WHEN published_at <= ? THEN 1 ELSE 0 END) AS dev_count,
    SUM(CASE WHEN published_at >= ? THEN 1 ELSE 0 END) AS test_count
  FROM jin10_news
  GROUP BY source
  ORDER BY source
`).all(DEV_CUTOFF, TEST_START);

if (!newsStats.length) {
  console.log("  (無資料)");
} else {
  console.log(`  ${"來源".padEnd(10)} ${"最早".padEnd(22)} ${"最新".padEnd(22)} ${"總計".padStart(7)} ${"開發期".padStart(8)} ${"測試期".padStart(8)}`);
  for (const r of newsStats) {
    console.log(
      `  ${String(r.source).padEnd(10)} ${fmt(r.earliest).padEnd(22)} ${fmt(r.latest).padEnd(22)}` +
      ` ${String(r.total).padStart(7)} ${String(r.dev_count).padStart(8)} ${String(r.test_count).padStart(8)}`
    );
  }
}

// ── 2. asset_comments (regime + score) ───────────────────────────────────────

printSection("2. asset_comments — Regime 歷史");

const acStats = db.prepare(`
  SELECT
    asset_class,
    MIN(computed_at) AS earliest,
    MAX(computed_at) AS latest,
    COUNT(*) AS total,
    SUM(CASE WHEN computed_at <= ? THEN 1 ELSE 0 END) AS dev_count,
    SUM(CASE WHEN computed_at >= ? THEN 1 ELSE 0 END) AS test_count,
    SUM(CASE WHEN score_short_term IS NOT NULL THEN 1 ELSE 0 END) AS has_short,
    SUM(CASE WHEN score_mid_term IS NOT NULL THEN 1 ELSE 0 END) AS has_mid
  FROM asset_comments
  GROUP BY asset_class
`).all(DEV_CUTOFF, TEST_START);

if (!acStats.length) {
  console.log("  (無資料)");
} else {
  console.log(`  ${"asset_class".padEnd(12)} ${"最早".padEnd(22)} ${"最新".padEnd(22)} ${"總計".padStart(6)} ${"開發期".padStart(7)} ${"測試期".padStart(7)} ${"有short".padStart(8)} ${"有mid".padStart(7)}`);
  for (const r of acStats) {
    console.log(
      `  ${String(r.asset_class).padEnd(12)} ${fmt(r.earliest).padEnd(22)} ${fmt(r.latest).padEnd(22)}` +
      ` ${String(r.total).padStart(6)} ${String(r.dev_count).padStart(7)} ${String(r.test_count).padStart(7)}` +
      ` ${String(r.has_short).padStart(8)} ${String(r.has_mid).padStart(7)}`
    );
  }
}

// ── 3. factor_snapshots — 主要 factor 各別範圍 ────────────────────────────────

printSection("3. factor_snapshots — Factor 覆蓋（TOP 30 by 資料量）");

const fsStats = db.prepare(`
  SELECT
    factor_key,
    MIN(computed_at) AS earliest,
    MAX(computed_at) AS latest,
    COUNT(*) AS total,
    SUM(CASE WHEN computed_at <= ? THEN 1 ELSE 0 END) AS dev_count,
    SUM(CASE WHEN computed_at >= ? THEN 1 ELSE 0 END) AS test_count
  FROM factor_snapshots
  GROUP BY factor_key
  ORDER BY total DESC
  LIMIT 30
`).all(DEV_CUTOFF, TEST_START);

if (!fsStats.length) {
  console.log("  (無資料)");
} else {
  console.log(`  ${"factor_key".padEnd(48)} ${"最早".padEnd(12)} ${"總計".padStart(6)} ${"開發期".padStart(7)} ${"測試期".padStart(7)}`);
  for (const r of fsStats) {
    const earliest = r.earliest ? r.earliest.substring(0, 10) : "—";
    console.log(
      `  ${String(r.factor_key).substring(0, 47).padEnd(48)} ${earliest.padEnd(12)}` +
      ` ${String(r.total).padStart(6)} ${String(r.dev_count).padStart(7)} ${String(r.test_count).padStart(7)}`
    );
  }
}

// ── 4. regime_transitions — 事件研究基礎 ─────────────────────────────────────

printSection("4. regime_transitions — 事件研究資料");

let rtStats = null;
try {
  rtStats = db.prepare(`
    SELECT
      from_regime || ' → ' || to_regime AS transition,
      COUNT(*) AS cnt,
      MIN(timestamp) AS earliest,
      MAX(timestamp) AS latest
    FROM regime_transitions
    GROUP BY from_regime, to_regime
    ORDER BY cnt DESC
  `).all();
} catch {
  // table may not exist yet
}

if (!rtStats?.length) {
  console.log("  (無資料 — regime_transitions 表尚無記錄)");
} else {
  console.log(`  ${"transition".padEnd(40)} ${"次數".padStart(6)} ${"最早".padEnd(22)} ${"最新"}`);
  for (const r of rtStats) {
    console.log(`  ${String(r.transition).padEnd(40)} ${String(r.cnt).padStart(6)} ${fmt(r.earliest).padEnd(22)} ${fmt(r.latest)}`);
  }
}

// ── 5. funding_rate & liquidation_raw ────────────────────────────────────────

printSection("5. funding_rate & liquidation_raw — 衍生品資料");

const frStats = db.prepare(`
  SELECT
    MIN(funding_time) AS earliest,
    MAX(funding_time) AS latest,
    COUNT(DISTINCT symbol) AS symbols,
    COUNT(*) AS total
  FROM funding_rate
`).get();

console.log("  funding_rate:");
console.log(`    最早=${fmt(frStats?.earliest)}  最新=${fmt(frStats?.latest)}  symbols=${frStats?.symbols ?? 0}  總計=${frStats?.total ?? 0}`);

const liqStats = db.prepare(`
  SELECT
    MIN(liquidated_at) AS earliest,
    MAX(liquidated_at) AS latest,
    COUNT(DISTINCT symbol) AS symbols,
    COUNT(*) AS total
  FROM liquidation_raw
`).get();

console.log("  liquidation_raw:");
console.log(`    最早=${fmt(liqStats?.earliest)}  最新=${fmt(liqStats?.latest)}  symbols=${liqStats?.symbols ?? 0}  總計=${liqStats?.total ?? 0}`);

// ── 6. 回測可行性評估 ─────────────────────────────────────────────────────────

printSection("6. 回測可行性評估");

const cryptoAc = acStats.find(r => r.asset_class === "crypto");

if (!cryptoAc) {
  console.log("  ❌ asset_comments 中無 crypto 資料，回測引擎無法執行");
} else {
  const shortDev  = cryptoAc.has_short;
  const midDev    = cryptoAc.has_mid;
  const totalDev  = cryptoAc.dev_count;
  const totalTest = cryptoAc.test_count;

  console.log(`  開發期（≤2026-01-31）資料筆數：${totalDev}`);
  console.log(`  測試期（≥2026-02-01）資料筆數：${totalTest}`);
  console.log(`  有 score_short_term 欄位：${shortDev} 筆`);
  console.log(`  有 score_mid_term   欄位：${midDev} 筆`);
  console.log("");

  if (totalDev < 30) {
    console.log("  ⚠️  開發期資料偏少（< 30 筆），短期 Quintile / IC 結果可能不可靠");
    console.log("     建議先執行 regime-heartbeat.js 積累更多 asset_comments");
  } else if (totalDev < 60) {
    console.log("  ⚠️  開發期資料尚可（30-60 筆），中長期指標較可靠，短期需謹慎解讀");
  } else {
    console.log("  ✅ 開發期資料充足（≥60 筆），可執行完整回測");
  }

  if (totalTest < 20) {
    console.log("  ⚠️  測試期資料偏少（< 20 筆），測試期驗證結果僅供參考");
  } else {
    console.log("  ✅ 測試期資料可供 forward validation");
  }
}

console.log(`\n${"─".repeat(72)}`);
console.log("  完成。請確認上述資料符合預期後再執行 backtest-engine.mjs");
console.log("─".repeat(72));
