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

// ── 8. VIX / DXY ─────────────────────────────────────────────────

/**
 * CBOE VIX 恐慌指數
 * 高 VIX = 市場恐慌 = 看跌（負分）
 * VIX < 15 = 過度樂觀（complacent，輕微負分）
 * 參考基準：18 = 中性；30 = 強烈看跌；40 = 極端
 */
export function normalizeVix(vixValue) {
  if (!Number.isFinite(vixValue)) return null;
  // 18 為中性，每上升 12 點 = 向下 1.0
  return clamp(-(vixValue - 18) / 12);
}

/**
 * 美元指數 DXY
 * 強美元 = 風險資產承壓 = 對加密看跌（負分）
 * 參考基準：100 = 中性，107 = 強（-1.0），93 = 弱（+1.0）
 */
export function normalizeDxy(dxyValue) {
  if (!Number.isFinite(dxyValue)) return null;
  // 以 100 為中性，±7 = ±1.0
  return clamp(-(dxyValue - 100) / 7);
}

// ── 9. Coinglass 多空比 / CVD ─────────────────────────────────────

/**
 * 全球多空比反指標（Global Long/Short Account Ratio）
 * longPct 範圍 0~1（0.5 = 50% 帳戶做多）
 * 反指標：多頭比例越高 → 市場過熱 → 看跌（負分）
 * 參考基準：0.5 = 中性；0.6 = 過多；0.4 = 過空
 */
export function normalizeLongShortRatio(longPct) {
  if (!Number.isFinite(longPct)) return null;
  // 以 0.5 為中性，偏離 0.1（10%）= 極端
  return clamp(-(longPct - 0.5) / 0.1);
}

/**
 * Taker 買賣量淨值（CVD proxy）
 * netPct: 淨買量佔總量的比例（-100% ~ +100%）
 * 正 = 主動買壓 = 看漲
 * 參考基準：±5% = 明顯偏向；±15% = 強烈訊號
 */
export function normalizeTakerCvd(netPct) {
  if (!Number.isFinite(netPct)) return null;
  return clamp(netPct / 15);
}

// ── 9. 主函數：從 rawData 建立完整 factor vector ─────────────────

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
 *     computed_at: "ISO"   // fetch time：normalize.js 執行當下的時間（非資料本身的時間）
 *   },
 *   ...
 * }
 */
export function buildFactorVector(rawData) {
  const fetchTime = new Date().toISOString(); // 抓取時間（非資料本身的時間）
  const factors = {};

  // ── 利率 ─────────────────────────────────────────────────────
  const ratesLatest = rawData.ratesIntel?.latest || {};
  const y10y = ratesLatest.y10y ?? null;
  const y2y = ratesLatest.y2y ?? null;
  const y3m = ratesLatest.y3m ?? null;
  const effr = ratesLatest.effr ?? null;
  const spread2s10s = ratesLatest.spread10y2y ?? null;

  if (y10y !== null) {
    factors["macro.yield_10y"] = {
      value: y10y, unit: "pct",
      score: normalizeYield10y(y10y),
      direction: y10y > 4.5 ? "bearish" : y10y < 3.0 ? "bullish" : "neutral",
      confidence: 0.98, source_tier: 1, computed_at: fetchTime
    };
  }
  if (y2y !== null) {
    factors["macro.yield_2y"] = {
      value: y2y, unit: "pct",
      score: normalizeYield10y(y2y),
      direction: "neutral",
      confidence: 0.98, source_tier: 1, computed_at: fetchTime
    };
  }
  if (y3m !== null) {
    factors["macro.yield_3m"] = {
      value: y3m, unit: "pct",
      score: normalizeYield10y(y3m),
      direction: "neutral",
      confidence: 0.98, source_tier: 1, computed_at: fetchTime
    };
  }
  if (effr !== null) {
    factors["macro.fed_funds_rate"] = {
      value: effr, unit: "pct",
      score: 0,   // 中性（EFFR 本身不直接計分，由 comment.js 用於推算降息概率）
      direction: "neutral",
      confidence: 0.99, source_tier: 1, computed_at: fetchTime
    };
  }
  if (spread2s10s !== null) {
    const spreadScore = normalizeYieldSpread(spread2s10s);
    factors["macro.yield_spread_2s10s"] = {
      value: spread2s10s, unit: "pct",
      score: spreadScore,
      direction: spread2s10s < 0 ? "inverted" : "normal",
      confidence: 0.98, source_tier: 1, computed_at: fetchTime
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
      confidence: 0.9, source_tier: 3, computed_at: fetchTime
    };
  }

  const globalData = rawData.marketIntel?.global;
  if (globalData?.btcDominancePct !== null && globalData?.btcDominancePct !== undefined) {
    const dom = Number(globalData.btcDominancePct);
    factors["sentiment.btc_dominance"] = {
      value: dom, unit: "pct",
      score: normalizeBtcDominance(dom),
      direction: dom > 55 ? "defensive" : dom < 45 ? "altseason" : "neutral",
      confidence: 0.9, source_tier: 3, computed_at: fetchTime
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
      confidence: 0.85, source_tier: 3, computed_at: fetchTime
    };
  }
  if (stablecoins?.change7dPct !== null && stablecoins?.change7dPct !== undefined) {
    factors["liquidity.stablecoin_change_7d"] = {
      value: stablecoins.change7dPct, unit: "pct",
      score: normalizeStablecoinChange7d(stablecoins.change7dPct),
      direction: stablecoins.change7dPct > 1 ? "bullish" : stablecoins.change7dPct < -1 ? "bearish" : "neutral",
      confidence: 0.8, source_tier: 3, computed_at: fetchTime
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
      confidence: 0.85, source_tier: 3, computed_at: fetchTime
    };
  }

  // ── 資金流向 ─────────────────────────────────────────────────
  // 優先使用 Coinglass ETF flow（tier 2，confidence 0.92）
  const cgEtf = rawData.coinglassDerivatives?.etfFlow7d;
  const metrics = rawData.cryptoSignalMetrics7d || {};
  if (cgEtf?.netUsd !== undefined && cgEtf.tradingDays > 0) {
    const flow = cgEtf.netUsd;
    factors["flows.etf_net_flow_7d"] = {
      value: flow, unit: "usd",
      score: normalizeEtfFlow7d(flow),
      source_detail: cgEtf.source,
      trading_days: cgEtf.tradingDays,
      latest_date: cgEtf.latestDate,
      direction: flow > 200e6 ? "bullish" : flow < -200e6 ? "bearish" : "neutral",
      confidence: 0.92, source_tier: 2, computed_at: fetchTime
    };
  } else if (metrics.etfNetFlowUsd !== undefined && metrics.etfNetFlowUsd !== 0) {
    // fallback：新聞解析
    const flow = Number(metrics.etfNetFlowUsd);
    const etfConfidence = Number.isFinite(metrics.etfFlowConfidence) ? metrics.etfFlowConfidence : 0.55;
    factors["flows.etf_net_flow_7d"] = {
      value: flow, unit: "usd",
      score: normalizeEtfFlow7d(flow),
      source_detail: metrics.etfFlowSource || "unknown",
      direction: flow > 200e6 ? "bullish" : flow < -200e6 ? "bearish" : "neutral",
      confidence: etfConfidence, source_tier: etfConfidence > 0.8 ? 2 : 4, computed_at: fetchTime
    };
  }

  // ── 衍生品 / 槓桿 ────────────────────────────────────────────
  // 優先使用 Coinglass 聚合清算（tier 2，confidence 0.9）
  const cgLiq = rawData.coinglassDerivatives?.liquidation7d;
  if (cgLiq?.totalUsd > 0) {
    const liq = cgLiq.totalUsd;
    factors["derivatives.liquidation_7d"] = {
      value: liq, unit: "usd",
      score: normalizeLiquidation7d(liq),
      source_detail: cgLiq.source,
      exchanges: cgLiq.exchanges,
      direction: liq > 700e6 ? "bearish" : liq < 200e6 ? "neutral" : "caution",
      confidence: 0.9, source_tier: 2, computed_at: fetchTime
    };
  } else if (metrics.liquidationTotalUsd > 0) {
    // fallback：舊的 Coinalyze / 新聞解析
    const liq = Number(metrics.liquidationTotalUsd);
    const liqConfidence = Number.isFinite(metrics.liquidationConfidence) ? metrics.liquidationConfidence : 0.5;
    factors["derivatives.liquidation_7d"] = {
      value: liq, unit: "usd",
      score: normalizeLiquidation7d(liq),
      source_detail: metrics.liquidationSource || "unknown",
      direction: liq > 700e6 ? "bearish" : liq < 200e6 ? "neutral" : "caution",
      confidence: liqConfidence, source_tier: liqConfidence > 0.9 ? 2 : 4, computed_at: fetchTime
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
      source_tier: 4, computed_at: fetchTime
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
      confidence: 0.5, source_tier: 4, computed_at: fetchTime
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
      confidence: 0.65, source_tier: 3, computed_at: fetchTime
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
        direction: fr.direction,       // "bullish" | "bearish" | "neutral"（當前費率方向）
        trend: fr.trend ?? "flat",            // "rising" | "falling" | "flat"
        trend_direction: fr.trend_direction ?? "neutral", // 費率趨勢的多空含義
        exchange: fr.exchange,
        // 高正費率（多頭過熱）看跌；高負費率（空頭過熱）看漲
        confidence: 0.95, source_tier: 2, computed_at: fetchTime
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
        confidence: 0.95, source_tier: 2, computed_at: fetchTime
      };
    }

    // ── 多空比 / CVD ──────────────────────────────────────────
    const ls = cg.longShortRatio;
    if (ls?.longPct !== undefined && ls?.longPct !== null) {
      factors["derivatives.btc_long_short_ratio"] = {
        value: ls.longPct,
        unit: "ratio",           // 0~1，做多帳戶佔比
        score: normalizeLongShortRatio(ls.longPct),
        long_pct: Number((ls.longPct * 100).toFixed(2)),
        short_pct: Number(((ls.shortPct ?? 1 - ls.longPct) * 100).toFixed(2)),
        ls_ratio: ls.lsRatio,
        direction: ls.direction,
        // 反指標：多頭過多看跌，空頭過多看漲（tier 2 = 機構 API）
        confidence: 0.88, source_tier: 2, computed_at: fetchTime
      };
    }

    const tv = cg.takerVolume;
    if (tv?.netPct !== undefined && tv?.netPct !== null) {
      factors["derivatives.btc_taker_cvd"] = {
        value: tv.netUsd,
        unit: "usd",
        score: normalizeTakerCvd(tv.netPct),
        net_pct: tv.netPct,
        buy_volume_usd: tv.buyVolumeUsd,
        sell_volume_usd: tv.sellVolumeUsd,
        direction: tv.direction,
        confidence: 0.88, source_tier: 2, computed_at: fetchTime
      };
    }
  }

  // ── Deribit 選擇權 Put/Call Ratio ────────────────────────────
  const deribit = rawData.deribitOptions;
  if (deribit?.available && deribit.putCallOiRatio !== null && deribit.putCallOiRatio !== undefined) {
    const pcr = Number(deribit.putCallOiRatio);
    // Put/Call OI 比：低（多 call）= 看漲；高（多 put）= 下行對沖 = 看跌
    // 注意：極低 PCR 也可能是過熱反轉信號，但以趨勢為主
    const pcrScore = pcr <= 0.5  ?  0.8   // 大量看漲部位
      : pcr <= 0.7  ?  0.5
      : pcr <= 0.9  ?  0.2
      : pcr <= 1.1  ?  0.0
      : pcr <= 1.3  ? -0.4
      : pcr <= 1.5  ? -0.7
      :               -1.0;              // 恐慌性對沖
    factors["derivatives.btc_put_call_ratio"] = {
      value:          pcr,
      unit:           "ratio",
      score:          Number(pcrScore.toFixed(4)),
      put_call_vol_ratio: deribit.putCallVolRatio,
      direction:      deribit.direction,
      total_put_oi:   deribit.totalPutOI,
      total_call_oi:  deribit.totalCallOI,
      instrument_count: deribit.instrumentCount,
      confidence:     0.88, source_tier: 2, computed_at: fetchTime
    };

    // ── 近月 ATM 隱含波動率（IV）────────────────────────────────
    if (deribit.btc_iv !== null && deribit.btc_iv !== undefined) {
      const iv = Number(deribit.btc_iv);
      // IV 正常範圍約 30~150%。高 IV = 恐慌/大行情預期 = 偏看跌；低 IV = 平靜 = 偏看漲
      // 閾值：< 40% 平靜 (+0.4)，40~60% 普通 (0)，60~80% 升溫 (-0.3)，> 80% 高恐慌 (-0.7)
      const ivScore = iv < 40  ?  0.4
        : iv < 55  ?  0.1
        : iv < 70  ? -0.2
        : iv < 90  ? -0.5
        :            -0.8;
      factors["derivatives.btc_iv"] = {
        value:      iv,
        unit:       "pct_annualized",  // 年化 IV%（如 60.5 = 60.5%）
        score:      Number(ivScore.toFixed(4)),
        // 高 IV 反映市場恐慌或強烈不確定性，通常 bearish；極端高 IV 後反彈概率上升但先跌
        direction:  iv < 55 ? "low_vol" : iv < 75 ? "elevated" : "high_vol",
        confidence: 0.80, source_tier: 2, computed_at: fetchTime
      };
    }
  }

  // ── VIX / DXY ────────────────────────────────────────────────
  const vd = rawData.vixDxy;
  if (vd?.available) {
    if (vd.vix?.value !== undefined && vd.vix?.value !== null) {
      factors["macro.vix"] = {
        value: vd.vix.value,
        unit: "index",
        score: normalizeVix(vd.vix.value),
        level: vd.vix.level,
        change_pct: vd.vix.changePct,
        direction: vd.vix.direction,
        confidence: 0.95, source_tier: 1, computed_at: fetchTime
      };
    }
    if (vd.dxy?.value !== undefined && vd.dxy?.value !== null) {
      factors["macro.dxy"] = {
        value: vd.dxy.value,
        unit: "index",
        score: normalizeDxy(vd.dxy.value),
        change_pct: vd.dxy.changePct,
        direction: vd.dxy.direction,
        confidence: 0.95, source_tier: 1, computed_at: fetchTime
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
    confidence: 0.95, source_tier: 1, computed_at: fetchTime
  };
  factors["event.high_impact_7d_count"] = {
    value: upcoming7d.length, unit: "count",
    score: 0, // 純計數，不直接評分
    events: upcoming7d.map((e) => e.title),
    direction: "neutral",
    confidence: 0.95, source_tier: 1, computed_at: fetchTime
  };

  // ── §4.2 多幣種價格動量 factors（crypto.momentum.{sym}.*）──────────────
  // 來源：momentumCollector（Binance 公開 API，每 5 分鐘 TTL）
  // 支援：BTC、ETH、SOL、XRP
  // 核心修正：regime engine 原本缺這一整個維度，無法偵測「恐慌中反彈」
  //
  // allMomentum 結構：{ BTC: {...}, ETH: {...}, SOL: {...}, XRP: {...} }
  // 向後相容：若只有 btcMomentum，自動包裝成 allMomentum
  const allMomentum = rawData.allMomentum || (rawData.btcMomentum ? { BTC: rawData.btcMomentum } : {});

  for (const [sym, mom] of Object.entries(allMomentum)) {
    if (!mom?.available) continue;
    const symLower = sym.toLowerCase();

    if (Number.isFinite(mom.return24h)) {
      factors[`crypto.momentum.${symLower}.return_24h`] = {
        value: mom.return24h, unit: "pct",
        score: mom.scores.return_24h,
        direction: mom.return24h > 1 ? "bullish" : mom.return24h < -1 ? "bearish" : "neutral",
        confidence: 0.95, source_tier: 1, computed_at: fetchTime
      };
    }
    if (Number.isFinite(mom.return7d)) {
      factors[`crypto.momentum.${symLower}.return_7d`] = {
        value: mom.return7d, unit: "pct",
        score: mom.scores.return_7d,
        direction: mom.return7d > 2 ? "bullish" : mom.return7d < -2 ? "bearish" : "neutral",
        confidence: 0.95, source_tier: 1, computed_at: fetchTime
      };
    }
    if (Number.isFinite(mom.return30d)) {
      factors[`crypto.momentum.${symLower}.return_30d`] = {
        value: mom.return30d, unit: "pct",
        score: mom.scores.return_30d,
        direction: mom.return30d > 5 ? "bullish" : mom.return30d < -5 ? "bearish" : "neutral",
        confidence: 0.95, source_tier: 1, computed_at: fetchTime
      };
    }
    if (mom.scores.ma_position !== null) {
      factors[`crypto.momentum.${symLower}.ma_position`] = {
        value: mom.ma50pos,
        unit: "pct_from_ma",
        score: mom.scores.ma_position,
        ma50: mom.ma50,
        ma200: mom.ma200,
        ma50pos: mom.ma50pos,
        ma200pos: mom.ma200pos,
        direction: mom.scores.ma_position > 0.1 ? "bullish" : mom.scores.ma_position < -0.1 ? "bearish" : "neutral",
        confidence: 0.95, source_tier: 1, computed_at: fetchTime
      };
    }
    if (Number.isFinite(mom.rsi14)) {
      factors[`crypto.momentum.${symLower}.rsi_14d`] = {
        value: mom.rsi14, unit: "index",
        score: mom.scores.rsi_14d,
        direction: mom.rsi14 < 35 ? "oversold" : mom.rsi14 > 65 ? "overbought" : "neutral",
        confidence: 0.92, source_tier: 1, computed_at: fetchTime
      };
    }
  }

  // ── §4.3 多幣種衍生品 factor（crypto.derivatives.{sym}.*）────────────────
  // 來源：coinglassPerSymbol collector（30 分鐘 TTL）
  // 這些 factor 不計入 composite_score（不修改 composite.js 權重），
  // 但寫入 factor_snapshots 供下游交易系統直接讀取。
  const cgPs = rawData.coinglassPerSymbol;
  if (cgPs?.available && cgPs.symbols) {
    for (const [SYM, data] of Object.entries(cgPs.symbols)) {
      const sym = SYM.toLowerCase(); // key 用小寫：btc, eth, sol...
      if (!data?.available) continue;

      // funding_rate
      if (data.fundingRate?.rate8h !== undefined && data.fundingRate.rate8h !== null) {
        const fr     = data.fundingRate;
        const score  = normalizeFundingRate(fr.rate8h);
        factors[`crypto.derivatives.${sym}.funding_rate`] = {
          value:       fr.rate8hPct,
          unit:        "pct_8h",
          score,
          direction:   fr.direction,
          confidence:  0.90,
          source_tier: 1,
          computed_at: fetchTime,
          exchange:    "Binance"
        };
      }

      // open_interest（change-based score）
      if (data.openInterest?.totalUsd !== undefined && data.openInterest.totalUsd !== null) {
        const oi = data.openInterest;
        const oiScore = oi.change4hPct !== null
          ? clamp(oi.change4hPct / 3.0)
          : null;
        factors[`crypto.derivatives.${sym}.open_interest`] = {
          value:       oi.totalUsd,
          unit:        "usd",
          score:       oiScore,
          change_4h_pct: oi.change4hPct,
          direction:   oi.direction,
          confidence:  oiScore !== null ? 0.85 : 0.60,
          source_tier: 1,
          computed_at: fetchTime
        };
      }

      // long_short_ratio
      if (data.longShortRatio?.longPct !== undefined && data.longShortRatio.longPct !== null) {
        const ls = data.longShortRatio;
        factors[`crypto.derivatives.${sym}.long_short_ratio`] = {
          value:       ls.longPct,
          unit:        "ratio",
          score:       normalizeLongShortRatio(ls.longPct),
          long_pct:    Number((ls.longPct * 100).toFixed(2)),
          short_pct:   Number(((ls.shortPct ?? 1 - ls.longPct) * 100).toFixed(2)),
          direction:   ls.direction,
          confidence:  0.85,
          source_tier: 1,
          computed_at: fetchTime,
          exchange:    "Binance"
        };
      }

      // taker_cvd
      if (data.takerVolume?.netPct !== undefined && data.takerVolume.netPct !== null) {
        const tv = data.takerVolume;
        factors[`crypto.derivatives.${sym}.taker_cvd`] = {
          value:         tv.netUsd,
          unit:          "usd",
          score:         normalizeTakerCvd(tv.netPct),
          net_pct:       tv.netPct,
          buy_volume_usd:  tv.buyVolumeUsd,
          sell_volume_usd: tv.sellVolumeUsd,
          direction:     tv.direction,
          confidence:    0.80,
          source_tier:   1,
          computed_at:   fetchTime,
          exchange:      "Binance"
        };
      }
    }
  }

  return factors;
}
