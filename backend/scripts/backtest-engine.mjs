/**
 * backtest-engine.mjs — CryptoPulse 回測引擎 v2.0
 *
 * 實作新版架構方法 B/C/D/E/F + BTC 基準：
 *   ★  BTC Buy & Hold 基準（對照組）
 *   B. 虛擬倉位 P&L → Sharpe / MaxDD / WinRate / ProfitFactor / quality_score（含 MAE）
 *   C. Quintile 分析（分位數 vs. forward return 單調性）
 *   D. 滾動 IC / ICIR（30 天視窗，開發期/測試期分開計算）
 *   E. 事件研究（regime 切換後 1h/4h/24h/7d 報酬分佈）
 *   F. Monte Carlo 顯著性檢驗（1000 次打亂 regime → p-value）
 *
 * 開發期：asset_comments.computed_at ≤ 2026-01-31（門檻校準期，不動）
 * 測試期：asset_comments.computed_at ≥ 2026-02-01（forward validation）
 *
 * 執行：
 *   node backend/scripts/backtest-engine.mjs
 *   node backend/scripts/backtest-engine.mjs --threshold=0.15
 *   node backend/scripts/backtest-engine.mjs --period=dev|test|all
 *   node backend/scripts/backtest-engine.mjs --timeframe=short_term|mid_term|long_term
 *   node backend/scripts/backtest-engine.mjs --skip-event-study
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { randomInt } from "node:crypto";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const DB_PATH = path.join(__dirname, "..", "gecko.db");
const KRAKEN  = "https://api.kraken.com";

// ── CLI 引數 ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const ARG_PERIOD    = args.find(a => a.startsWith("--period="))?.split("=")[1] ?? "all";
const ARG_TIMEFRAME = args.find(a => a.startsWith("--timeframe="))?.split("=")[1] ?? "all";
const SKIP_EVENT    = args.includes("--skip-event-study");
const MONTE_TRIALS  = 1000;

// dev/test 分界（固定，不隨 threshold 變動）
const DEV_CUTOFF = "2026-01-31T23:59:59Z";
const TEST_START = "2026-02-01T00:00:00Z";

// 持倉天數（由 timeframe 決定）
const HOLD_DAYS = { short_term: 3, mid_term: 7, long_term: 14 };

// ★ 優先 1：進場門檻可由 CLI 傳入（預設 0.3，建議嘗試 0.15）
const ENTRY_THRESHOLD = parseFloat(
  args.find(a => a.startsWith("--threshold="))?.split("=")[1] ?? "0.3"
);

// MAE 標準化係數（5% 以上 MAE 扣滿 1.0 quality）
const MAE_NORM = 0.05;

// ── DB ────────────────────────────────────────────────────────────────────────

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

// 確保三張回測表存在（獨立腳本不經 server initializeDatabase）
db.exec(`
  CREATE TABLE IF NOT EXISTS backtest_results (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         TEXT NOT NULL,
    period         TEXT NOT NULL,
    timeframe      TEXT NOT NULL,
    entry_at       TEXT NOT NULL,
    score          REAL,
    direction      TEXT NOT NULL,
    entry_price    REAL,
    exit_price     REAL,
    period_min     REAL,
    period_max     REAL,
    forward_return REAL,
    pnl            REAL,
    mae            REAL,
    quality_score  REAL,
    method         TEXT DEFAULT 'score',
    computed_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bt_timeframe ON backtest_results(timeframe, period, entry_at);

  CREATE TABLE IF NOT EXISTS event_study_results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    computed_at TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    event_at    TEXT NOT NULL,
    entry_price REAL,
    return_1h   REAL,
    return_4h   REAL,
    return_24h  REAL,
    return_7d   REAL
  );
  CREATE INDEX IF NOT EXISTS idx_event_type ON event_study_results(event_type, event_at);

  CREATE TABLE IF NOT EXISTS enhanced_validation (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    computed_at TEXT NOT NULL,
    window_days INTEGER,
    type        TEXT NOT NULL,
    timeframe   TEXT,
    result_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ev_type_time ON enhanced_validation(type, computed_at DESC);
`);

const run_id    = `bt_${Date.now()}`;
const computedAt = new Date().toISOString();

const insertBt = db.prepare(`
  INSERT INTO backtest_results
    (run_id, period, timeframe, entry_at, score, direction,
     entry_price, exit_price, period_min, period_max,
     forward_return, pnl, mae, quality_score, method, computed_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const insertEvent = db.prepare(`
  INSERT INTO event_study_results
    (computed_at, event_type, event_at, entry_price, return_1h, return_4h, return_24h, return_7d)
  VALUES (?,?,?,?,?,?,?,?)
`);

const insertEV = db.prepare(`
  INSERT INTO enhanced_validation (computed_at, window_days, type, timeframe, result_json)
  VALUES (?,?,?,?,?)
`);

// ── Kraken 工具 ───────────────────────────────────────────────────────────────

async function fetchKrakenOHLC(intervalMin, daysBack) {
  const sinceTs   = Math.floor((Date.now() - (daysBack + 10) * 24 * 3_600_000) / 1000);
  const allCandles = [];
  let since = sinceTs;

  while (true) {
    const url = `${KRAKEN}/0/public/OHLC?pair=XBTUSD&interval=${intervalMin}&since=${since}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
    const json = await res.json();
    if (json.error?.length) throw new Error(`Kraken: ${json.error.join(", ")}`);

    const rows = json.result?.XXBTZUSD ?? json.result?.XBTUSD ?? [];
    if (!rows.length) break;

    for (const k of rows) {
      allCandles.push({
        openTime: parseInt(k[0]) * 1000,
        open:  parseFloat(k[1]),
        high:  parseFloat(k[2]),
        low:   parseFloat(k[3]),
        close: parseFloat(k[4])
      });
    }

    const nextSince = json.result?.last;
    if (!nextSince || nextSince <= since) break;
    since = nextSince;
    // 日線 720 筆已足夠，小時線可能需要更多次
    if (intervalMin === 1440 && allCandles.length >= daysBack + 30) break;
    await new Promise(r => setTimeout(r, 350));
  }

  return [...new Map(allCandles.map(c => [c.openTime, c])).values()]
    .sort((a, b) => a.openTime - b.openTime);
}

/** 找 isoTs 之前最近一根 K 棒的收盤價 */
function getCloseAt(candles, isoTs) {
  const tsMs = new Date(isoTs).getTime();
  let best = null;
  for (const c of candles) {
    if (c.openTime <= tsMs) best = c;
    else break;
  }
  return best?.close ?? null;
}

/** 找 isoTs 之後最近一根 K 棒的收盤價 */
function getCloseAfter(candles, isoTs) {
  const tsMs = new Date(isoTs).getTime();
  for (const c of candles) {
    if (c.openTime >= tsMs) return c.close;
  }
  return null;
}

/**
 * 計算 entry → N 天後的：forward_return, period_min, period_max
 * 用日線蠟燭（intervalMin=1440）
 */
function calcPeriodStats(candles, isoTs, holdDays) {
  const entryPrice = getCloseAt(candles, isoTs);
  if (entryPrice === null) return null;

  const entryMs  = new Date(isoTs).getTime();
  const exitMs   = entryMs + holdDays * 24 * 3_600_000;

  // 找 exitMs 之後的第一根 K 作為平倉
  let exitPrice = null;
  for (const c of candles) {
    if (c.openTime >= exitMs) { exitPrice = c.close; break; }
  }
  if (exitPrice === null) return null;

  // 期間最高最低（持倉 K 棒的 high/low）
  let pMin = Infinity, pMax = -Infinity;
  for (const c of candles) {
    if (c.openTime >= entryMs && c.openTime <= exitMs) {
      if (c.low  < pMin) pMin = c.low;
      if (c.high > pMax) pMax = c.high;
    }
  }
  if (pMin === Infinity) { pMin = Math.min(entryPrice, exitPrice); }
  if (pMax === -Infinity) { pMax = Math.max(entryPrice, exitPrice); }

  return { entryPrice, exitPrice, pMin, pMax, forward_return: (exitPrice - entryPrice) / entryPrice };
}

// ── Spearman 相關係數 ─────────────────────────────────────────────────────────

function rankArray(arr) {
  const sorted = [...arr].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  for (let i = 0; i < sorted.length; i++) ranks[sorted[i].i] = i + 1;
  return ranks;
}

function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 5) return null;
  const rx = rankArray(xs), ry = rankArray(ys);
  const n  = xs.length;
  const dSq = rx.reduce((s, r, i) => s + (r - ry[i]) ** 2, 0);
  return 1 - (6 * dSq) / (n * (n * n - 1));
}

// ── Daily Dedup ───────────────────────────────────────────────────────────────
// 每個 UTC 日只保留最後一筆，解決測試期（即時收集，~66筆/天）
// 與開發期（回填，~1筆/天）解析度不一致的問題。
// 輸入 rows 必須已按 computed_at ASC 排序。

function dedupDaily(rows) {
  const byDay = new Map();
  for (const r of rows) {
    const day = r.computed_at.substring(0, 10); // YYYY-MM-DD
    byDay.set(day, r); // 同日後覆蓋前，最終保留最新一筆
  }
  return [...byDay.values()].sort((a, b) => a.computed_at.localeCompare(b.computed_at));
}

// ── 優先 4：動態資料可用性偵測 ────────────────────────────────────────────────
// 因 score_mid_term 比 score_short_term 晚加入系統，
// 需動態確認每個時框「實際上第一筆有效分數」在哪天。

function detectScoreAvailability(scoreCol) {
  try {
    const r = db.prepare(`
      SELECT
        MIN(computed_at)   AS earliest,
        MAX(computed_at)   AS latest,
        COUNT(*)           AS total,
        SUM(CASE WHEN computed_at <= ? THEN 1 ELSE 0 END) AS dev_rows,
        SUM(CASE WHEN computed_at >= ? THEN 1 ELSE 0 END) AS test_rows,
        SUM(CASE WHEN ABS(${scoreCol}) > ?
                  AND computed_at <= ? THEN 1 ELSE 0 END) AS dev_above_thresh,
        SUM(CASE WHEN ABS(${scoreCol}) > ?
                  AND computed_at >= ? THEN 1 ELSE 0 END) AS test_above_thresh
      FROM asset_comments
      WHERE asset_class = 'crypto' AND ${scoreCol} IS NOT NULL
    `).get(DEV_CUTOFF, TEST_START, ENTRY_THRESHOLD, DEV_CUTOFF, ENTRY_THRESHOLD, TEST_START);
    return r;
  } catch { return null; }
}

// ── 優先 5：BTC Buy & Hold 基準 ───────────────────────────────────────────────

async function runBtcBenchmark(dayCandles) {
  console.log("\n[★] BTC Buy & Hold 基準（對照組）...");

  // 找最早有 crypto asset_comment 的日期作為比較起點
  const firstComment = db.prepare(`
    SELECT MIN(computed_at) AS earliest FROM asset_comments WHERE asset_class='crypto'
  `).get();
  const dataStart = firstComment?.earliest ?? "2021-01-01T00:00:00Z";

  const segments = [
    { label: "開發期", from: dataStart, to: DEV_CUTOFF },
    { label: "測試期", from: TEST_START, to: new Date().toISOString() },
    { label: "全期",   from: dataStart,  to: new Date().toISOString() }
  ];

  for (const seg of segments) {
    const p0 = getCloseAt(dayCandles, seg.from);
    const p1 = getCloseAt(dayCandles, seg.to);
    if (!p0 || !p1) { console.log(`  ${seg.label}: 缺價格資料`); continue; }

    const totalReturn = (p1 - p0) / p0;
    const days = (new Date(seg.to) - new Date(seg.from)) / 86_400_000;
    const annReturn = Math.pow(1 + totalReturn, 365 / days) - 1;

    // 計算持倉期間每日報酬（用於 Sharpe）
    const segCandles = dayCandles.filter(c =>
      c.openTime >= new Date(seg.from).getTime() &&
      c.openTime <= new Date(seg.to).getTime()
    );
    const dailyReturns = [];
    for (let i = 1; i < segCandles.length; i++) {
      dailyReturns.push((segCandles[i].close - segCandles[i-1].close) / segCandles[i-1].close);
    }
    const m = mean(dailyReturns) ?? 0;
    const s = std(dailyReturns) ?? 1e-9;
    const sharpe = (m / s) * Math.sqrt(365);

    console.log(
      `  ${seg.label}（${seg.from.substring(0,10)} → ${seg.to.substring(0,10)}）` +
      `  BTC: ${(totalReturn*100).toFixed(1)}%  年化: ${(annReturn*100).toFixed(1)}%  Sharpe: ${sharpe.toFixed(3)}`
    );
  }
}

// ── 統計輔助 ──────────────────────────────────────────────────────────────────

function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null; }
function std(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ── 方法 B — 虛擬倉位 P&L ────────────────────────────────────────────────────

async function runMethodB(dayCandles, periodFilter, timeframes) {
  console.log("\n[B] 虛擬倉位 P&L 回測...");

  for (const tf of timeframes) {
    const holdDays = HOLD_DAYS[tf];
    const scoreCol = tf === "long_term" ? "score_mid_term" : `score_${tf}`;

    // 讀取 asset_comments
    let periodWhere = "";
    if (periodFilter === "dev")  periodWhere = `AND computed_at <= '${DEV_CUTOFF}'`;
    if (periodFilter === "test") periodWhere = `AND computed_at >= '${TEST_START}'`;

    const rawRows = db.prepare(`
      SELECT computed_at, ${scoreCol} AS score, regime_label
      FROM asset_comments
      WHERE asset_class = 'crypto' AND ${scoreCol} IS NOT NULL
      ${periodWhere}
      ORDER BY computed_at ASC
    `).all();
    const rows = dedupDaily(rawRows); // 每日只取最後一筆，避免即時收集造成 autocorrelation

    if (rows.length < 5) {
      console.log(`  [${tf}] 資料不足（${rows.length} 筆），跳過`);
      continue;
    }
    console.log(`  [${tf}] dedup 後：${rawRows.length} → ${rows.length} 筆（日頻）`);

    const trades = [];
    for (const row of rows) {
      const periodLabel = row.computed_at <= DEV_CUTOFF ? "dev" : "test";
      if (periodFilter !== "all" && periodLabel !== periodFilter) continue;

      const stats = calcPeriodStats(dayCandles, row.computed_at, holdDays);
      if (!stats) continue;

      const score = row.score;
      let direction = "flat";
      if (score > ENTRY_THRESHOLD)  direction = "long";
      if (score < -ENTRY_THRESHOLD) direction = "short";

      // P&L（long: forward_return; short: -forward_return; flat: 0）
      const pnl = direction === "long"  ? stats.forward_return :
                  direction === "short" ? -stats.forward_return : 0;

      // MAE（Maximum Adverse Excursion）
      let mae = 0;
      if (direction === "long")  mae = (stats.entryPrice - stats.pMin) / stats.entryPrice;
      if (direction === "short") mae = (stats.pMax - stats.entryPrice) / stats.entryPrice;
      mae = Math.max(0, mae);

      // quality_score: 方向正確 × (1 - min(MAE/5%, 1))
      const hit = pnl > 0 ? 1 : 0;
      const quality_score = direction === "flat" ? null : hit * (1 - Math.min(mae / MAE_NORM, 1));

      insertBt.run(
        run_id, periodLabel, tf, row.computed_at, score, direction,
        stats.entryPrice, stats.exitPrice, stats.pMin, stats.pMax,
        stats.forward_return, pnl, mae, quality_score ?? null, "score", computedAt
      );

      if (direction !== "flat") {
        trades.push({ periodLabel, pnl, mae, hit, quality_score });
      }
    }

    // 彙整指標
    if (trades.length === 0) { console.log(`  [${tf}] 無有效倉位`); continue; }

    for (const period of ["dev", "test", "all"]) {
      const subset = period === "all" ? trades : trades.filter(t => t.periodLabel === period);
      if (subset.length < 3) continue;

      const pnls = subset.map(t => t.pnl);
      const hits = subset.filter(t => t.hit).length;
      const pos  = pnls.filter(p => p > 0).reduce((s, p) => s + p, 0);
      const neg  = pnls.filter(p => p < 0).reduce((s, p) => s + p, 0);
      const m    = mean(pnls) ?? 0;
      const s    = std(pnls)  ?? 1e-9;
      const sharpe = (m / s) * Math.sqrt(365 / holdDays);

      // Equity curve → Max Drawdown
      let equity = 0, peak = 0, maxDD = 0;
      for (const p of pnls) {
        equity += p;
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        if (dd > maxDD) maxDD = dd;
      }

      const profitFactor = neg !== 0 ? Math.abs(pos / neg) : pos > 0 ? Infinity : 1;
      const avgQuality   = mean(subset.map(t => t.quality_score ?? 0)) ?? 0;

      const summary = {
        period, timeframe: tf, n: subset.length,
        sharpe: +sharpe.toFixed(3),
        max_drawdown: +maxDD.toFixed(4),
        win_rate: +(hits / subset.length).toFixed(3),
        profit_factor: profitFactor === Infinity ? 999 : +profitFactor.toFixed(3),
        avg_quality_score: +avgQuality.toFixed(3),
        avg_pnl: +m.toFixed(4),
        entry_threshold: ENTRY_THRESHOLD
      };

      console.log(`  [${tf}][${period}] n=${subset.length} Sharpe=${summary.sharpe} WinRate=${summary.win_rate} MaxDD=${summary.max_drawdown} PF=${summary.profit_factor} AvgQ=${summary.avg_quality_score}`);
    }
  }

  console.log(`  [B] 完成，run_id=${run_id}`);
}

// ── 方法 C — Quintile 分析 ───────────────────────────────────────────────────

async function runMethodC(dayCandles, timeframes) {
  console.log("\n[C] Quintile 分析（使用開發期資料）...");

  for (const tf of timeframes) {
    const holdDays = HOLD_DAYS[tf];
    const scoreCol = tf === "long_term" ? "score_mid_term" : `score_${tf}`;

    const rawRowsC = db.prepare(`
      SELECT computed_at, ${scoreCol} AS score
      FROM asset_comments
      WHERE asset_class = 'crypto' AND ${scoreCol} IS NOT NULL
        AND computed_at <= '${DEV_CUTOFF}'
      ORDER BY computed_at ASC
    `).all();
    const rows = dedupDaily(rawRowsC).sort((a, b) => b.score - a.score);

    if (rows.length < 10) {
      console.log(`  [${tf}] dev 期資料不足（${rows.length} 筆），跳過`);
      continue;
    }

    // 計算 forward return
    const pairs = [];
    for (const row of rows) {
      const fr = calcPeriodStats(dayCandles, row.computed_at, holdDays);
      if (fr) pairs.push({ score: row.score, forward_return: fr.forward_return });
    }

    if (pairs.length < 10) { console.log(`  [${tf}] 有效配對不足，跳過`); continue; }

    // 切成 5 等分（依 score 排序後分位）
    const sorted = [...pairs].sort((a, b) => b.score - a.score);
    const qSize  = Math.floor(sorted.length / 5);
    const quintiles = [];

    for (let q = 0; q < 5; q++) {
      const slice = sorted.slice(q * qSize, (q + 1) * qSize);
      const returns = slice.map(p => p.forward_return);
      quintiles.push({
        quintile: q + 1,
        label: `Q${q + 1}（${q === 0 ? "最高" : q === 4 ? "最低" : ""}）`,
        n: slice.length,
        avg_return: mean(returns),
        score_range: [slice[slice.length - 1]?.score, slice[0]?.score]
      });
    }

    // 單調遞減驗證
    const returns = quintiles.map(q => q.avg_return);
    let monotone = true;
    for (let i = 1; i < returns.length; i++) {
      if (returns[i] > returns[i - 1]) { monotone = false; break; }
    }

    const result = { timeframe: tf, n: pairs.length, quintiles, monotone_decreasing: monotone };

    console.log(`  [${tf}] Q1→Q5 returns: ${quintiles.map(q => (q.avg_return * 100).toFixed(2) + "%").join(" / ")} 單調遞減=${monotone}`);

    insertEV.run(computedAt, null, "quantile", tf, JSON.stringify(result));
  }
}

// ── 方法 D — 滾動 IC / ICIR（★ 優先 3：dev/test 分開計算）────────────────────

async function runMethodD(dayCandles, timeframes) {
  console.log("\n[D] 滾動 IC / ICIR（30 天視窗，dev/test 分開）...");

  for (const tf of timeframes) {
    const holdDays = HOLD_DAYS[tf];
    const scoreCol = tf === "long_term" ? "score_mid_term" : `score_${tf}`;
    const WINDOW_DAYS = 30;

    // 抓全部資料（dedup），再依 period 切分
    const allRows = dedupDaily(db.prepare(`
      SELECT computed_at, ${scoreCol} AS score
      FROM asset_comments
      WHERE asset_class = 'crypto' AND ${scoreCol} IS NOT NULL
      ORDER BY computed_at ASC
    `).all());

    if (allRows.length < 15) {
      console.log(`  [${tf}] 資料不足（${allRows.length} 筆），跳過`);
      continue;
    }

    // 計算 forward return 後依 period 拆分
    const withFR = [];
    for (const row of allRows) {
      const fr = calcPeriodStats(dayCandles, row.computed_at, holdDays);
      if (fr !== null) {
        withFR.push({
          ts: row.computed_at,
          score: row.score,
          forward_return: fr.forward_return,
          period: row.computed_at <= DEV_CUTOFF ? "dev" : "test"
        });
      }
    }

    // 分別對 dev / test / all 三個子集做滾動 IC
    const segments = [
      { label: "dev",  data: withFR.filter(r => r.period === "dev") },
      { label: "test", data: withFR.filter(r => r.period === "test") },
      { label: "all",  data: withFR }
    ];

    const segResults = {};

    for (const seg of segments) {
      if (seg.data.length < WINDOW_DAYS) {
        console.log(`  [${tf}][${seg.label}] 資料不足（${seg.data.length} 筆），跳過`);
        continue;
      }

      const rollingRho  = [];
      const rollingDates = [];

      for (let i = 0; i < seg.data.length; i++) {
        const anchor = new Date(seg.data[i].ts).getTime();
        const win = seg.data.filter(r => {
          const d = new Date(r.ts).getTime();
          return d >= anchor - WINDOW_DAYS * 24 * 3_600_000 && d <= anchor;
        });
        if (win.length < 10) continue;
        const rho = spearman(win.map(r => r.score), win.map(r => r.forward_return));
        if (rho !== null) { rollingRho.push(rho); rollingDates.push(seg.data[i].ts); }
      }

      if (rollingRho.length < 3) continue;

      const IC   = mean(rollingRho);
      const ICIR = IC !== null && std(rollingRho) ? IC / std(rollingRho) : null;
      segResults[seg.label] = { IC, ICIR, n: rollingRho.length, rollingRho, rollingDates };

      const flag = (ICIR !== null && ICIR > 0.5) ? "✅" : "⚠️";
      console.log(`  [${tf}][${seg.label}] n=${rollingRho.length} IC=${IC?.toFixed(4)} ICIR=${ICIR?.toFixed(4)} ${flag}`);
    }

    // 存全期結果
    if (segResults.all || segResults.dev) {
      const s = segResults.all ?? segResults.dev;
      const result = {
        timeframe: tf,
        window_days: WINDOW_DAYS,
        dev:  segResults.dev  ? { IC: +segResults.dev.IC.toFixed(4),  ICIR: +segResults.dev.ICIR.toFixed(4),  n: segResults.dev.n  } : null,
        test: segResults.test ? { IC: +segResults.test.IC.toFixed(4), ICIR: +segResults.test.ICIR.toFixed(4), n: segResults.test.n } : null,
        all:  segResults.all  ? { IC: +segResults.all.IC.toFixed(4),  ICIR: +segResults.all.ICIR.toFixed(4),  n: segResults.all.n  } : null,
        rho_series: s.rollingDates.map((d, i) => ({ date: d, rho: +s.rollingRho[i].toFixed(4) }))
      };
      insertEV.run(computedAt, WINDOW_DAYS, "rolling_ic", tf, JSON.stringify(result));
    }
  }
}

// ── 方法 E — 事件研究 ────────────────────────────────────────────────────────

async function runMethodE(dayCandles, hourCandles) {
  if (SKIP_EVENT) { console.log("\n[E] 跳過事件研究（--skip-event-study）"); return; }
  console.log("\n[E] 事件研究（regime 切換 → 後續報酬）...");

  let transitions;
  try {
    transitions = db.prepare(`
      SELECT timestamp, from_regime, to_regime
      FROM regime_transitions
      ORDER BY timestamp ASC
    `).all();
  } catch {
    console.log("  regime_transitions 表不存在或無資料，跳過");
    return;
  }

  if (!transitions.length) {
    console.log("  無 regime_transitions 記錄，跳過");
    return;
  }

  // 定義事件類型
  const EVENT_TYPES = [
    { key: "regime→risk_on",    filter: r => r.to_regime === "risk_on" },
    { key: "regime→risk_on_tr", filter: r => r.to_regime === "risk_on_transition" },
    { key: "regime→risk_off",   filter: r => r.to_regime === "risk_off" },
    { key: "leverage_flush",    filter: r => r.to_regime === "leverage_flush" || r.from_regime === "leverage_flush" },
    { key: "flush_exit",        filter: r => r.from_regime === "leverage_flush" }
  ];

  const eventStats = {};

  for (const event of EVENT_TYPES) {
    const matching = transitions.filter(event.filter);
    if (!matching.length) continue;

    const records = [];
    for (const ev of matching) {
      const entryPrice = getCloseAt(dayCandles, ev.timestamp);
      if (!entryPrice) continue;

      // 1h / 4h 用小時線
      const return_1h  = calcReturn(hourCandles, ev.timestamp, 1  * 3_600_000);
      const return_4h  = calcReturn(hourCandles, ev.timestamp, 4  * 3_600_000);
      const return_24h = calcReturn(dayCandles,  ev.timestamp, 24 * 3_600_000);
      const return_7d  = calcReturn(dayCandles,  ev.timestamp, 7  * 24 * 3_600_000);

      insertEvent.run(computedAt, event.key, ev.timestamp, entryPrice, return_1h, return_4h, return_24h, return_7d);
      records.push({ return_1h, return_4h, return_24h, return_7d });
    }

    if (records.length > 0) {
      const valid1h  = records.map(r => r.return_1h).filter(v => v !== null);
      const valid7d  = records.map(r => r.return_7d).filter(v => v !== null);
      eventStats[event.key] = {
        n: records.length,
        avg_1h: mean(valid1h),
        avg_7d: mean(valid7d)
      };
      console.log(`  [${event.key}] n=${records.length} avg_1h=${(mean(valid1h) * 100)?.toFixed(2) ?? "—"}% avg_7d=${(mean(valid7d) * 100)?.toFixed(2) ?? "—"}%`);
    }
  }
}

function calcReturn(candles, isoTs, durationMs) {
  const entryPrice = getCloseAt(candles, isoTs);
  if (!entryPrice) return null;
  const exitTs = new Date(isoTs).getTime() + durationMs;
  const exitPrice = getCloseAfter(candles, new Date(exitTs).toISOString());
  if (!exitPrice) return null;
  return (exitPrice - entryPrice) / entryPrice;
}

// ── 方法 F — Monte Carlo 顯著性 ──────────────────────────────────────────────

async function runMethodF(dayCandles, timeframes) {
  console.log("\n[F] Monte Carlo 顯著性檢驗（1000 次打亂）...");

  for (const tf of timeframes) {
    const holdDays = HOLD_DAYS[tf];
    const scoreCol = tf === "long_term" ? "score_mid_term" : `score_${tf}`;

    // 只用 dev 期（dedup 到日頻）
    const rows = dedupDaily(db.prepare(`
      SELECT computed_at, ${scoreCol} AS score
      FROM asset_comments
      WHERE asset_class = 'crypto' AND ${scoreCol} IS NOT NULL
        AND computed_at <= '${DEV_CUTOFF}'
      ORDER BY computed_at ASC
    `).all());

    if (rows.length < 15) {
      console.log(`  [${tf}] dev 期資料不足（${rows.length} 筆），跳過`);
      continue;
    }

    const pairs = [];
    for (const row of rows) {
      const fr = calcPeriodStats(dayCandles, row.computed_at, holdDays);
      if (fr) pairs.push({ score: row.score, forward_return: fr.forward_return });
    }

    if (pairs.length < 15) { console.log(`  [${tf}] 有效配對不足，跳過`); continue; }

    const scores  = pairs.map(p => p.score);
    const returns = pairs.map(p => p.forward_return);
    const actualRho = spearman(scores, returns);
    if (actualRho === null) continue;

    // 打亂 regime 標籤 1000 次
    let exceeds = 0;
    const shuffledRhos = [];
    const shuffled = [...scores];

    for (let t = 0; t < MONTE_TRIALS; t++) {
      // Fisher-Yates shuffle
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const rho = spearman(shuffled, returns);
      if (rho !== null) {
        shuffledRhos.push(rho);
        if (Math.abs(rho) >= Math.abs(actualRho)) exceeds++;
      }
    }

    const pValue = exceeds / shuffledRhos.length;
    const sig = pValue < 0.05 ? "✅ 顯著" : "❌ 不顯著";

    console.log(`  [${tf}] actual_rho=${actualRho.toFixed(4)} p_value=${pValue.toFixed(4)} ${sig} (>${MONTE_TRIALS} trials)`);

    const result = {
      timeframe: tf,
      n: pairs.length,
      actual_rho: +actualRho.toFixed(4),
      monte_carlo_trials: MONTE_TRIALS,
      p_value: +pValue.toFixed(4),
      significant: pValue < 0.05,
      shuffled_rho_mean: +(mean(shuffledRhos) ?? 0).toFixed(4),
      shuffled_rho_std:  +(std(shuffledRhos)  ?? 0).toFixed(4)
    };

    insertEV.run(computedAt, null, "monte_carlo", tf, JSON.stringify(result));
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("CryptoPulse 回測引擎 v2.0");
  console.log(`period=${ARG_PERIOD}  timeframe=${ARG_TIMEFRAME}  threshold=${ENTRY_THRESHOLD}  run_id=${run_id}`);
  console.log(`開發期截止：${DEV_CUTOFF}`);
  console.log(`測試期起始：${TEST_START}`);
  console.log("=".repeat(60));

  // ★ 優先 4：輸出各時框資料可用性
  console.log("\n[0] 資料可用性偵測...");
  for (const tf of ["short_term", "mid_term"]) {
    const scoreCol = tf === "long_term" ? "score_mid_term" : `score_${tf}`;
    const avail = detectScoreAvailability(scoreCol);
    if (avail) {
      console.log(
        `  [${tf}] 最早=${avail.earliest?.substring(0,10) ?? "—"}  dev=${avail.dev_rows}筆` +
        `（門檻內=${avail.dev_above_thresh}）  test=${avail.test_rows}筆` +
        `（門檻內=${avail.test_above_thresh}）`
      );
    }
  }

  // 決定要跑的 timeframes
  const allTF = ["short_term", "mid_term", "long_term"];
  const timeframes = ARG_TIMEFRAME === "all" ? allTF : allTF.filter(tf => tf === ARG_TIMEFRAME);

  if (!timeframes.length) {
    console.error(`未知 timeframe：${ARG_TIMEFRAME}`);
    process.exit(1);
  }

  // 抓資料（覆蓋足夠長的歷史）
  console.log("\n抓取 Kraken BTC 日線（最近 900 天）...");
  const dayCandles = await fetchKrakenOHLC(1440, 900);
  console.log(`  日線 K 棒：${dayCandles.length} 筆`);

  let hourCandles = [];
  if (!SKIP_EVENT) {
    console.log("抓取 Kraken BTC 小時線（最近 180 天）...");
    try {
      hourCandles = await fetchKrakenOHLC(60, 180);
      console.log(`  小時線 K 棒：${hourCandles.length} 筆`);
    } catch (e) {
      console.warn(`  小時線抓取失敗（${e.message}），事件研究僅用日線`);
    }
  }

  // ★ 優先 5：BTC Buy & Hold 基準
  await runBtcBenchmark(dayCandles);

  // 方法 B：虛擬倉位 P&L
  await runMethodB(dayCandles, ARG_PERIOD, timeframes);

  // 方法 C：Quintile 分析（僅 dev 期）
  await runMethodC(dayCandles, timeframes);

  // 方法 D：滾動 IC / ICIR（dev/test 分開）
  await runMethodD(dayCandles, timeframes);

  // 方法 E：事件研究
  await runMethodE(dayCandles, hourCandles.length ? hourCandles : dayCandles);

  // 方法 F：Monte Carlo（僅 dev 期）
  await runMethodF(dayCandles, timeframes);

  // ★ 優先 6：下次評估建議
  const nextReviewDate = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 6);
    return d.toISOString().substring(0, 7); // YYYY-MM
  })();

  const testRowCount = db.prepare(`
    SELECT COUNT(*) AS n FROM backtest_results WHERE run_id=? AND period='test'
  `).get(run_id)?.n ?? 0;

  console.log("\n" + "=".repeat(60));
  console.log("✅ 回測完成");
  console.log(`   backtest_results 新增：查詢 run_id='${run_id}'`);
  console.log("   enhanced_validation 新增：rolling_ic / quantile / monte_carlo");
  console.log("   event_study_results 新增：regime 切換事件後報酬");
  console.log("\n[建議]");
  console.log(`  · 測試期新增交易筆數：${testRowCount}`);
  if (testRowCount < 30) {
    console.log(`  · 測試期交易筆數偏少（<30），建議積累更多測試期資料再評估`);
    console.log(`  · 建議 ${nextReviewDate} 或測試期達 50 筆後重跑 --period=test`);
  } else {
    console.log(`  · 測試期樣本足夠，建議 ${nextReviewDate} 重新校準 threshold`);
    console.log(`  · 若 mid_term/long_term ICIR 測試期 < 0.5，考慮提高門檻至 0.3`);
  }
  console.log(`  · 定期執行：node backend/scripts/backtest-engine.mjs --threshold=${ENTRY_THRESHOLD}`);
  console.log("=".repeat(60));
}

main().catch(e => { console.error("[backtest-engine] 錯誤:", e.message); process.exit(1); });
