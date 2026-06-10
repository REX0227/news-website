/**
 * taiwan/composite.js
 * 整合台股各因子，計算複合進出場評分
 *
 * 輸入：各 Collector 的原始輸出
 * 輸出：{
 *   score: -1.0~+1.0,
 *   label: "strong_bull" | "bull" | "neutral" | "bear" | "strong_bear",
 *   signal: "積極進場" | "偏多觀望" | "中性持平" | "偏空觀望" | "積極減碼",
 *   factors: { [key]: { score, raw, direction, weight } },
 *   coverage: n,      // 有效因子數
 *   total: n          // 總因子數
 * }
 */

import {
  normForeignNetBuy,
  normInstitutionalTotal,
  normMarginChange,
  normShortChange,
  normMaDirection,
  normMomentum5d
} from "./normalize.js";

// 因子權重（加總後自動正規化，不必等於 1）
const FACTOR_WEIGHTS = {
  "tw.foreign_net_buy":       0.35,  // 外資：最重要
  "tw.institutional_total":   0.20,  // 三大法人合計
  "tw.taiex_ma_direction":    0.20,  // MA 方向（技術面）
  "tw.taiex_momentum_5d":     0.15,  // 近5日動能
  "tw.margin_change":         0.05,  // 融資變化（弱訊號）
  "tw.short_change":          0.05   // 融券變化（弱訊號）
};

function scoreLabel(score) {
  if (score >=  0.4) return "strong_bull";
  if (score >=  0.15) return "bull";
  if (score >= -0.15) return "neutral";
  if (score >= -0.4)  return "bear";
  return "strong_bear";
}

function scoreSignal(label) {
  const map = {
    strong_bull: "積極進場",
    bull:        "偏多觀望",
    neutral:     "中性持平",
    bear:        "偏空觀望",
    strong_bear: "積極減碼"
  };
  return map[label] ?? "中性持平";
}

function scoreColor(label) {
  const map = {
    strong_bull: "#4ade80",
    bull:        "#86efac",
    neutral:     "#94a3b8",
    bear:        "#fca5a5",
    strong_bear: "#f87171"
  };
  return map[label] ?? "#94a3b8";
}

export function buildTaiwanComposite({ institutional, margin, taiex }) {
  const factors = {};

  // ─── 外資買賣超 ────────────────────────────────────────────────
  if (institutional?.available) {
    const s = normForeignNetBuy(institutional.foreignNetBuyBillions);
    factors["tw.foreign_net_buy"] = {
      score:     s,
      raw:       institutional.foreignNetBuyBillions,
      rawUnit:   "億元",
      direction: s === null ? "n/a" : s > 0.15 ? "買超" : s < -0.15 ? "賣超" : "中性",
      weight:    FACTOR_WEIGHTS["tw.foreign_net_buy"]
    };

    const st = normInstitutionalTotal(institutional.totalNetBuyBillions);
    factors["tw.institutional_total"] = {
      score:     st,
      raw:       institutional.totalNetBuyBillions,
      rawUnit:   "億元",
      direction: st === null ? "n/a" : st > 0.15 ? "買超" : st < -0.15 ? "賣超" : "中性",
      weight:    FACTOR_WEIGHTS["tw.institutional_total"]
    };
  }

  // ─── 融資融券 ─────────────────────────────────────────────────
  if (margin?.available) {
    const sm = normMarginChange(margin.marginChangeBillions);
    factors["tw.margin_change"] = {
      score:     sm,
      raw:       margin.marginChangeBillions,
      rawUnit:   "億元",
      direction: sm === null ? "n/a" : sm > 0 ? "增加" : sm < 0 ? "減少" : "持平",
      weight:    FACTOR_WEIGHTS["tw.margin_change"]
    };

    const ss = normShortChange(margin.shortChangeKShares);
    factors["tw.short_change"] = {
      score:     ss,
      raw:       margin.shortChangeKShares,
      rawUnit:   "千股",
      direction: ss === null ? "n/a" : ss > 0 ? "回補" : ss < 0 ? "增加" : "持平",
      weight:    FACTOR_WEIGHTS["tw.short_change"]
    };
  }

  // ─── TAIEX 技術面 ─────────────────────────────────────────────
  if (taiex?.available) {
    const sma = normMaDirection(taiex.maDirection);
    factors["tw.taiex_ma_direction"] = {
      score:     sma,
      raw:       taiex.maDirection,
      rawUnit:   "",
      direction: taiex.maDirection === "bullish" ? "多頭排列" : taiex.maDirection === "bearish" ? "空頭排列" : "中性",
      weight:    FACTOR_WEIGHTS["tw.taiex_ma_direction"]
    };

    const smom = normMomentum5d(taiex.momentum5d);
    factors["tw.taiex_momentum_5d"] = {
      score:     smom,
      raw:       taiex.momentum5d,
      rawUnit:   "%",
      direction: smom === null ? "n/a" : smom > 0.1 ? "上漲" : smom < -0.1 ? "下跌" : "持平",
      weight:    FACTOR_WEIGHTS["tw.taiex_momentum_5d"]
    };
  }

  // ─── 複合評分 ─────────────────────────────────────────────────
  let weightedSum  = 0;
  let totalWeight  = 0;
  let coverage     = 0;

  for (const [key, f] of Object.entries(factors)) {
    if (f.score === null) continue;
    weightedSum  += f.score * f.weight;
    totalWeight  += f.weight;
    coverage     += 1;
  }

  const score = totalWeight > 0
    ? Math.round((weightedSum / totalWeight) * 100) / 100
    : null;

  const label  = score !== null ? scoreLabel(score)  : "neutral";
  const signal = scoreSignal(label);
  const color  = scoreColor(label);

  return {
    score,
    label,
    signal,
    color,
    factors,
    coverage,
    total: Object.keys(FACTOR_WEIGHTS).length,
    coveragePct: Math.round((coverage / Object.keys(FACTOR_WEIGHTS).length) * 100)
  };
}
