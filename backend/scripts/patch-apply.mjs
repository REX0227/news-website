/**
 * patch-apply.mjs — 一鍵套用所有 validation + score 修正
 * 執行方式（在 VM 的 ~/news-website 目錄）：
 *   node backend/scripts/patch-apply.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const BASE = path.join(process.env.HOME || "/home/king86248", "news-website");

function patch(relPath, oldStr, newStr, desc) {
  const fp = path.join(BASE, relPath);
  let content = fs.readFileSync(fp, "utf8");
  if (!content.includes(oldStr)) {
    console.log(`  [SKIP] ${desc} — 已套用或字串不符`);
    return;
  }
  fs.writeFileSync(fp, content.replace(oldStr, newStr), "utf8");
  console.log(`  [OK]   ${desc}`);
}

console.log("\n=== Patch 1: validation-runner.js ===");

// Fix A: use score_mid_term for mid_term_7d
patch(
  "backend/scripts/validation-runner.js",
  `  const horizons = [
    { label: "intraday_4h",  days: 4/24 },
    { label: "short_term_3d", days: 3 },
    { label: "mid_term_7d",  days: 7 }
  ];

  const results = {};
  for (const h of horizons) {
    const shortPairs = rows
      .filter(r => r.score_short_term !== null)
      .map(r => ({ score: r.score_short_term, ret: forwardReturn(candles, r.computed_at, h.days) }))
      .filter(p => p.ret !== null);
    const { rho, n } = spearman(shortPairs.map(p => p.score), shortPairs.map(p => p.ret));
    results[h.label] = { rho, n, passing: rho !== null && rho > 0.15 };
  }`,
  `  const horizons = [
    { label: "intraday_4h",   days: 4/24, scoreCol: "score_short_term" },
    { label: "short_term_3d", days: 3,    scoreCol: "score_short_term" },
    { label: "mid_term_7d",   days: 7,    scoreCol: "score_mid_term"   }
  ];

  const results = {};
  for (const h of horizons) {
    const pairs = rows
      .filter(r => r[h.scoreCol] !== null)
      .map(r => ({ score: r[h.scoreCol], ret: forwardReturn(candles, r.computed_at, h.days) }))
      .filter(p => p.ret !== null);
    const { rho, n } = spearman(pairs.map(p => p.score), pairs.map(p => p.ret));
    results[h.label] = { rho, n, passing: rho !== null && rho > 0.15 };
  }`,
  "validateScores: use score_mid_term for mid_term_7d"
);

// Fix B: raise factor scan limit
patch(
  "backend/scripts/validation-runner.js",
  "SELECT DISTINCT factor_key FROM factor_snapshots WHERE computed_at >= ? LIMIT 60",
  "SELECT DISTINCT factor_key FROM factor_snapshots WHERE computed_at >= ? LIMIT 200",
  "factor scan LIMIT 60→200"
);

// Fix C: save all inverse factors (not just top 5)
patch(
  "backend/scripts/validation-runner.js",
  "  const inverse  = factorRanking.filter(f => f.direction === \"inverse\").slice(0, 5);",
  "  const inverse  = factorRanking.filter(f => f.direction === \"inverse\"); // all inverse for adjScore coverage",
  "inverse_factors: remove slice(0,5)"
);

console.log("\n=== Patch 2: comment.js ===");

// Fix D: fundingScore/oiScore fallback to per-symbol CoinGlass keys
patch(
  "backend/routes/comment.js",
  `  // 衍生品結構
  const oiScore      = adjScore(safeScore(factors, "derivatives.btc_open_interest"), "derivatives.btc_open_interest", inv);
  const fundingScore = adjScore(safeScore(factors, "derivatives.btc_funding_rate"),   "derivatives.btc_funding_rate",  inv);
  const etfScore     = adjScore(safeScore(factors, "flows.etf_net_flow_7d"),          "flows.etf_net_flow_7d",         inv);`,
  `  // 衍生品結構（fallback: 集合 key → 單幣 BTC key，歷史回灌資料用後者）
  const oiScore = (() => {
    const agg = safeScore(factors, "derivatives.btc_open_interest");
    if (agg !== null) return adjScore(agg, "derivatives.btc_open_interest", inv);
    return adjScore(safeScore(factors, "crypto.derivatives.BTC.open_interest"), "crypto.derivatives.BTC.open_interest", inv);
  })();
  const fundingScore = (() => {
    const agg = safeScore(factors, "derivatives.btc_funding_rate");
    if (agg !== null) return adjScore(agg, "derivatives.btc_funding_rate", inv);
    return adjScore(safeScore(factors, "crypto.derivatives.BTC.funding_rate_zscore"), "crypto.derivatives.BTC.funding_rate_zscore", inv);
  })();
  const etfScore     = adjScore(safeScore(factors, "flows.etf_net_flow_7d"),          "flows.etf_net_flow_7d",         inv);`,
  "fundingScore/oiScore: add per-symbol fallback"
);

// Fix E: short_term weights
patch(
  "backend/routes/comment.js",
  `    const raw = weightedAvg([
      { v: return7d,   w: 3.0 },
      { v: cryptoBias, w: 2.0 },
      { v: stabChange, w: 1.5 },
      { v: fundingScore, w: 1.0 },
      { v: oiScore,    w: 1.0 },
      { v: fgAdj,      w: 1.5 },
      { v: etfScore,   w: 1.0 }
    ]);`,
  `    const raw = weightedAvg([
      { v: return7d,     w: 1.0 },   // 3.0→1.0：落後動量，防 7d 均值回歸負 ρ
      { v: cryptoBias,   w: 2.0 },
      { v: stabChange,   w: 2.0 },   // 1.5→2.0：領先流量訊號
      { v: fundingScore, w: 2.5 },   // 1.0→2.5：驗證最強領先指標
      { v: oiScore,      w: 1.5 },   // 1.0→1.5
      { v: fgAdj,        w: 2.0 },   // 1.5→2.0：反指 contrarian
      { v: etfScore,     w: 1.5 }    // 1.0→1.5：機構資金流
    ]);`,
  "short_term: reduce return7d weight, boost leading indicators"
);

// Fix F: mid_term weights + add fundingScore/etfScore
patch(
  "backend/routes/comment.js",
  `    const raw = weightedAvg([
      { v: maPos,      w: 3.0 },
      { v: return30d,  w: 2.0 },
      { v: stabMcap,   w: 1.5 },
      { v: tvlScore,   w: 1.0 },
      { v: regScore,   w: 1.0 },
      { v: pcRatio,    w: 0.5 }
    ]);`,
  `    const raw = weightedAvg([
      { v: maPos,        w: 2.0 },   // 3.0→2.0：落後，降低主導性
      { v: return30d,    w: 1.0 },   // 2.0→1.0：趨勢背景參考
      { v: stabMcap,     w: 1.5 },
      { v: tvlScore,     w: 1.0 },
      { v: regScore,     w: 1.0 },
      { v: fundingScore, w: 2.0 },   // NEW：中期衍生品領先信號
      { v: etfScore,     w: 1.5 },   // NEW：機構資金（中期結構代理）
      { v: pcRatio,      w: 0.5 }
    ]);`,
  "mid_term: add fundingScore/etfScore, reduce maPos/return30d"
);

console.log("\n=== Patch 3: backfill-coinglass-derivatives.mjs ===");

// Fix G: OI endpoint
patch(
  "backend/scripts/backfill-coinglass-derivatives.mjs",
  `      const data = await cgFetch("/api/futures/openInterest/ohlc-history", {
        symbol: cgSym, exchange: "Binance",
        interval: "1d", startTime: cursor, endTime: batchEnd, limit: 200
      });
      const rows = Array.isArray(data) ? data : (data?.list ?? []);
      const fromStr = new Date(cursor).toISOString().slice(0, 10);
      const toStr   = new Date(batchEnd).toISOString().slice(0, 10);
      console.log(\`  [OI][\${sym}] \${fromStr}→\${toStr}: \${rows.length} rows\`);

      if (!DRY_RUN) {
        for (const row of rows) {
          const ts    = row.t ?? row.time ?? row.createTime;
          const oi    = parseFloat(row.c ?? row.close ?? row.o ?? NaN);
          const prev  = parseFloat(row.o ?? row.open ?? NaN);`,
  `      const data = await cgFetch("/api/futures/open-interest/aggregated-history", {
        symbol: sym, exchange_list: "Binance,Bybit",
        interval: "1d", startTime: cursor, endTime: batchEnd, limit: 200
      });
      const rows = Array.isArray(data) ? data : (data?.list ?? []);
      const fromStr = new Date(cursor).toISOString().slice(0, 10);
      const toStr   = new Date(batchEnd).toISOString().slice(0, 10);
      console.log(\`  [OI][\${sym}] \${fromStr}→\${toStr}: \${rows.length} rows\`);

      if (!DRY_RUN) {
        for (const row of rows) {
          const ts    = row.time ?? row.t ?? row.createTime;
          const oi    = parseFloat(row.close ?? row.closeUsd ?? row.openInterest ?? row.value ?? row.c ?? NaN);
          const prev  = parseFloat(row.open ?? row.openUsd ?? row.o ?? NaN);`,
  "OI: fix endpoint /open-interest/aggregated-history + field names"
);

// Fix H: LSR timestamp + longPct field
patch(
  "backend/scripts/backfill-coinglass-derivatives.mjs",
  `      if (!DRY_RUN) {
        for (const row of rows) {
          const ts       = row.t ?? row.time ?? row.createTime;
          const longPct  = parseFloat(row.longAccount ?? row.l ?? NaN);`,
  `      if (!DRY_RUN) {
        for (const row of rows) {
          const ts       = row.time ?? row.t ?? row.createTime;
          const longPct  = parseFloat(row.global_account_long_percent ?? row.longAccount ?? row.longRatio ?? row.long ?? NaN);`,
  "LSR: fix timestamp field + longPct field priority"
);

// Fix I: LIQ timestamp + liquidation fields
patch(
  "backend/scripts/backfill-coinglass-derivatives.mjs",
  `        for (const row of rows) {
          const ts  = row.t ?? row.time ?? row.createTime;
          const liq = parseFloat(row.longLiquidationUsd ?? row.c ?? NaN)
                    + parseFloat(row.shortLiquidationUsd ?? 0);
          if (!ts || !Number.isFinite(liq)) continue;`,
  `        for (const row of rows) {
          const ts  = row.time ?? row.t ?? row.createTime;
          const longLiqRaw  = row.longLiquidationUsd  ?? row.long_liquidation_usd  ?? row.buyLiqUsd  ?? row.longUsd  ?? null;
          const shortLiqRaw = row.shortLiquidationUsd ?? row.short_liquidation_usd ?? row.sellLiqUsd ?? row.shortUsd ?? null;
          if (!ts || (longLiqRaw === null && shortLiqRaw === null)) continue;
          const liq = parseFloat(longLiqRaw ?? 0) + parseFloat(shortLiqRaw ?? 0);
          if (!Number.isFinite(liq)) continue;`,
  "LIQ: fix timestamp + liquidation field names (skip when all null)"
);

// Fix J: ETF endpoint + timestamp/value fields
patch(
  "backend/scripts/backfill-coinglass-derivatives.mjs",
  `      const data = await cgFetch("/api/etf/bitcoin-etf/netflow/chart", {
        startTime: cursor, endTime: batchEnd
      });
      const rows = Array.isArray(data) ? data : (data?.list ?? data?.data ?? []);
      console.log(\`  [ETF] \${new Date(cursor).toISOString().slice(0,10)}: \${rows.length} rows\`);

      if (!DRY_RUN) {
        // Need to aggregate into 7-day windows
        const dayBuckets = {};
        for (const row of rows) {
          const ts  = row.t ?? row.date ?? row.time;
          const net = parseFloat(row.netFlow ?? row.net ?? row.n ?? NaN);`,
  `      const data = await cgFetch("/api/etf/bitcoin-etf/net-flow/chart", {
        startTime: cursor, endTime: batchEnd
      });
      const rows = Array.isArray(data) ? data : (data?.list ?? data?.data ?? []);
      console.log(\`  [ETF] \${new Date(cursor).toISOString().slice(0,10)}: \${rows.length} rows\`);

      if (!DRY_RUN) {
        // Need to aggregate into 7-day windows
        const dayBuckets = {};
        for (const row of rows) {
          const ts  = row.time ?? row.t ?? row.date;
          const net = parseFloat(row.netFlow ?? row.net_flow ?? row.net ?? row.n ?? NaN);`,
  "ETF: fix endpoint /net-flow/chart + field names"
);

console.log("\n=== Restarting PM2 ===");
try {
  execSync("pm2 restart cryptopulse", { stdio: "inherit" });
  console.log("  [OK] PM2 restarted");
} catch (e) {
  console.log("  [WARN] PM2 restart failed:", e.message);
}

console.log("\n=== Done! Next steps ===");
console.log("1. node backend/scripts/backfill-coinglass-derivatives.mjs --dry-run");
console.log("2. node backend/scripts/backfill-coinglass-derivatives.mjs");
console.log("3. node backend/scripts/backfill-asset-comments.mjs");
console.log("4. node backend/scripts/validation-runner.js --days=90");
