/**
 * validation-runner.js — CryptoPulse 自驗證系統
 *
 * §5 實作：自動量化「我的訊號到底準不準？」
 *
 * 每日 02:00 UTC 執行（或手動執行）：
 *   1. 讀取 SQLite 歷史 (asset_comments, factor_snapshots, gate_conditions)
 *   2. 從 Binance 抓 BTC/ETH K 棒計算 forward return
 *   3. 計算各層驗證指標（Spearman ρ、hit_rate、regime_return 分佈）
 *   4. 結果寫入 validation_results 表
 *   5. 暴露於 GET /api/v2/comment/validation/summary
 *
 * 執行方式：
 *   node backend/scripts/validation-runner.js [--days=90]
 *   # 每日 cron（pm2）：0 2 * * * node /path/to/validation-runner.js
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const DB_PATH = path.join(__dirname, "..", "gecko.db");
const args    = process.argv.slice(2);
const DAYS    = parseInt(args.find(a => a.startsWith("--days="))?.split("=")[1] || "90");
const KRAKEN  = "https://api.kraken.com";

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

// ── 建立 validation_results 表 ────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS validation_results (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    computed_at  TEXT NOT NULL,
    window_days  INTEGER NOT NULL,
    type         TEXT NOT NULL,
    result_json  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_val_type_time ON validation_results(type, computed_at DESC);
`);

const insertResult = db.prepare(`
  INSERT INTO validation_results (computed_at, window_days, type, result_json)
  VALUES (?, ?, ?, ?)
`);

// ── Kraken K 棒工具（替換 Binance，GCP US IP 不封鎖）──────────────────────────

/**
 * 從 Kraken 抓 BTC/USD 日線（每次最多 720 筆，需多次分批）
 * Kraken OHLC: GET /0/public/OHLC?pair=XBTUSD&interval=1440&since=<unix_sec>
 * 回傳：[time, open, high, low, close, vwap, volume, count]
 */
async function fetchBtcCandles(intervalStr, limit) {
  // intervalStr ignored (always use 1d = 1440 min for Kraken)
  const sinceTs = Math.floor((Date.now() - (limit + 10) * 24 * 3_600_000) / 1000);
  const allCandles = [];
  let since = sinceTs;

  // Kraken 每次最多 720 筆，分批抓
  while (allCandles.length < limit + 5) {
    const url = `${KRAKEN}/0/public/OHLC?pair=XBTUSD&interval=1440&since=${since}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
    const json = await res.json();
    if (json.error?.length) throw new Error(`Kraken API error: ${json.error.join(", ")}`);

    const rows = json.result?.XXBTZUSD ?? json.result?.XBTUSD ?? [];
    if (!rows.length) break;

    for (const k of rows) {
      // k = [time(sec), open, high, low, close, vwap, volume, count]
      const openTimeSec = parseInt(k[0]);
      allCandles.push({
        openTime:  openTimeSec * 1000,
        closeTime: (openTimeSec + 86400) * 1000 - 1,
        close:     parseFloat(k[4])
      });
    }

    // Kraken last = next since（用 result.last 繼續翻頁）
    const nextSince = json.result?.last;
    if (!nextSince || nextSince <= since) break;
    since = nextSince;
    if (allCandles.length >= limit + 30) break;
    await new Promise(r => setTimeout(r, 300)); // rate limit
  }

  // 依 openTime 升序，去重，取最新 limit 筆
  return [...new Map(allCandles.map(c => [c.openTime, c])).values()]
    .sort((a, b) => a.openTime - b.openTime)
    .slice(-limit);
}

/**
 * 建立時間 → 收盤價 map（向前對齊最近一根 K）
 */
function buildPriceMap(candles) {
  const map = {};
  for (const c of candles) map[c.closeTime] = c.close;
  return candles; // 保留有序陣列方便插值
}

/**
 * 給一個 ISO timestamp，找最近一根日線收盤價
 */
function getCloseAt(candles, isoTs) {
  const tsMs = new Date(isoTs).getTime();
  // 找 openTime <= tsMs 的最後一根
  let best = null;
  for (const c of candles) {
    if (c.openTime <= tsMs) best = c;
    else break;
  }
  return best?.close ?? null;
}

/**
 * 計算從 ts 起算 N 天後的 BTC 報酬率
 */
function forwardReturn(candles, isoTs, days) {
  const priceNow = getCloseAt(candles, isoTs);
  if (priceNow === null) return null;
  const futureTs = new Date(isoTs).getTime() + days * 24 * 3_600_000;
  // 找最近一根在 futureTs 之後的收盤
  let futureBest = null;
  for (const c of candles) {
    if (c.openTime >= futureTs) { futureBest = c; break; }
  }
  if (!futureBest) return null;
  return (futureBest.close - priceNow) / priceNow;
}

// ── Spearman 相關係數 ─────────────────────────────────────────────────────────

function rankArray(arr) {
  const sorted = [...arr].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  for (let i = 0; i < sorted.length; i++) ranks[sorted[i].i] = i + 1;
  return ranks;
}

function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 5) return { rho: null, n: xs.length };
  const rx = rankArray(xs);
  const ry = rankArray(ys);
  const n  = xs.length;
  const dSq = rx.reduce((s, r, i) => s + (r - ry[i]) ** 2, 0);
  const rho  = 1 - (6 * dSq) / (n * (n * n - 1));
  return { rho: Number(rho.toFixed(4)), n };
}

// ── §5.1 Regime Label 驗證 ───────────────────────────────────────────────────

async function validateRegime(candles, computedAt) {
  const since = new Date(Date.now() - DAYS * 24 * 3_600_000).toISOString();

  let rows;
  try {
    rows = db.prepare(`
      SELECT computed_at, regime_label, regime_confidence
      FROM asset_comments
      WHERE asset_class = 'crypto' AND computed_at >= ?
      ORDER BY computed_at ASC
    `).all(since);
  } catch { rows = []; }

  if (rows.length < 10) {
    return { status: "INSUFFICIENT_DATA", note: `只有 ${rows.length} 筆，需 ≥10`, n: rows.length };
  }

  // 計算各 regime 的 t+7d forward return
  const byRegime = {};
  for (const row of rows) {
    const ret7d = forwardReturn(candles, row.computed_at, 7);
    if (ret7d === null) continue;
    const key = row.regime_label;
    if (!byRegime[key]) byRegime[key] = [];
    byRegime[key].push(ret7d);
  }

  const regimeStats = {};
  for (const [label, rets] of Object.entries(byRegime)) {
    const avg = rets.reduce((s, v) => s + v, 0) / rets.length;
    regimeStats[label] = {
      avg_return_7d:  Number((avg * 100).toFixed(2)),
      n:              rets.length,
      direction_ok:   label.includes("risk_on") ? avg > 0 : label.includes("risk_off") ? avg < 0 : true
    };
  }

  // 整體 Spearman（regime 數值化後）
  const regimeOrder = { risk_on: 2, risk_on_transition: 1, neutral_drift: 0, risk_off_transition: -1, risk_off: -2, leverage_flush: -3 };
  const pairs = rows
    .map(r => ({ score: regimeOrder[r.regime_label] ?? 0, ret: forwardReturn(candles, r.computed_at, 7) }))
    .filter(p => p.ret !== null);
  const { rho, n } = spearman(pairs.map(p => p.score), pairs.map(p => p.ret));

  const riskOnAvg  = regimeStats["risk_on"]?.avg_return_7d ?? null;
  const riskOffAvg = regimeStats["risk_off"]?.avg_return_7d ?? null;
  const separated  = riskOnAvg !== null && riskOffAvg !== null && riskOnAvg > riskOffAvg;
  const status     = (rho !== null && rho > 0.1 && separated) ? "PASSING" : "WEAK";

  return { status, spearman_rho: rho, n, regime_stats: regimeStats, separated };
}

// ── §5.2 Score 預測力驗證 ────────────────────────────────────────────────────

async function validateScores(candles, computedAt) {
  const since = new Date(Date.now() - DAYS * 24 * 3_600_000).toISOString();

  let rows;
  try {
    rows = db.prepare(`
      SELECT computed_at, score_short_term, score_mid_term, full_json
      FROM asset_comments
      WHERE asset_class = 'crypto' AND computed_at >= ?
      ORDER BY computed_at ASC
    `).all(since);
  } catch { rows = []; }

  if (rows.length < 10) {
    return { status: "INSUFFICIENT_DATA", n: rows.length };
  }

  const horizons = [
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
  }

  const passingCount = Object.values(results).filter(r => r.passing).length;
  const status = passingCount >= 2 ? "PASSING" : passingCount === 1 ? "PARTIAL" : "FAILING";

  return { status, horizons: results };
}

// ── §5.3 Factor 預測力排名 ───────────────────────────────────────────────────

async function validateFactors(candles, computedAt) {
  const since = new Date(Date.now() - DAYS * 24 * 3_600_000).toISOString();

  // 取得有歷史的 factor keys
  let keyRows;
  try {
    keyRows = db.prepare(`
      SELECT DISTINCT factor_key FROM factor_snapshots WHERE computed_at >= ? LIMIT 200
    `).all(since);
  } catch { return { status: "INSUFFICIENT_DATA" }; }

  if (keyRows.length === 0) return { status: "INSUFFICIENT_DATA" };

  const factorRanking = [];

  for (const { factor_key } of keyRows) {
    try {
      const snapshots = db.prepare(`
        SELECT computed_at, normalized_score FROM factor_snapshots
        WHERE factor_key = ? AND computed_at >= ?
        ORDER BY computed_at ASC
      `).all(factor_key, since);

      if (snapshots.length < 10) continue;

      const pairs = snapshots
        .map(s => ({ score: s.normalized_score, ret: forwardReturn(candles, s.computed_at, 1) }))
        .filter(p => p.ret !== null && p.score !== null);

      if (pairs.length < 8) continue;

      const { rho, n } = spearman(pairs.map(p => p.score), pairs.map(p => p.ret));
      factorRanking.push({
        factor_key,
        rho_24h:  rho,
        n,
        useful:   rho !== null && Math.abs(rho) > 0.12,
        direction: rho !== null && rho < -0.1 ? "inverse" : "normal"
      });
    } catch { continue; }
  }

  factorRanking.sort((a, b) => Math.abs(b.rho_24h ?? 0) - Math.abs(a.rho_24h ?? 0));

  const useful   = factorRanking.filter(f => f.useful).slice(0, 10);
  const useless  = factorRanking.filter(f => !f.useful).slice(0, 5);
  const inverse  = factorRanking.filter(f => f.direction === "inverse"); // all inverse for adjScore coverage

  const status = factorRanking.length >= 5 ? "COMPUTED" : "INSUFFICIENT_DATA";
  return { status, total_factors: factorRanking.length, top_useful: useful, top_useless: useless, inverse_factors: inverse };
}

// ── §5.4 Gate 條件驗證 ───────────────────────────────────────────────────────

async function validateGates(candles, computedAt) {
  const since = new Date(Date.now() - DAYS * 24 * 3_600_000).toISOString();

  let keyRows;
  try {
    keyRows = db.prepare(`
      SELECT DISTINCT gate_key FROM gate_conditions WHERE computed_at >= ? LIMIT 20
    `).all(since);
  } catch { return { status: "INSUFFICIENT_DATA" }; }

  const gateResults = {};

  for (const { gate_key } of keyRows) {
    try {
      const onRows = db.prepare(`
        SELECT computed_at FROM gate_conditions
        WHERE gate_key = ? AND gate_value = 1 AND computed_at >= ?
      `).all(gate_key, since);
      const offRows = db.prepare(`
        SELECT computed_at FROM gate_conditions
        WHERE gate_key = ? AND gate_value = 0 AND computed_at >= ?
      `).all(gate_key, since);

      if (onRows.length < 5 || offRows.length < 5) continue;

      const onVols  = onRows .map(r => Math.abs(forwardReturn(candles, r.computed_at, 1/6) ?? 0)); // 4h return abs
      const offVols = offRows.map(r => Math.abs(forwardReturn(candles, r.computed_at, 1/6) ?? 0));

      const avgOn  = onVols .reduce((s, v) => s + v, 0) / onVols.length;
      const avgOff = offVols.reduce((s, v) => s + v, 0) / offVols.length;
      const ratio  = avgOff > 0.0001 ? avgOn / avgOff : 1;

      gateResults[gate_key] = {
        triggered_n:     onRows.length,
        normal_n:        offRows.length,
        avg_vol_on:      Number((avgOn * 100).toFixed(3)),
        avg_vol_off:     Number((avgOff * 100).toFixed(3)),
        vol_ratio:       Number(ratio.toFixed(2)),
        effective:       ratio >= 1.5
      };
    } catch { continue; }
  }

  const effective   = Object.entries(gateResults).filter(([, v]) => v.effective).map(([k]) => k);
  const ineffective = Object.entries(gateResults).filter(([, v]) => !v.effective).map(([k]) => k);
  const status = effective.length > 0 ? "PASSING" : (Object.keys(gateResults).length > 0 ? "WEAK" : "INSUFFICIENT_DATA");

  return { status, gate_stats: gateResults, effective_gates: effective, ineffective_gates: ineffective };
}

// ── §5.6 News direction_en 驗證 ──────────────────────────────────────────────

async function validateNewsDirection(candles, computedAt) {
  const since = new Date(Date.now() - DAYS * 24 * 3_600_000).toISOString();

  let rows;
  try {
    rows = db.prepare(`
      SELECT published_at, direction_en FROM news
      WHERE published_at >= ? AND direction_en IN ('bullish','bearish')
      ORDER BY published_at ASC
    `).all(since);
  } catch {
    // 可能表名不同
    try {
      rows = db.prepare(`
        SELECT published_at, direction FROM jin10_news
        WHERE published_at >= ?
        ORDER BY published_at ASC
      `).all(since);
      rows = rows.map(r => ({ published_at: r.published_at, direction_en: r.direction === "做多" || r.direction === "偏多" ? "bullish" : r.direction === "做空" || r.direction === "偏空" ? "bearish" : "neutral" }));
    } catch { rows = []; }
  }

  const bullish = rows.filter(r => r.direction_en === "bullish");
  const bearish = rows.filter(r => r.direction_en === "bearish");

  function hitRate(items, expectedDir) {
    const pairs = items.map(r => ({
      ret: forwardReturn(candles, r.published_at, 1) // t+24h
    })).filter(p => p.ret !== null);
    if (pairs.length < 5) return null;
    const hits = pairs.filter(p => expectedDir === "bullish" ? p.ret > 0 : p.ret < 0).length;
    return { hit_rate: Number((hits / pairs.length).toFixed(4)), n: pairs.length };
  }

  const bullHit = hitRate(bullish, "bullish");
  const bearHit = hitRate(bearish, "bearish");
  const overallHit = (() => {
    const all = [...bullish.map(r => ({ ...r, expected: "bullish" })), ...bearish.map(r => ({ ...r, expected: "bearish" }))];
    const pairs = all.map(r => ({ ret: forwardReturn(candles, r.published_at, 1), expected: r.expected })).filter(p => p.ret !== null);
    if (pairs.length < 10) return null;
    const hits = pairs.filter(p => p.expected === "bullish" ? p.ret > 0 : p.ret < 0).length;
    return Number((hits / pairs.length).toFixed(4));
  })();

  const status = overallHit !== null && overallHit > 0.55 ? "PASSING"
    : overallHit !== null && overallHit > 0.45 ? "RANDOM"
    : "INSUFFICIENT_DATA";

  return {
    status,
    overall_hit_rate: overallHit,
    bullish_hit: bullHit,
    bearish_hit: bearHit,
    note: "bearish 反向 hit_rate < 0.5 建議用 contrarian 邏輯"
  };
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  const computedAt = new Date().toISOString();
  console.log(`[validation] Starting — days=${DAYS}, computed_at=${computedAt}`);

  // 取 BTC 日線（最近 DAYS + 60 天，給 forward return 留空間）
  console.log(`[validation] Fetching BTC daily candles...`);
  const candles = await fetchBtcCandles("1d", DAYS + 60);
  console.log(`[validation] Got ${candles.length} candles`);

  console.log(`[validation] Running regime validation...`);
  const regime = await validateRegime(candles, computedAt);

  console.log(`[validation] Running score validation...`);
  const scores = await validateScores(candles, computedAt);

  console.log(`[validation] Running factor validation...`);
  const factors = await validateFactors(candles, computedAt);

  console.log(`[validation] Running gate validation...`);
  const gates = await validateGates(candles, computedAt);

  console.log(`[validation] Running news direction validation...`);
  const newsDirection = await validateNewsDirection(candles, computedAt);

  // overall_verdict
  const statuses = [regime.status, scores.status, gates.status].filter(s => s && s !== "INSUFFICIENT_DATA");
  const passing  = statuses.filter(s => s === "PASSING").length;
  const overall  = passing >= 2 ? "PASSING" : passing === 1 ? "PARTIAL" : "NEEDS_IMPROVEMENT";

  const summary = {
    computed_at:      computedAt,
    data_window_days: DAYS,
    btc_candle_source: "kraken",
    regime,
    scores,
    factors,
    gates,
    news_direction:   newsDirection,
    overall_verdict:  overall,
    priority_actions: [
      ...(regime.status !== "PASSING"       ? ["regime：加強動量 factor 權重 + 修正 F&G contrarian"] : []),
      ...(scores.status !== "PASSING"       ? ["scores：multi-timeframe lookback delta 已啟用，繼續累積數據"] : []),
      ...(newsDirection.status !== "PASSING"? ["news_direction：bearish 反向，考慮加 contrarian 用法"] : []),
    ].slice(0, 3)
  };

  // 寫入 DB
  insertResult.run(computedAt, DAYS, "summary", JSON.stringify(summary));
  insertResult.run(computedAt, DAYS, "regime",  JSON.stringify(regime));
  insertResult.run(computedAt, DAYS, "scores",  JSON.stringify(scores));
  insertResult.run(computedAt, DAYS, "factors", JSON.stringify(factors));
  insertResult.run(computedAt, DAYS, "gates",   JSON.stringify(gates));
  insertResult.run(computedAt, DAYS, "news_direction", JSON.stringify(newsDirection));

  console.log(`\n[validation] === Summary ===`);
  console.log(`  regime:         ${regime.status}  (ρ=${regime.spearman_rho ?? "N/A"})`);
  console.log(`  scores:         ${scores.status}`);
  console.log(`  factors:        ${factors.status}  (${factors.total_factors ?? 0} evaluated)`);
  console.log(`  gates:          ${gates.status}`);
  console.log(`  news_direction: ${newsDirection.status}  (hit=${newsDirection.overall_hit_rate ?? "N/A"})`);
  console.log(`  overall_verdict: ${overall}`);
  console.log(`[validation] Done — results written to validation_results table`);
}

main().catch(err => {
  console.error("[validation] Fatal:", err.message);
  process.exit(1);
});
