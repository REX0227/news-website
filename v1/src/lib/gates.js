/**
 * gates.js — 從 factorVector 計算 gate conditions（交易策略的開關條件）
 *
 * Gate 設計原則：
 *  - 每個 gate 有明確的「開啟/關閉」條件和閾值
 *  - 附帶 confidence 和 contributing_factors，讓交易系統知道為何觸發
 *  - 設計為程式交易策略可直接讀取的 boolean/categorical 輸出
 *
 * Gate 分層：
 *  Layer 1: 基本市場環境 gates（是否適合交易）
 *  Layer 2: 方向性 gates（看漲/看跌方向偏向）
 *  Layer 3: 風險控制 gates（需要降倉/停止的條件）
 */

/**
 * computeGates(factorVector) → gateConditions
 *
 * gateConditions 格式：
 * {
 *   "gate_key": {
 *     value: true | false | "low" | "elevated" | "high",
 *     numeric: 0.0,          // 若 boolean，0=false, 1=true
 *     contributing_factors: ["factor.key1", "factor.key2"],
 *     reason: "觸發原因說明",
 *     confidence: 0.85,
 *     computed_at: "ISO"
 *   }
 * }
 */
export function computeGates(factors) {
  const computedAt = new Date().toISOString();
  const gates = {};

  // ── Layer 1: 基本環境 gates ────────────────────────────────

  /**
   * macro.favorable
   * 宏觀環境是否支持風險資產多頭
   * 條件：殖利率曲線未倒掛 AND 10Y 利率非極端高
   */
  const spreadFactor = factors["macro.yield_spread_2s10s"];
  const yield10y = factors["macro.yield_10y"];
  const macroFavorable = (() => {
    const inverted = spreadFactor ? spreadFactor.direction === "inverted" : false;
    const highRate = yield10y ? Number(yield10y.value) > 5.0 : false;
    return !inverted && !highRate;
  })();
  const macroConfidence = [spreadFactor, yield10y].filter(Boolean).length >= 1 ? 0.8 : 0.4;
  gates["macro.favorable"] = {
    value: macroFavorable,
    numeric: macroFavorable ? 1 : 0,
    contributing_factors: ["macro.yield_spread_2s10s", "macro.yield_10y"].filter((k) => factors[k]),
    reason: macroFavorable
      ? `殖利率曲線${spreadFactor ? `利差 ${spreadFactor.value}%（正常）` : "數據不足"}，宏觀環境支持風險偏好。`
      : `殖利率${spreadFactor?.direction === "inverted" ? "倒掛" : "高位"}，宏觀環境對風險資產不利。`,
    confidence: macroConfidence,
    computed_at: computedAt
  };

  /**
   * liquidity.adequate
   * 市場流動性是否充裕
   * 條件：穩定幣市值 > $120B OR DeFi TVL > $60B
   */
  const stableMcap = factors["liquidity.stablecoin_mcap"];
  const defiTvl = factors["liquidity.defi_tvl"];
  const liquidityAdequate = (() => {
    const stableOk = stableMcap ? Number(stableMcap.value) > 120e9 : false;
    const tvlOk = defiTvl ? Number(defiTvl.value) > 60e9 : false;
    return stableOk || tvlOk;
  })();
  gates["liquidity.adequate"] = {
    value: liquidityAdequate,
    numeric: liquidityAdequate ? 1 : 0,
    contributing_factors: ["liquidity.stablecoin_mcap", "liquidity.defi_tvl"].filter((k) => factors[k]),
    reason: liquidityAdequate
      ? `穩定幣${stableMcap ? ` $${(stableMcap.value / 1e9).toFixed(0)}B` : ""}，TVL${defiTvl ? ` $${(defiTvl.value / 1e9).toFixed(0)}B` : ""}，流動性充裕。`
      : "穩定幣市值與 DeFi TVL 均偏低，流動性不足以支撐大行情。",
    confidence: [stableMcap, defiTvl].filter(Boolean).length >= 1 ? 0.82 : 0.35,
    computed_at: computedAt
  };

  /**
   * event.blackout_window
   * 是否在高衝擊事件前 24 小時內（建議縮小倉位）
   * 條件：未來 24h 內有 high importance 宏觀事件
   */
  const event24h = factors["event.high_impact_24h"];
  const inBlackout = event24h ? Boolean(event24h.value) : false;
  gates["event.blackout_window"] = {
    value: inBlackout,
    numeric: inBlackout ? 1 : 0,
    contributing_factors: ["event.high_impact_24h"],
    reason: inBlackout
      ? `未來 24h 高衝擊事件：${(event24h?.events || []).join("、")}，建議縮減倉位。`
      : "未來 24h 無高衝擊宏觀事件，可正常交易。",
    confidence: event24h ? 0.95 : 0.5,
    computed_at: computedAt
  };

  // ── Layer 2: 方向性 gates ──────────────────────────────────

  /**
   * direction.bullish_bias
   * 整體方向是否偏多
   * 綜合：ETF 資金流、信號偏向、情緒、流動性變化
   */
  const etfFlow = factors["flows.etf_net_flow_7d"];
  const signalBias = factors["signals.crypto_bias"];
  const fearGreed = factors["sentiment.fear_greed"];
  const stableChange = factors["liquidity.stablecoin_change_7d"];

  const bullishScore = (() => {
    const scores = [];
    if (etfFlow?.score !== undefined) scores.push({ s: etfFlow.score, w: 0.35 });
    if (signalBias?.score !== undefined) scores.push({ s: signalBias.score, w: 0.25 });
    if (fearGreed?.score !== undefined) scores.push({ s: fearGreed.score, w: 0.2 });
    if (stableChange?.score !== undefined) scores.push({ s: stableChange.score, w: 0.2 });
    if (scores.length === 0) return 0;
    const totalW = scores.reduce((a, { w }) => a + w, 0);
    return scores.reduce((a, { s, w }) => a + s * (w / totalW), 0);
  })();

  const bullishBias = bullishScore > 0.15;
  const bearishBias = bullishScore < -0.15;
  gates["direction.bullish_bias"] = {
    value: bullishBias,
    numeric: Number(bullishScore.toFixed(4)),
    contributing_factors: [
      etfFlow && "flows.etf_net_flow_7d",
      signalBias && "signals.crypto_bias",
      fearGreed && "sentiment.fear_greed",
      stableChange && "liquidity.stablecoin_change_7d"
    ].filter(Boolean),
    reason: `加權多空評分 ${bullishScore > 0 ? "+" : ""}${bullishScore.toFixed(2)}（閾值 ±0.15）`,
    confidence: Math.min(0.75, 0.3 + [etfFlow, signalBias, fearGreed, stableChange].filter(Boolean).length * 0.12),
    computed_at: computedAt
  };

  gates["direction.bearish_bias"] = {
    value: bearishBias,
    numeric: Number((-bullishScore).toFixed(4)),
    contributing_factors: gates["direction.bullish_bias"].contributing_factors,
    reason: gates["direction.bullish_bias"].reason,
    confidence: gates["direction.bullish_bias"].confidence,
    computed_at: computedAt
  };

  // ── Layer 3: 風險控制 gates ────────────────────────────────

  /**
   * risk.leverage_overextended
   * 市場槓桿是否過度（建議避免追多/追空）
   * 條件：7D 清算 > $700M
   */
  const liqFactor = factors["derivatives.liquidation_7d"];
  const liqOverextended = liqFactor ? Number(liqFactor.value) > 700e6 : false;
  gates["risk.leverage_overextended"] = {
    value: liqOverextended,
    numeric: liqOverextended ? 1 : 0,
    contributing_factors: ["derivatives.liquidation_7d"].filter((k) => factors[k]),
    reason: liqOverextended
      ? `7D 清算量 $${(liqFactor.value / 1e6).toFixed(0)}M，槓桿過度擠壓，多殺多/空殺空風險高。`
      : `清算壓力${liqFactor ? `在正常範圍（$${(liqFactor.value / 1e6).toFixed(0)}M）` : "數據不足"}。`,
    confidence: liqFactor ? Number(liqFactor.confidence) : 0.3,
    computed_at: computedAt
  };

  /**
   * risk.regulatory_level
   * 監管風險等級
   * "low" | "elevated" | "high"
   */
  const regBias = factors["risk.regulatory_bias"];
  const regLevel = (() => {
    if (!regBias) return "unknown";
    const score = Number(regBias.score);
    if (score < -0.4) return "high";
    if (score < -0.1) return "elevated";
    return "low";
  })();
  gates["risk.regulatory_level"] = {
    value: regLevel,
    numeric: regLevel === "high" ? 1 : regLevel === "elevated" ? 0.5 : 0,
    contributing_factors: ["risk.regulatory_bias"].filter((k) => factors[k]),
    reason: regBias
      ? `監管訊號：${regBias.bull_count}正/${regBias.bear_count}負，風險等級 ${regLevel}。`
      : "監管訊號不足，風險等級未知。",
    confidence: regBias ? 0.65 : 0.2,
    computed_at: computedAt
  };

  /**
   * risk.yield_curve_inverted
   * 殖利率是否倒掛（中長期系統性風險警示）
   */
  const isInverted = spreadFactor ? spreadFactor.direction === "inverted" : false;
  gates["risk.yield_curve_inverted"] = {
    value: isInverted,
    numeric: isInverted ? 1 : 0,
    contributing_factors: ["macro.yield_spread_2s10s"].filter((k) => factors[k]),
    reason: isInverted
      ? `2Y-10Y 利差 ${spreadFactor?.value}%，殖利率曲線倒掛，衰退風險信號持續。`
      : `2Y-10Y 利差${spreadFactor ? ` ${spreadFactor.value}%` : " 數據不足"}，曲線${isInverted ? "倒掛" : "正常"}。`,
    confidence: spreadFactor ? 0.95 : 0.2,
    computed_at: computedAt
  };

  return gates;
}

/**
 * gatesSummary(gates) → 給交易程式的精簡版（純 key-value）
 * 適合直接作為策略條件判斷的輸入
 */
export function gatesSummary(gates) {
  return Object.fromEntries(
    Object.entries(gates).map(([k, v]) => [k, v.value])
  );
}
