/**
 * backtest-signals.mjs — Level 3 信號規則歷史回測框架
 *
 * 從歷史 factor_snapshots 重放，測試每組條件規則的預測準確率：
 *   - precision：觸發時 24h 後 BTC 正/負報酬的命中率
 *   - frequency：每月平均觸發次數
 *   - avg_return：觸發後 24h 平均報酬
 *   - max_drawdown：最大連續虧損
 *
 * 執行：
 *   node backend/scripts/backtest-signals.mjs
 *   node backend/scripts/backtest-signals.mjs --days=180 --min-precision=0.60
 *   node backend/scripts/backtest-signals.mjs --rule=capitulation_buy
 *
 * 輸出：回測報告（含 precision > 60% 的規則建議）
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DB_PATH   = path.join(__dirname, "..", "gecko.db");
const args      = process.argv.slice(2);
const DAYS      = parseInt(args.find(a => a.startsWith("--days="))?.split("=")[1] ?? "90");
const MIN_PREC  = parseFloat(args.find(a => a.startsWith("--min-precision="))?.split("=")[1] ?? "0.55");
const RULE_FILTER = args.find(a => a.startsWith("--rule="))?.split("=")[1] ?? null;
const KRAKEN    = "https://api.kraken.com";

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

// ── Kraken BTC 價格抓取 ───────────────────────────────────────────────────────

async function fetchBtcCandles(days) {
  const sinceTs = Math.floor((Date.now() - (days + 5) * 86400_000) / 1000);
  const allCandles = [];
  let since = sinceTs;

  while (true) {
    const url = `${KRAKEN}/0/public/OHLC?pair=XBTUSD&interval=60&since=${since}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
    const json = await res.json();
    if (json.error?.length) throw new Error(json.error.join(", "));

    const rows = json.result?.XXBTZUSD ?? [];
    if (!rows.length) break;

    for (const k of rows) {
      allCandles.push({ openTime: parseInt(k[0]) * 1000, close: parseFloat(k[4]) });
    }

    const nextSince = json.result?.last;
    if (!nextSince || nextSince <= since) break;
    since = nextSince;
    if (allCandles.length >= (days + 5) * 24) break;
    await new Promise(r => setTimeout(r, 500));
  }

  return [...new Map(allCandles.map(c => [c.openTime, c])).values()]
    .sort((a, b) => a.openTime - b.openTime);
}

function forwardReturn(candles, isoTs, hours) {
  const tsMs = new Date(isoTs).getTime();
  let priceNow = null, priceThen = null;
  for (const c of candles) {
    if (c.openTime <= tsMs) priceNow = c.close;
    else if (priceThen === null && c.openTime >= tsMs + hours * 3_600_000) priceThen = c.close;
  }
  if (!priceNow || !priceThen) return null;
  return (priceThen - priceNow) / priceNow;
}

// ── 規則定義（與 signal-detector.js 同步）────────────────────────────────────

const RULES = [
  {
    id: "capitulation_buy",
    label: "恐慌清算底部",
    direction: "bullish",
    horizon_h: 24,
    cooldown_h: 4,
    conditions: [
      { factor: "crypto.derivatives.BTC.liq_spike",              op: ">",  threshold: 0.35 },
      { factor: "crypto.derivatives.BTC.funding_rate_zscore",    op: "<",  threshold: 0.1 },
      { factor: "crypto.derivatives.BTC.funding_rate_momentum",  op: "<",  threshold: 0.0 },
    ]
  },
  {
    id: "overheating_exit",
    label: "槓桿過熱警示",
    direction: "bearish",
    horizon_h: 24,
    cooldown_h: 3,
    conditions: [
      { factor: "crypto.derivatives.BTC.funding_rate_zscore",    op: "<",  threshold: -0.4 },
      { factor: "crypto.derivatives.BTC.funding_rate_momentum",  op: "<",  threshold: -0.1 },
      { factor: "crypto.derivatives.btc.lsr_momentum",           op: "<",  threshold: 0.0 },
    ]
  },
  {
    id: "squeeze_setup",
    label: "空頭軋倉設置",
    direction: "bullish",
    horizon_h: 12,
    cooldown_h: 2,
    conditions: [
      { factor: "crypto.derivatives.BTC.liq_heatmap_pressure",   op: ">",  threshold: 0.3 },
      { factor: "crypto.orderbook.BTC.bid_ask_imbalance",        op: ">",  threshold: 0.2 },
      { factor: "crypto.derivatives.btc.cvd_momentum",           op: ">",  threshold: 0.1 },
    ]
  },
  {
    id: "long_flush_warning",
    label: "多頭清洗風險",
    direction: "bearish",
    horizon_h: 12,
    cooldown_h: 2,
    conditions: [
      { factor: "crypto.derivatives.BTC.liq_heatmap_pressure",   op: "<",  threshold: -0.3 },
      { factor: "crypto.orderbook.BTC.bid_ask_imbalance",        op: "<",  threshold: -0.2 },
      { factor: "crypto.derivatives.btc.oi_momentum",            op: "<",  threshold: -0.15 },
    ]
  },
  // ── 單因子基準回測（找最強的單一 factor threshold）────────────────────────
  {
    id: "single_fr_low",
    label: "FR zscore 低位（單因子）",
    direction: "bullish",
    horizon_h: 24,
    cooldown_h: 6,
    conditions: [
      { factor: "crypto.derivatives.BTC.funding_rate_zscore", op: ">", threshold: 0.25 }
    ]
  },
  {
    id: "single_liq_spike",
    label: "清算驟增（單因子）",
    direction: "bullish",
    horizon_h: 24,
    cooldown_h: 4,
    conditions: [
      { factor: "crypto.derivatives.BTC.liq_spike", op: ">", threshold: 0.4 }
    ]
  },
  {
    id: "single_ob_bull",
    label: "買盤主導（OB 單因子）",
    direction: "bullish",
    horizon_h: 6,
    cooldown_h: 1,
    conditions: [
      { factor: "crypto.orderbook.BTC.bid_ask_imbalance", op: ">", threshold: 0.3 }
    ]
  }
];

// ── Factor 歷史資料讀取 ───────────────────────────────────────────────────────

function getFactorHistory(factorKey, sinceIso) {
  return db.prepare(`
    SELECT normalized_score, computed_at FROM factor_snapshots
    WHERE factor_key = ? AND computed_at >= ?
    ORDER BY computed_at ASC
  `).all(factorKey, sinceIso);
}

function checkCondition(score, op, threshold) {
  if (score === null) return false;
  switch (op) {
    case ">":  return score > threshold;
    case "<":  return score < threshold;
    case ">=": return score >= threshold;
    case "<=": return score <= threshold;
    default:   return false;
  }
}

// ── 回測執行 ──────────────────────────────────────────────────────────────────

function backtestRule(rule, candles, since) {
  // 建立每個 condition factor 的時序索引
  const factorData = {};
  for (const cond of rule.conditions) {
    if (factorData[cond.factor]) continue;
    const rows = getFactorHistory(cond.factor, since);
    if (rows.length === 0) return null;  // 資料不足
    factorData[cond.factor] = rows;
  }

  // 建立統一時間點集合（以第一個 condition 的時間為基準）
  const primaryFactor = rule.conditions[0].factor;
  const timePoints = factorData[primaryFactor].map(r => r.computed_at);

  const triggered = [];
  let lastTriggerMs = 0;

  for (const ts of timePoints) {
    const tsMs = new Date(ts).getTime();
    if (tsMs - lastTriggerMs < rule.cooldown_h * 3_600_000) continue;

    // 評估所有條件（取每個 factor 在此時間點的最近值）
    let allPass = true;
    for (const cond of rule.conditions) {
      const rows = factorData[cond.factor];
      // 找 ts 時刻的最近值
      let closest = null;
      for (const r of rows) {
        if (r.computed_at <= ts) closest = r;
        else break;
      }
      if (!closest || !checkCondition(closest.normalized_score, cond.op, cond.threshold)) {
        allPass = false;
        break;
      }
    }

    if (!allPass) continue;

    // 條件滿足：計算 forward return
    const fwdReturn = forwardReturn(candles, ts, rule.horizon_h);
    if (fwdReturn === null) continue;

    triggered.push({ ts, fwdReturn });
    lastTriggerMs = tsMs;
  }

  if (triggered.length < 3) return null;  // 觸發次數不足

  const isCorrect = triggered.filter(t =>
    rule.direction === "bullish" ? t.fwdReturn > 0 : t.fwdReturn < 0
  ).length;
  const precision = isCorrect / triggered.length;
  const avgReturn = triggered.reduce((s, t) => s + t.fwdReturn, 0) / triggered.length;

  // 最大連續虧損
  let maxConsecLoss = 0, consecLoss = 0;
  for (const t of triggered) {
    const isWin = rule.direction === "bullish" ? t.fwdReturn > 0 : t.fwdReturn < 0;
    if (!isWin) { consecLoss++; maxConsecLoss = Math.max(maxConsecLoss, consecLoss); }
    else consecLoss = 0;
  }

  const daysSpanned = (new Date(triggered[triggered.length-1].ts) - new Date(triggered[0].ts)) / 86400_000;
  const freqPerMonth = daysSpanned > 0 ? triggered.length / daysSpanned * 30 : 0;

  return {
    id:            rule.id,
    label:         rule.label,
    direction:     rule.direction,
    horizon_h:     rule.horizon_h,
    n_triggered:   triggered.length,
    precision:     Number(precision.toFixed(4)),
    avg_return_pct: Number((avgReturn * 100).toFixed(3)),
    freq_per_month: Number(freqPerMonth.toFixed(1)),
    max_consec_loss: maxConsecLoss,
    passing:       precision >= MIN_PREC && triggered.length >= 5,
    triggers:      triggered.slice(-5).map(t => ({
      ts: t.ts,
      return_pct: Number((t.fwdReturn * 100).toFixed(2))
    }))
  };
}

// ── 主程式 ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[backtest] days=${DAYS}  min_precision=${MIN_PREC}  rule=${RULE_FILTER ?? "all"}`);
  console.log("[backtest] Fetching BTC hourly candles from Kraken...");

  const candles = await fetchBtcCandles(DAYS);
  console.log(`[backtest] ${candles.length} hourly candles fetched`);

  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rules = RULE_FILTER ? RULES.filter(r => r.id === RULE_FILTER) : RULES;

  console.log(`\n${"=".repeat(80)}`);
  console.log(`BACKTEST RESULTS (last ${DAYS} days, min precision=${MIN_PREC})`);
  console.log("=".repeat(80));

  const passing = [], failing = [], insufficient = [];

  for (const rule of rules) {
    process.stdout.write(`Testing ${rule.id}... `);
    const result = backtestRule(rule, candles, since);

    if (!result) {
      insufficient.push(rule.id);
      console.log("INSUFFICIENT DATA");
      continue;
    }

    const status = result.passing ? "PASS" : "FAIL";
    console.log(`${status}  precision=${result.precision}  n=${result.n_triggered}  avg=${result.avg_return_pct}%/trade`);

    if (result.passing) passing.push(result);
    else failing.push(result);
  }

  // 詳細報告
  if (passing.length > 0) {
    console.log(`\n${"─".repeat(80)}`);
    console.log(`PASSING RULES (${passing.length}):`);
    for (const r of passing.sort((a, b) => b.precision - a.precision)) {
      console.log(`\n  [${r.id}] ${r.label}`);
      console.log(`    precision:      ${(r.precision * 100).toFixed(1)}%`);
      console.log(`    avg_return:     ${r.avg_return_pct}%`);
      console.log(`    freq/month:     ${r.freq_per_month}x`);
      console.log(`    n_triggered:    ${r.n_triggered}`);
      console.log(`    max_consec_loss: ${r.max_consec_loss}`);
      console.log(`    last 5 triggers: ${r.triggers.map(t => `${t.ts.slice(0,10)}(${t.return_pct}%)`).join(", ")}`);
    }
  }

  if (failing.length > 0) {
    console.log(`\n${"─".repeat(80)}`);
    console.log(`FAILING RULES (${failing.length}) — threshold suggestions:`);
    for (const r of failing.sort((a, b) => b.precision - a.precision)) {
      const gap = ((MIN_PREC - r.precision) * 100).toFixed(1);
      console.log(`  [${r.id}]  precision=${(r.precision*100).toFixed(1)}%  gap=${gap}pp  n=${r.n_triggered}  avg=${r.avg_return_pct}%`);
    }
  }

  if (insufficient.length > 0) {
    console.log(`\nINSUFFICIENT DATA: ${insufficient.join(", ")}`);
    console.log("  → Run ob-ws.js + liq-heatmap-poller.js for at least 7 days to accumulate data");
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log(`Total: ${passing.length} passing, ${failing.length} failing, ${insufficient.length} insufficient`);
  console.log("Next: Update signal-detector.js RULES based on passing results");
}

main().catch(err => {
  console.error("[backtest] Fatal:", err.message);
  process.exit(1);
});
