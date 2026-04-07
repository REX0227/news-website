/**
 * composite.js — composite_score 與 factor_delta 共用計算
 *
 * 被兩個地方使用：
 *  - v1/scripts/update-data.mjs（pipeline 執行時寫入 payload）
 *  - backend/routes/v2.js（/api/v2/snapshot 即時計算）
 */

// ── Factor 設計權重（可依交易策略調整）────────────────────────────
export const FACTOR_WEIGHTS = {
  "macro.vix":                        0.08,
  "macro.dxy":                        0.07,
  "macro.yield_spread_2s10s":         0.08,
  "macro.yield_10y":                  0.06,
  "sentiment.fear_greed":             0.05,
  "sentiment.btc_dominance":          0.03,
  "liquidity.stablecoin_mcap":        0.04,
  "liquidity.stablecoin_change_7d":   0.04,
  "liquidity.defi_tvl":               0.03,
  "flows.etf_net_flow_7d":            0.12,
  "derivatives.liquidation_7d":       0.06,
  "derivatives.btc_funding_rate":     0.07,
  "derivatives.btc_open_interest":    0.04,
  "derivatives.btc_long_short_ratio": 0.08,
  "derivatives.btc_taker_cvd":        0.07,
  "derivatives.btc_put_call_ratio":   0.08,  // Deribit P/C 比
  "derivatives.btc_iv":              0.04,  // Deribit 近月 ATM 隱含波動率（高 IV 偏看跌）
  "risk.geopolitical_bias":           0.04,
  "risk.regulatory_bias":             0.06,
  // event factors 不進入 composite（單向偏空且非持續訊號）
};

// ── computeCompositeScore ─────────────────────────────────────────
export function computeCompositeScore(factorMap) {
  let weightedSum = 0;
  let totalWeight = 0;
  const usedFactors = [];

  for (const [key, weight] of Object.entries(FACTOR_WEIGHTS)) {
    const f = factorMap[key];
    if (f?.score !== undefined && f.score !== null && Number.isFinite(Number(f.score))) {
      weightedSum += Number(f.score) * weight;
      totalWeight += weight;
      usedFactors.push(key);
    }
  }

  if (totalWeight === 0) return null;

  const score = weightedSum / totalWeight;
  const label = score >= 0.4  ? "強烈看漲"
    : score >= 0.15 ? "偏多"
    : score <= -0.4 ? "強烈看跌"
    : score <= -0.15 ? "偏空"
    : "中性";

  return {
    score:        Number(score.toFixed(4)),
    label,
    coverage:     usedFactors.length,
    total_factors: Object.keys(FACTOR_WEIGHTS).length,
    coverage_pct: Number((usedFactors.length / Object.keys(FACTOR_WEIGHTS).length * 100).toFixed(1))
  };
}

// ── computeFactorDelta ────────────────────────────────────────────
/**
 * 比較當前 factorMap 與上一次 run 的 rows，列出方向改變或分數跳變的 factors
 * @param {Object} currentFactorMap  - buildFactorVector 輸出
 * @param {Array}  previousRows      - getPreviousRunFactors() 輸出（SQLite rows）
 */
export function computeFactorDelta(currentFactorMap, previousRows) {
  if (!previousRows || previousRows.length === 0) return { count: 0, changed: [] };

  const prevMap = {};
  for (const r of previousRows) {
    prevMap[r.factor_key] = {
      score:     r.normalized_score,
      direction: r.direction
    };
  }

  const changed = [];
  for (const [key, f] of Object.entries(currentFactorMap)) {
    const prev = prevMap[key];
    if (!prev) continue;

    const scoreDiff = (f.score !== null && f.score !== undefined &&
                       prev.score !== null && prev.score !== undefined)
      ? Number((Number(f.score) - Number(prev.score)).toFixed(4))
      : null;

    const directionChanged = prev.direction && f.direction && prev.direction !== f.direction;
    const bigMove = scoreDiff !== null && Math.abs(scoreDiff) >= 0.2;

    if (directionChanged || bigMove) {
      changed.push({
        factor:            key,
        prev_score:        prev.score,
        curr_score:        f.score,
        score_diff:        scoreDiff,
        prev_direction:    prev.direction,
        curr_direction:    f.direction,
        direction_changed: directionChanged,
        big_move:          bigMove
      });
    }
  }

  // 依 |score_diff| 排序（最大變化優先）
  changed.sort((a, b) => Math.abs(b.score_diff ?? 0) - Math.abs(a.score_diff ?? 0));
  return { count: changed.length, changed };
}
