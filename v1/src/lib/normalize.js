/**
 * normalize.js — 將各 collector 的原始數值轉換為標準化 factor scores
 *
 * 所有 score 輸出範圍：[-1.0, +1.0]
 *   +1.0 = 最強烈看漲訊號
 *   -1.0 = 最強烈看跌訊號
 *    0.0 = 中性
 *
 * null 代表「數據不可用，不應參與計算」
 *
 * 每個函數設計原則：
 *  - 純函數，無副作用
 *  - 明確記錄參考基準（reference values）及其依據
 *  - 信心度（confidence）由來源品質決定，不由數值大小決定
 */

function clamp(value, min = -1, max = 1) {
  return Math.max(min, Math.min(max, value));
}

// ── 1. 宏觀利率環境 ──────────────────────────────────────────────

/**
 * 殖利率曲線利差（10Y - 2Y）
 * 正值 = 正常，負值 = 倒掛（衰退前兆，對風險資產看跌）
 * 參考基準：±1.5% 涵蓋歷史大部分區間
 */
export function normalizeYieldSpread(spread10y2yPct) {
  if (!Number.isFinite(spread10y2yPct)) return null;
  return clamp(spread10y2yPct / 1.5);
}

/**
 * 10Y 殖利率絕對水準（越高 = 融資成本越重 = 對加密看跌）
 * 參考基準：2% = 中性，5% = 極端壓力
 * Score: 2% → 0, 5% → -1
 */
export function normalizeYield10y(yieldPct) {
  if (!Number.isFinite(yieldPct)) return null;
  return clamp(-(yieldPct - 2.0) / 3.0);
}

// ── 2. 市場情緒 ──────────────────────────────────────────────────

/**
 * 恐慌貪婪指數（Alternative.me，0–100）
 * 50 = 中性；100 = 極度貪婪（短線反轉風險）；0 = 極度恐慌（底部機會）
 * 注意：貪婪不代表直接看漲，極端貪婪反而是賣訊
 */
export function normalizeFearGreed(value) {
  if (!Number.isFinite(value)) return null;
  return clamp((value - 50) / 50);
}

/**
 * BTC 主導率（dominance %）
 * 高主導率 = 避險，資金集中在 BTC（對山寨看跌，對 BTC 相對穩定）
 * 參考基準：40% = 低主導（山寨季），65% = 高主導（BTC 主導）
 */
export function normalizeBtcDominance(dominancePct) {
  if (!Number.isFinite(dominancePct)) return null;
  // 以 52% 為中性，向上偏移 = 更保守/集中
  return clamp((dominancePct - 52) / 13);
}

// ── 3. 流動性條件 ────────────────────────────────────────────────

/**
 * 穩定幣市值 7D 變化率（%）
 * 穩定幣供應增長 = 乾火藥進場 = 看漲
 * 參考基準：±5% 7D 變化
 */
export function normalizeStablecoinChange7d(change7dPct) {
  if (!Number.isFinite(change7dPct)) return null;
  return clamp(change7dPct / 5.0);
}

/**
 * 穩定幣總市值（USD）水準
 * 穩定幣充沛 = 流動性充裕 = 偏多
 * 參考基準：$100B = 中性，$200B = 極度充裕
 */
export function normalizeStablecoinMcap(mcapUsd) {
  if (!Number.isFinite(mcapUsd) || mcapUsd <= 0) return null;
  const REF = 150e9;
  return clamp((mcapUsd - REF) / REF);
}

/**
 * DeFi TVL 水準（USD）
 * TVL 高 = 鏈上活躍 = 偏多
 * 參考基準：$60B = 中性，$120B = 非常活躍
 */
export function normalizeTvl(tvlUsd) {
  if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) return null;
  const REF = 80e9;
  return clamp((tvlUsd - REF) / REF);
}

// ── 4. 資金流向 ──────────────────────────────────────────────────

/**
 * BTC ETF 7D 淨流量（USD）
 * 正值 = 淨流入（看漲），負值 = 淨流出（看跌）
 * 參考基準：±$500M/週 = 中等流量；±$2B = 強烈訊號
 */
export function normalizeEtfFlow7d(flowUsd) {
  if (!Number.isFinite(flowUsd)) return null;
  return clamp(flowUsd / 500e6);
}

// ── 5. 衍生品 / 槓桿 ─────────────────────────────────────────────

/**
 * 7D 清算總額（USD）
 * 清算越多 = 槓桿壓力越高 = 越偏空（負值）
 * 參考基準：$300M = 正常；$1B = 高壓；$3B = 極端
 */
export function normalizeLiquidation7d(totalUsd) {
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return 0;
  return clamp(-totalUsd / 1e9);
}

// ── 6. 新聞/訊號偏向 ─────────────────────────────────────────────

/**
 * 多空訊號比（from countBias）
 * bullCount / bearCount → 淨偏向 [-1, +1]
 */
export function normalizeSignalBias(bullCount, bearCount) {
  const total = bullCount + bearCount;
  if (total === 0) return 0;
  return (bullCount - bearCount) / total;
}

/**
 * 監管/政策訊號偏向
 * 正面法規 > 負面 = 看漲
 */
export function normalizeRegulatoryBias(bullCount, bearCount) {
  return normalizeSignalBias(bullCount, bearCount);
}

// ── 7. 衍生品（Coinglass）───────────────────────────────────────

/**
 * BTC 資金費率（8h，decimal）
 * 正費率 = 多頭付費給空頭 = 多頭過熱 = 看跌（負分）
 * 負費率 = 空頭付費給多頭 = 空頭過熱 = 看漲（正分）
 * 參考基準：±0.05% per 8h = 極端
 *   0.01% = 0.0001 decimal
 *   0.05% = 0.0005 decimal
 */
export function normalizeFundingRate(rate8hDecimal) {
  if (!Number.isFinite(rate8hDecimal)) return null;
  // 負 rate → 看漲（正分）；正 rate → 看跌（負分）
  return clamp(-rate8hDecimal / 0.0005);
}

// ── 8. 主函數：從 rawData 建立完整 factor vector ─────────────────

/**
 * buildFactorVector(rawData) → factorVector
 *
 * factorVector 格式：
 * {
 *   "macro.yield_spread_2s10s": {
 *     value: 0.35,        // 原始值
 *     score: 0.23,        // 標準化後 [-1, +1]
 *     unit: "pct",
 *     direction: "normal", // "normal" | "inverted" | "bullish" | "bearish" | "neutral"
 *     confidence: 0.95,
 *     source_tier: 1,      // 1=官方 2=機構API 3=公開API 4=新聞估算
 *     computed_at: "ISO"
 *   },
 *   ...
 * }
 */
export function buildFactorVector(rawData) {
  const computedAt = new Date().toISOString();
  const factors = {};

  // ── 利率 ─────────────────────────────────────────────────────
  const ratesLatest = rawData.ratesIntel?.latest || {};
  const y10y = ratesLatest.y10y ?? null;
  const y2y = ratesLatest.y2y ?? null;
  const y3m = ratesLatest.y3m ?? null;
  const spread2s10s = ratesLatest.spread10y2y ?? null;

  if (y10y !== null) {
    factors["macro.yield_10y"] = {
      value: y10y, unit: "pct",
      score: normalizeYield10y(y10y),
      direction: y10y > 4.5 ? "bearish" : y10y < 3.0 ? "bullish" : "neutral",
      confidence: 0.98, source_tier: 1, computed_at: computedAt
    };
  }
  if (y2y !== null) {
    factors["macro.yield_2y"] = {
      value: y2y, unit: "pct",
      score: normalizeYield10y(y2y),
      direction: "neutral",
      confidence: 0.98, source_tier: 1, computed_at: computedAt
    };
  }
  if (y3m !== null) {
    factors["macro.yield_3m"] = {
      value: y3m, unit: "pct",
      score: normalizeYield10y(y3m),
      direction: "neutral",
      confidence: 0.98, source_tier: 1, computed_at: computedAt
    };
  }
  if (spread2s10s !== null) {
    const spreadScore = normalizeYieldSpread(spread2s10s);
    factors["macro.yield_spread_2s10s"] = {
      value: spread2s10s, unit: "pct",
      score: spreadScore,
      direction: spread2s10s < 0 ? "inverted" : "normal",
      confidence: 0.98, source_tier: 1, computed_at: computedAt
    };
  }

  // ── 情緒 ─────────────────────────────────────────────────────
  const sentiment = rawData.marketIntel?.sentiment;
  if (sentiment?.fearGreedValue !== null && sentiment?.fearGreedValue !== undefined) {
    const fgVal = Number(sentiment.fearGreedValue);
    factors["sentiment.fear_greed"] = {
      value: fgVal, unit: "index",
      score: normalizeFearGreed(fgVal),
      direction: fgVal >= 60 ? "bullish" : fgVal <= 40 ? "bearish" : "neutral",
      label: sentiment.fearGreedClassification || "",
      confidence: 0.9, source_tier: 3, computed_at: computedAt
    };
  }

  const globalData = rawData.marketIntel?.global;
  if (globalData?.btcDominancePct !== null && globalData?.btcDominancePct !== undefined) {
    const dom = Number(globalData.btcDominancePct);
    factors["sentiment.btc_dominance"] = {
      value: dom, unit: "pct",
      score: normalizeBtcDominance(dom),
      direction: dom > 55 ? "defensive" : dom < 45 ? "altseason" : "neutral",
      confidence: 0.9, source_tier: 3, computed_at: computedAt
    };
  }

  // ── 流動性 ──────────────────────────────────────────────────
  const stablecoins = rawData.liquidityIntel?.stablecoins;
  if (stablecoins?.totalMcapUsd !== null && stablecoins?.totalMcapUsd !== undefined) {
    const mcap = Number(stablecoins.totalMcapUsd);
    factors["liquidity.stablecoin_mcap"] = {
      value: mcap, unit: "usd",
      score: normalizeStablecoinMcap(mcap),
      change_7d_pct: stablecoins.change7dPct ?? null,
      direction: mcap > 180e9 ? "bullish" : mcap < 100e9 ? "bearish" : "neutral",
      confidence: 0.85, source_tier: 3, computed_at: computedAt
    };
  }
  if (stablecoins?.change7dPct !== null && stablecoins?.change7dPct !== undefined) {
    factors["liquidity.stablecoin_change_7d"] = {
      value: stablecoins.change7dPct, unit: "pct",
      score: normalizeStablecoinChange7d(stablecoins.change7dPct),
      direction: stablecoins.change7dPct > 1 ? "bullish" : stablecoins.change7dPct < -1 ? "bearish" : "neutral",
      confidence: 0.8, source_tier: 3, computed_at: computedAt
    };
  }

  const defi = rawData.liquidityIntel?.defi;
  if (defi?.totalTvlUsd !== null && defi?.totalTvlUsd !== undefined) {
    const tvl = Number(defi.totalTvlUsd);
    factors["liquidity.defi_tvl"] = {
      value: tvl, unit: "usd",
      score: normalizeTvl(tvl),
      change_7d_pct: defi.change7dPct ?? null,
      direction: tvl > 100e9 ? "bullish" : tvl < 50e9 ? "bearish" : "neutral",
      confidence: 0.85, source_tier: 3, computed_at: computedAt
    };
  }

  // ── 資金流向 ─────────────────────────────────────────────────
  const metrics = rawData.cryptoSignalMetrics7d || {};
  if (metrics.etfNetFlowUsd !== undefined && metrics.etfNetFlowUsd !== 0) {
    const flow = Number(metrics.etfNetFlowUsd);
    const etfConfidence = String(metrics.etfFlowSource || "").includes("news") ? 0.55 : 0.92;
    factors["flows.etf_net_flow_7d"] = {
      value: flow, unit: "usd",
      score: normalizeEtfFlow7d(flow),
      source_detail: metrics.etfFlowSource || "unknown",
      direction: flow > 200e6 ? "bullish" : flow < -200e6 ? "bearish" : "neutral",
      confidence: etfConfidence, source_tier: etfConfidence > 0.8 ? 2 : 4, computed_at: computedAt
    };
  }

  // ── 衍生品 / 槓桿 ────────────────────────────────────────────
  if (metrics.liquidationTotalUsd > 0) {
    const liq = Number(metrics.liquidationTotalUsd);
    const liqConfidence = metrics.liquidationSource === "coinalyze" ? 0.95
      : metrics.liquidationSource?.includes("exchange") ? 0.8 : 0.5;
    factors["derivatives.liquidation_7d"] = {
      value: liq, unit: "usd",
      score: normalizeLiquidation7d(liq),
      source_detail: metrics.liquidationSource || "unknown",
      direction: liq > 700e6 ? "bearish" : liq < 200e6 ? "neutral" : "caution",
      confidence: liqConfidence, source_tier: liqConfidence > 0.9 ? 2 : 4, computed_at: computedAt
    };
  }

  // ── 訊號偏向 ─────────────────────────────────────────────────
  const cryptoSignals = rawData.cryptoSignals || [];
  const cryptoBull = cryptoSignals.filter((s) => s.shortTermBias === "偏漲").length;
  const cryptoBear = cryptoSignals.filter((s) => s.shortTermBias === "偏跌").length;
  if (cryptoBull + cryptoBear > 0) {
    factors["signals.crypto_bias"] = {
      value: normalizeSignalBias(cryptoBull, cryptoBear),
      unit: "score", score: normalizeSignalBias(cryptoBull, cryptoBear),
      bull_count: cryptoBull, bear_count: cryptoBear,
      direction: cryptoBull > cryptoBear ? "bullish" : cryptoBear > cryptoBull ? "bearish" : "neutral",
      confidence: Math.min(0.7, 0.3 + (cryptoBull + cryptoBear) * 0.05),
      source_tier: 4, computed_at: computedAt
    };
  }

  const globalRiskSignals = rawData.globalRiskSignals || [];
  const riskBear = globalRiskSignals.filter((s) => s.shortTermBias === "偏跌").length;
  const riskBull = globalRiskSignals.filter((s) => s.shortTermBias === "偏漲").length;
  if (riskBull + riskBear > 0) {
    factors["risk.geopolitical_bias"] = {
      value: normalizeSignalBias(riskBull, riskBear),
      unit: "score", score: normalizeSignalBias(riskBull, riskBear),
      bull_count: riskBull, bear_count: riskBear,
      direction: riskBear > riskBull ? "bearish" : riskBull > riskBear ? "bullish" : "neutral",
      confidence: 0.5, source_tier: 4, computed_at: computedAt
    };
  }

  const policySignals = rawData.policySignals || [];
  const polBull = policySignals.filter((s) => s.shortTermBias === "偏漲").length;
  const polBear = policySignals.filter((s) => s.shortTermBias === "偏跌").length;
  if (polBull + polBear > 0) {
    factors["risk.regulatory_bias"] = {
      value: normalizeSignalBias(polBull, polBear),
      unit: "score", score: normalizeSignalBias(polBull, polBear),
      bull_count: polBull, bear_count: polBear,
      direction: polBull > polBear ? "bullish" : polBear > polBull ? "bearish" : "neutral",
      confidence: 0.65, source_tier: 3, computed_at: computedAt
    };
  }

  // ── 衍生品（Coinglass）────────────────────────────────────────
  const cg = rawData.coinglassDerivatives;
  if (cg?.available) {
    const fr = cg.fundingRate;
    if (fr?.rate8h !== undefined && fr?.rate8h !== null) {
      const frScore = normalizeFundingRate(fr.rate8h);
      factors["derivatives.btc_funding_rate"] = {
        value: fr.rate8hPct,       // 百分比形式（0.01 = 0.01%）
        unit: "pct_8h",
        score: frScore,
        annualized_pct: fr.annualizedPct,
        direction: fr.direction,   // "bullish" | "bearish" | "neutral"
        exchange: fr.exchange,
        // 高正費率（多頭過熱）看跌；高負費率（空頭過熱）看漲
        confidence: 0.95, source_tier: 2, computed_at: computedAt
      };
    }

    const oi = cg.openInterest;
    if (oi?.totalUsd) {
      factors["derivatives.btc_open_interest"] = {
        value: oi.totalUsd,
        unit: "usd",
        // OI 本身不直接代表方向，用 change 判斷
        score: oi.change4hPct !== null
          ? clamp(oi.change4hPct / 3.0)  // ±3% 4h 變化 = 強訊號
          : 0,
        change_4h_pct: oi.change4hPct,
        direction: oi.direction,
        confidence: 0.95, source_tier: 2, computed_at: computedAt
      };
    }
  }

  // ── 高衝擊事件窗口 ───────────────────────────────────────────
  const macroEvents = rawData.macroEvents || [];
  const now = Date.now();
  const h24 = 24 * 60 * 60 * 1000;
  const upcoming24h = macroEvents.filter((e) =>
    e.status === "upcoming" && e.importance === "high" &&
    new Date(e.datetime).getTime() - now < h24 &&
    new Date(e.datetime).getTime() > now
  );
  const upcoming7d = macroEvents.filter((e) =>
    e.status === "upcoming" && e.importance === "high" &&
    new Date(e.datetime).getTime() > now &&
    new Date(e.datetime).getTime() - now < 7 * h24
  );
  factors["event.high_impact_24h"] = {
    value: upcoming24h.length > 0, unit: "bool",
    score: upcoming24h.length > 0 ? -0.5 : 0, // 事件前夕通常增加不確定性
    events: upcoming24h.map((e) => e.title),
    direction: upcoming24h.length > 0 ? "caution" : "neutral",
    confidence: 0.95, source_tier: 1, computed_at: computedAt
  };
  factors["event.high_impact_7d_count"] = {
    value: upcoming7d.length, unit: "count",
    score: 0, // 純計數，不直接評分
    events: upcoming7d.map((e) => e.title),
    direction: "neutral",
    confidence: 0.95, source_tier: 1, computed_at: computedAt
  };

  return factors;
}
