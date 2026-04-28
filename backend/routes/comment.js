/**
 * comment.js — GET /api/comment  + GET /api/comment/history
 *
 * 詮釋層（Interpretation Layer）：「現在是什麼狀態？為什麼？」
 *
 * 職責分離：
 *   /api/news    → 事實層（發生了什麼）
 *   /api/comment → 詮釋層（現在是什麼狀態）← 這裡
 *   client       → 決策層（我該做什麼）
 *
 * 設計原則：
 *  - 規則型計算，不呼叫 LLM
 *  - 每次呼叫時實時計算（從 factor_snapshots 讀最新資料）
 *  - 結果寫入 macro_comments 表（永久歷史，backtest 用）
 *  - 不下交易決策（禁止出現 buy/sell/enter/exit/long/short）
 *  - structured（regime/risk/drivers）與 narrative（headline）一致
 */

import { Router } from "express";
import { db } from "../database.js";
import { getLatestFactors, getFactorHistory } from "../../v1/src/lib/sqlite.js";

const router = Router();

// ── Inverse factor cache（validation-driven score flip）───────────
// Reads latest validation_results type=factors to find inverse factors.
// Inverse: when normalized_score↑, forward return↓ → multiply by -1 before regime use.
// Cache refreshes every 30 minutes to pick up new validation runs.
let _inverseFactorCache = null;
let _inverseFactorCacheMs = 0;

function getInverseFactorSet() {
  const now = Date.now();
  if (_inverseFactorCache !== null && now - _inverseFactorCacheMs < 30 * 60_000) {
    return _inverseFactorCache;
  }
  try {
    const row = db.prepare(`
      SELECT result_json FROM validation_results
      WHERE type = 'factors'
      ORDER BY computed_at DESC LIMIT 1
    `).get();
    if (!row) {
      _inverseFactorCache = new Set();
    } else {
      const data = JSON.parse(row.result_json);
      _inverseFactorCache = new Set(
        (data.inverse_factors ?? []).map(f => f.factor_key)
      );
    }
  } catch {
    _inverseFactorCache = new Set();
  }
  _inverseFactorCacheMs = now;
  return _inverseFactorCache;
}

// Flip score sign for factors empirically shown to be inverse predictors.
// Only applied inside regime/scores computation — display values remain unchanged.
function adjScore(score, key, inverseSet) {
  if (score === null || score === undefined) return null;
  return inverseSet.has(key) ? -score : score;
}

// ── Helpers ────────────────────────────────────────────────────────

function toFactorMap(rows) {
  const map = {};
  for (const row of rows) {
    map[row.factor_key] = {
      score: row.normalized_score,
      value: row.raw_value,
      direction: row.direction,
      computed_at: row.computed_at
    };
  }
  return map;
}

function safeScore(factors, key) {
  const f = factors[key];
  if (!f || f.score === null || f.score === undefined) return null;
  return f.score;
}

function safeValue(factors, key) {
  const f = factors[key];
  if (!f || f.value === null || f.value === undefined) return null;
  return f.value;
}

// snapshot_id: snap_YYYYMMDD_HHMM（每 5 分鐘一個 bucket）
function makeSnapshotId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = now.getUTCFullYear();
  const mo = pad(now.getUTCMonth() + 1);
  const d  = pad(now.getUTCDate());
  const h  = pad(now.getUTCHours());
  const min = pad(Math.floor(now.getUTCMinutes() / 5) * 5); // 5 分鐘 bucket
  return `snap_${y}${mo}${d}_${h}${min}`;
}

// ── Macro Regime 計算 ─────────────────────────────────────────────
//
// 六種 regime：
//   easing_early      利率開始下降，Fed 轉向，經濟仍正常
//   easing_late       利率持續下降，流動性充裕，風險資產強
//   tightening_early  利率上升中，殖利率曲線尚正，壓力初現
//   tightening_late   利率高位，殖利率曲線倒掛，衰退風險
//   neutral           混合訊號
//   shock             極端市場事件（VIX 爆衝、地緣危機）
//
// 輸入 factors（score 為 [-1,+1]，value 為原始數值）：
//   macro.vix               VIX 水準（score 負 = VIX 高）
//   macro.yield_spread_2s10s 殖利率曲線（score 負 = 倒掛）
//   macro.yield_10y          10Y 殖利率（score 負 = 高利率）
//   macro.dxy               美元指數（score 負 = DXY 高，流動性緊）

function computeMacroRegime(factors) {
  const vixScore    = safeScore(factors, "macro.vix");
  const spreadScore = safeScore(factors, "macro.yield_spread_2s10s");
  const yield10yScore = safeScore(factors, "macro.yield_10y");
  const dxyScore    = safeScore(factors, "macro.dxy");

  const vixValue    = safeValue(factors, "macro.vix");

  // 計算 coverage（有多少訊號可用）
  const signals = [vixScore, spreadScore, yield10yScore, dxyScore].filter(v => v !== null);
  if (signals.length === 0) {
    return { label: "neutral", confidence: 0.1, stability_24h: null, coverage: 0 };
  }

  // ── Shock 判斷（優先）───────────────────────────────────────────
  // VIX > 35 或 VIX score < -0.7（正規化後極端低）
  if ((vixValue !== null && vixValue > 35) || (vixScore !== null && vixScore < -0.7)) {
    const confidence = vixScore !== null ? Math.min(0.9, 0.6 + Math.abs(vixScore) * 0.3) : 0.6;
    return { label: "shock", confidence: Number(confidence.toFixed(2)), stability_24h: null, coverage: signals.length / 4 };
  }

  // ── 利率環境指標綜合分 ───────────────────────────────────────────
  // 正值 = 寬鬆（bullish for rate cycle）
  // 負值 = 緊縮（bearish for rate cycle）
  let rateScore = 0;
  let rateSignals = 0;
  if (spreadScore !== null) { rateScore += spreadScore * 1.5; rateSignals++; } // 殖利率曲線權重較高
  if (yield10yScore !== null) { rateScore += yield10yScore;  rateSignals++; }
  if (dxyScore !== null)     { rateScore += dxyScore * 0.5;  rateSignals++; } // DXY 權重較低

  const avgRate = rateSignals > 0 ? rateScore / rateSignals : 0;
  const vixPressure = vixScore !== null ? -vixScore : 0; // vixScore 負 = VIX 高 = 壓力大

  // 綜合指數（正=寬鬆環境，負=緊縮環境）
  const envScore = avgRate - vixPressure * 0.3;

  // ── Regime 分類 + 動態 Confidence ────────────────────────────────
  // confidence 三個維度：
  //   1. 訊號強度（envScore 在分類區域的深度）
  //   2. 訊號一致性（各子訊號 std dev，越低越一致）
  //   3. 覆蓋率（有多少訊號可用）
  const signalMean = signals.reduce((a, b) => a + b, 0) / signals.length;
  const signalStd  = signals.length > 1
    ? Math.sqrt(signals.reduce((s, v) => s + (v - signalMean) ** 2, 0) / signals.length)
    : 0;
  // consistency: 0=訊號互相矛盾, 1=方向完全一致
  const consistency = Math.max(0, 1 - signalStd * 1.5);

  let label, confidence;

  if (envScore > 0.3) {
    label = (spreadScore !== null && spreadScore > 0.2) ? "easing_late" : "easing_early";
    const depth = Math.min(1, (envScore - 0.3) / 0.5);  // 0=剛過門檻, 1=深入寬鬆(0.8)
    const confirmBonus = label === "easing_late" ? 0.05 : 0;
    confidence = 0.52 + depth * 0.18 + consistency * 0.12 + confirmBonus;
  } else if (envScore < -0.3) {
    label = (spreadScore !== null && spreadScore < -0.2) ? "tightening_late" : "tightening_early";
    const depth = Math.min(1, (-envScore - 0.3) / 0.5);
    const confirmBonus = label === "tightening_late" ? 0.05 : 0;
    confidence = 0.54 + depth * 0.18 + consistency * 0.12 + confirmBonus;
  } else {
    // neutral: 訊號越接近 0 且越一致 → confidence 越高（真正中性）
    //          訊號互相對消假性中性 → confidence 低
    label = "neutral";
    const neutralCenter = (0.3 - Math.abs(envScore)) / 0.3;  // 1=envScore=0, 0=envScore=±0.3
    confidence = 0.28 + consistency * 0.18 + neutralCenter * 0.14;
  }

  const coverageBonus = (signals.length / 4) * 0.08;
  confidence = Number(Math.min(0.92, confidence + coverageBonus).toFixed(2));

  // 計算 24h 穩定性：過去 24h macro_comments 中有多少比例是同一 label
  let stability_24h = null;
  try {
    const since24h = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const hist = db.prepare(`
      SELECT macro_regime_label FROM macro_comments
      WHERE computed_at >= ? ORDER BY computed_at DESC
    `).all(since24h);
    if (hist.length >= 1) {
      const sameCount = hist.filter(r => r.macro_regime_label === label).length;
      stability_24h = Number((sameCount / hist.length).toFixed(2));
    }
  } catch { /* ignore */ }

  return {
    label,
    confidence,
    stability_24h,
    coverage: Number((signals.length / 4).toFixed(2))
  };
}

// ── Global Risk 計算 ──────────────────────────────────────────────
//
// level: low / moderate / elevated / high / extreme
// scores: tail_risk（fat tail 事件機率）、geopolitical_stress、liquidity_stress

function computeGlobalRisk(factors) {
  const vixScore    = safeScore(factors, "macro.vix");
  const geoScore    = safeScore(factors, "risk.geopolitical_bias");
  const regScore    = safeScore(factors, "risk.regulatory_bias");
  const liqScore    = safeScore(factors, "liquidity.stablecoin_change_7d");
  const vixValue    = safeValue(factors, "macro.vix");
  const yield10yVal = safeValue(factors, "macro.yield_10y");

  // ── 地緣政治壓力（0-1，越高越緊張）──────────────────────────────
  // geoScore 負 = bearish = 地緣緊張；轉換為壓力分數
  const geopoliticalStress = geoScore !== null
    ? Number(Math.max(0, Math.min(1, 0.5 - geoScore * 0.5)).toFixed(2))
    : 0.3; // 無資料時預設中度

  // ── 流動性壓力（0-1）────────────────────────────────────────────
  // 穩定幣流出 = 流動性緊縮；liqScore 負 = 流出
  const liquidityStress = liqScore !== null
    ? Number(Math.max(0, Math.min(1, 0.5 - liqScore * 0.5)).toFixed(2))
    : 0.2;

  // ── VIX 貢獻（0-1）──────────────────────────────────────────────
  let vixStress = 0.2;
  if (vixValue !== null) {
    if      (vixValue > 40) vixStress = 0.9;
    else if (vixValue > 30) vixStress = 0.75;
    else if (vixValue > 25) vixStress = 0.6;
    else if (vixValue > 20) vixStress = 0.4;
    else                    vixStress = 0.15;
  } else if (vixScore !== null) {
    vixStress = Number(Math.max(0, Math.min(1, 0.3 - vixScore * 0.5)).toFixed(2));
  }

  // ── 利率尾端風險（10Y > 4.5 視為有壓力）────────────────────────
  let rateTailRisk = 0;
  if (yield10yVal !== null) {
    rateTailRisk = yield10yVal > 5.0 ? 0.7
      : yield10yVal > 4.5 ? 0.5
      : yield10yVal > 4.0 ? 0.3
      : 0.1;
  }

  // ── 尾端風險綜合分 ───────────────────────────────────────────────
  const tailRiskScore = Number(Math.min(1,
    vixStress * 0.35 +
    geopoliticalStress * 0.30 +
    rateTailRisk * 0.20 +
    liquidityStress * 0.15
  ).toFixed(2));

  // ── 風險等級 ─────────────────────────────────────────────────────
  let level;
  if      (tailRiskScore >= 0.75) level = "extreme";
  else if (tailRiskScore >= 0.55) level = "high";
  else if (tailRiskScore >= 0.38) level = "elevated";
  else if (tailRiskScore >= 0.22) level = "moderate";
  else                            level = "low";

  // ── 主要驅動因子（給 narrative 用）──────────────────────────────
  const drivers = [];
  if (geopoliticalStress > 0.55) drivers.push("地緣政治壓力升高");
  if (vixValue !== null && vixValue > 25) drivers.push(`VIX ${vixValue.toFixed(1)} 偏高`);
  if (yield10yVal !== null && yield10yVal > 4.5) drivers.push(`10Y 殖利率 ${yield10yVal.toFixed(2)}% 處於高位`);
  if (liquidityStress > 0.55) drivers.push("穩定幣流出，流動性收縮");
  if (regScore !== null && regScore < -0.3) drivers.push("監管環境偏緊");
  if (drivers.length === 0) drivers.push("整體風險環境平穩");

  return {
    level,
    tail_risk_score: tailRiskScore,
    geopolitical_stress: geopoliticalStress,
    liquidity_stress: liquidityStress,
    drivers
  };
}

// ── Macro Drivers 結構 ────────────────────────────────────────────

function buildMacroDrivers(factors) {
  const yield10y = safeValue(factors, "macro.yield_10y");
  const yield2y  = safeValue(factors, "macro.yield_2y");
  const yield3m  = safeValue(factors, "macro.yield_3m");
  const spread   = safeValue(factors, "macro.yield_spread_2s10s");
  const dxy      = safeValue(factors, "macro.dxy");
  const vix      = safeValue(factors, "macro.vix");

  // fed_path：從殖利率曲線 + EFFR 推算 Fed 立場與降息概率
  //
  // rate_cut_prob_3m 估算方法：
  //   EFFR（有效聯邦基金利率）vs 3M T-bill 的利差，
  //   反映市場在未來 3 個月對聯儲降息的定價。
  //   公式：prob = clamp(0.05, 0.95, (effr - yield3m) / 0.50)
  //   0.50 = 2 次降息（3 個月通常有 2 次 FOMC）× 25bps/次
  //   資料來源：FRED DFF + DGS3MO（非 CME FedWatch）
  const fedPath = (() => {
    const effr = safeValue(factors, "macro.fed_funds_rate");
    let stance = "data_dependent";
    if (spread !== null) {
      if (spread < -0.5)      stance = "easing_bias";
      else if (spread > 0.5)  stance = "neutral";
      else if (spread < -0.1) stance = "data_dependent";
    }
    const frontBackspread = (yield3m !== null && yield10y !== null)
      ? Number((yield10y - yield3m).toFixed(2)) : null;

    let rateCutProb3m = null;
    if (effr !== null && yield3m !== null) {
      const spreadToEffr = effr - yield3m;    // pct；正 = 市場定價降息
      rateCutProb3m = Math.round(
        Math.min(0.95, Math.max(0.05, spreadToEffr / 0.50)) * 100
      ) / 100;
    }

    return {
      rate_cut_prob_3m: rateCutProb3m,
      effr: effr !== null ? Number(effr.toFixed(2)) : null,
      stance,
      inversion_depth_2s10s: spread !== null ? Number(spread.toFixed(2)) : null,
      front_back_spread_3m10y: frontBackspread,
      note: rateCutProb3m !== null
        ? "T-bill implied (FRED DFF vs DGS3MO); not CME FedWatch"
        : "derived from yield curve shape; EFFR not yet loaded"
    };
  })();

  return {
    yields: {
      us_10y: yield10y,
      us_2y:  yield2y,
      us_3m:  yield3m,
      spread_2s10s: spread,
      regime: spread !== null
        ? (spread > 0.3 ? "steepening" : spread < -0.2 ? "inverted" : "flat")
        : null
    },
    dxy: dxy !== null ? {
      value: dxy,
      z_score: null // 需歷史資料計算，暫 null
    } : null,
    vix: vix !== null ? {
      value: vix,
      regime: vix > 30 ? "extreme" : vix > 20 ? "expanding" : "low"
    } : null,
    fed_path: fedPath
  };
}

// ── Narrative 生成（規則型模板）──────────────────────────────────
//
// 從 structured 結果生成人類可讀的標題與摘要。
// narrative 永遠從 structured 衍生，不可互相矛盾。

function buildNarrative(regime, globalRisk, factors) {
  const regimeLabels = {
    easing_early:     "寬鬆初段",
    easing_late:      "寬鬆後段",
    tightening_early: "緊縮初段",
    tightening_late:  "緊縮後段",
    neutral:          "中性盤整",
    shock:            "市場衝擊"
  };

  const riskLabels = {
    low:      "低",
    moderate: "中",
    elevated: "偏高",
    high:     "高",
    extreme:  "極端"
  };

  const regLabel = regimeLabels[regime.label] || regime.label;
  const riskLabel = riskLabels[globalRisk.level] || globalRisk.level;

  // 標題：一句話描述當前狀態
  let headline;
  if (regime.label === "shock") {
    headline = `市場衝擊模式：${globalRisk.drivers[0] || "極端波動"}，風險資產承壓`;
  } else if (globalRisk.level === "elevated" || globalRisk.level === "high" || globalRisk.level === "extreme") {
    headline = `${regLabel}疊加${riskLabel}風險，跨資產環境謹慎`;
  } else {
    headline = `宏觀環境處於${regLabel}，整體風險${riskLabel}`;
  }

  // 摘要：從 drivers 組合
  const driverStr = globalRisk.drivers.slice(0, 3).join("；");
  const summary = `當前宏觀 regime 為「${regLabel}」，整體風險等級「${riskLabel}」。主要驅動：${driverStr}。`;

  // 關鍵觀察點（從 factor 方向歸納）
  const keyObs = [];
  const vixVal = safeValue(factors, "macro.vix");
  const yield10yVal = safeValue(factors, "macro.yield_10y");
  const spreadVal = safeValue(factors, "macro.yield_spread_2s10s");
  const geoScore = safeScore(factors, "risk.geopolitical_bias");

  if (vixVal !== null) keyObs.push(`VIX ${vixVal.toFixed(1)}（${vixVal > 25 ? "波動偏高" : "波動正常"}）`);
  if (yield10yVal !== null) keyObs.push(`美 10Y 殖利率 ${yield10yVal.toFixed(2)}%`);
  if (spreadVal !== null) keyObs.push(`2s10s 利差 ${spreadVal > 0 ? "+" : ""}${spreadVal.toFixed(2)}%（${spreadVal < 0 ? "曲線倒掛" : "正常"}）`);
  if (geoScore !== null && geoScore < -0.3) keyObs.push("地緣政治風險偏高，監控中東 / 關稅情勢");

  // 需要關注的項目（coming events + ongoing risks）
  const whatToWatch = [];
  if (regime.label === "tightening_late" || regime.label === "tightening_early") {
    whatToWatch.push("Fed 下次利率決議及會後聲明");
    whatToWatch.push("CPI / PCE 通膨數據");
  }
  if (globalRisk.geopolitical_stress > 0.5) {
    whatToWatch.push("地緣政治事件進展");
  }
  if (vixVal !== null && vixVal > 20) {
    whatToWatch.push("VIX 期限結構變化");
  }
  whatToWatch.push("ETF 資金流向（近 7 日淨流量）");

  return { headline, summary, key_observations: keyObs, what_to_watch: whatToWatch, language: "zh-Hant" };
}

// ── 寫入 SQLite ───────────────────────────────────────────────────

function saveComment(snapshotId, computedAt, regime, globalRisk, narrative, fullJson) {
  try {
    db.prepare(`
      INSERT INTO macro_comments
        (snapshot_id, computed_at, macro_regime_label, macro_regime_confidence,
         global_risk_level, global_risk_score, narrative_headline, full_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_id) DO UPDATE SET
        full_json = excluded.full_json,
        narrative_headline = excluded.narrative_headline
    `).run(
      snapshotId, computedAt,
      regime.label, regime.confidence,
      globalRisk.level, globalRisk.tail_risk_score,
      narrative.headline,
      JSON.stringify(fullJson)
    );
  } catch (e) {
    console.warn("[comment] SQLite write failed:", e.message);
  }
}

// ── GET /api/comment ──────────────────────────────────────────────

router.get("/", (_req, res) => {
  const factorRows = getLatestFactors();

  if (factorRows.length === 0) {
    return res.status(404).json({
      error: "No factor data available. Run the update script first.",
      hint: "node v1/scripts/update-data.mjs"
    });
  }

  const factors = toFactorMap(factorRows);
  const now = new Date();
  const computedAt = now.toISOString();
  const snapshotId = makeSnapshotId(now);

  const regime      = computeMacroRegime(factors);
  const globalRisk  = computeGlobalRisk(factors);
  const macroDrivers = buildMacroDrivers(factors);
  const narrative   = buildNarrative(regime, globalRisk, factors);

  const availableAssetClasses = [
    { key: "crypto",   endpoint: "/api/comment/crypto",   status: "live",     last_computed_at: computedAt },
    { key: "us_stock", endpoint: "/api/comment/us_stock", status: "roadmap" },
    { key: "tw_stock", endpoint: "/api/comment/tw_stock", status: "roadmap" }
  ];

  const limitations = [
    "macro_regime 使用規則型計算（rule_based），不含 LLM 分析",
    "geopolitical_stress 來自 RSS 詞袋評分，方向性參考",

    "yield / VIX 數據延遲視 collector 更新頻率而定"
  ];

  const comment = {
    computed_at: computedAt,
    snapshot_id: snapshotId,
    comment_version: "v1.0.0",
    engine: "rule_based",
    macro_regime: {
      label: regime.label,
      candidates: ["easing_early","easing_late","tightening_early","tightening_late","neutral","shock"],
      confidence: regime.confidence,
      stability_24h: regime.stability_24h
    },
    macro_drivers: macroDrivers,
    global_risk: globalRisk,
    narrative,
    available_asset_classes: availableAssetClasses,
    limitations
  };

  saveComment(snapshotId, computedAt, regime, globalRisk, narrative, comment);

  res.json(comment);
});

// ── GET /api/comment/history ──────────────────────────────────────

router.get("/history", (req, res) => {
  const limitNum = Math.min(Number(req.query.limit) || 100, 1000);
  const from = req.query.from || null;
  const to   = req.query.to   || null;

  const conditions = [];
  const params = [];
  if (from) { conditions.push("computed_at >= ?"); params.push(from); }
  if (to)   { conditions.push("computed_at <= ?"); params.push(to); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db.prepare(`
    SELECT snapshot_id, computed_at, macro_regime_label, macro_regime_confidence,
           global_risk_level, global_risk_score, narrative_headline
    FROM macro_comments
    ${where}
    ORDER BY computed_at DESC
    LIMIT ?
  `).all(...params, limitNum);

  res.json({ count: rows.length, history: rows });
});

// ════════════════════════════════════════════════════════════════════
// CRYPTO COMMENT ENGINE
// ════════════════════════════════════════════════════════════════════

/**
 * Crypto Regime Labels:
 *   risk_on              多頭主導，資金流入，情緒積極
 *   risk_on_transition   由觀望轉向風險偏好
 *   neutral_drift        無明確方向，多空交雜
 *   risk_off_transition  由中性轉向避險
 *   risk_off             空頭主導，資金流出，情緒悲觀
 *   leverage_flush       強制去槓桿，清算事件主導
 *
 * §4.2 修正：加入價格動量 factors，讓 regime 能偵測「恐慌中反彈」模式
 * §4.4 修正：F&G 極端值加入 contrarian 邏輯（極恐 + 價格上漲 ≠ risk_off）
 * §4.5 修正：識別 accumulation / distribution / wall_of_worry pattern
 */
function computeCryptoRegime(factors, macroRegime) {
  const fgScore    = safeScore(factors, "sentiment.fear_greed");
  const fgValue    = safeValue(factors, "sentiment.fear_greed");
  const cryptoBias = safeScore(factors, "signals.crypto_bias");
  const liqScore   = safeScore(factors, "derivatives.liquidation_7d");
  const liqValue   = safeValue(factors, "derivatives.liquidation_7d");
  const domScore   = safeScore(factors, "sentiment.btc_dominance");
  const stabChange = safeScore(factors, "liquidity.stablecoin_change_7d");
  const regScore   = safeScore(factors, "risk.regulatory_bias");

  // §4.2 動量 factors
  const return7d    = safeScore(factors, "crypto.momentum.btc.return_7d");
  const return24h   = safeScore(factors, "crypto.momentum.btc.return_24h");
  const return7dVal = safeValue(factors, "crypto.momentum.btc.return_7d");
  const maPos       = safeScore(factors, "crypto.momentum.btc.ma_position");
  const rsi14       = safeScore(factors, "crypto.momentum.btc.rsi_14d");

  // 衍生品動量（OI + funding）
  const oiScore      = safeScore(factors, "derivatives.btc_open_interest");
  const fundingScore = safeScore(factors, "derivatives.btc_funding_rate");
  const etfScore     = safeScore(factors, "flows.etf_net_flow_7d");

  // §RC: DB 即時資金費率 z-score + 清算確認（市場格局確認）
  // 從 factor_snapshots 讀取 poller 最新計算值（≤ 60 分鐘內有效）
  let dbFrZscore = null;   // normalized_score（負 = bearish）
  let dbFrRaw    = null;   // raw_value（資金費率）
  let dbLiq24h   = null;   // liquidation_24h normalized_score
  try {
    const cutoff60m = new Date(Date.now() - 60 * 60_000).toISOString();
    const frRow = db.prepare(`
      SELECT normalized_score, raw_value FROM factor_snapshots
      WHERE factor_key = 'crypto.derivatives.BTC.funding_rate_zscore'
        AND computed_at >= ?
      ORDER BY computed_at DESC LIMIT 1
    `).get(cutoff60m);
    if (frRow) { dbFrZscore = frRow.normalized_score; dbFrRaw = frRow.raw_value; }

    const liqRow = db.prepare(`
      SELECT normalized_score FROM factor_snapshots
      WHERE factor_key = 'crypto.derivatives.BTC.liquidation_7d'
        AND computed_at >= ?
      ORDER BY computed_at DESC LIMIT 1
    `).get(cutoff60m);
    if (liqRow) dbLiq24h = liqRow.normalized_score;
  } catch { /* ignore — DB may not have data yet */ }

  // RC 複合確認標誌
  // leverage_flush 強化：資金費率 z 偏高（多頭過熱 → score < -0.3）AND 清算評分偏空（< -0.2）
  const rcLeverageFlush = (dbFrZscore !== null && dbFrZscore < -0.3) &&
                          (dbLiq24h   !== null && dbLiq24h   < -0.2);
  // accumulation 確認：資金費率偏負（空頭付費 → score > 0.3）AND 清算不高（> -0.1）
  const rcAccumulation  = (dbFrZscore !== null && dbFrZscore > 0.3) &&
                          (dbLiq24h   === null || dbLiq24h > -0.1);

  const signals = [fgScore, cryptoBias, liqScore, domScore, stabChange, return7d].filter(v => v !== null);

  // ── 1. Leverage Flush（最優先 — 清算 > $500M 且方向偏空）────────
  // §RC 強化：資金費率 z-score 極高 + 清算偏空 → 更高確信度
  if (liqValue !== null && liqValue > 500_000_000 && liqScore !== null && liqScore < -0.2) {
    const baseConf  = Math.min(0.88, 0.6 + Math.abs(liqScore) * 0.3);
    const rcBoost   = rcLeverageFlush ? 0.08 : 0;   // RC 確認加分
    return {
      label: "leverage_flush",
      confidence: Number(Math.min(0.95, baseConf + rcBoost).toFixed(2)),
      trigger: `7D 清算 $${(liqValue / 1e6).toFixed(0)}M，強制去槓桿${rcLeverageFlush ? "（資金費率 RC 確認）" : ""}`,
      regime_hint: "leverage_flush"
    };
  }
  // §RC：資金費率極端過熱（即使清算值尚未達 $500M 門檻） → 早期 leverage_flush 警示
  if (rcLeverageFlush && liqScore !== null && liqScore < -0.4) {
    return {
      label: "leverage_flush",
      confidence: 0.72,
      trigger: `資金費率 z-score 極高 + 清算偏空（RC 早期確認）`,
      regime_hint: "leverage_flush"
    };
  }

  // ── 2. §4.4 F&G contrarian 調整 ────────────────────────────────
  // 極度恐慌（< 25）+ 價格仍在上漲 → 反轉訊號，不是 risk_off
  // 極度貪婪（> 75）+ 價格上漲放緩 → 過熱警示
  let contrarianAdj = 0;
  if (fgValue !== null && fgValue < 25) {
    contrarianAdj = +0.30;  // 歷史上極端恐慌往往是底部
  } else if (fgValue !== null && fgValue > 75) {
    contrarianAdj = -0.30;  // 歷史上極端貪婪往往是頂部
  }

  // ── 3. §4.5 Pattern 識別 ──────────────────────────────────────
  // 先算衍生品組合分數
  const derivParts = [oiScore, fundingScore, etfScore].filter(v => v !== null);
  const derivAvg = derivParts.length > 0
    ? derivParts.reduce((s, v) => s + v, 0) / derivParts.length
    : null;

  let regimeHint = null;
  if (derivAvg !== null && fgValue !== null) {
    if (derivAvg > 0.7 && fgValue < 25) {
      regimeHint = "accumulation";   // 聰明錢建倉，散戶恐慌
    } else if (derivAvg < -0.7 && fgValue > 75) {
      regimeHint = "distribution";   // 聰明錢出貨，散戶貪婪
    }
  }
  // §RC accumulation 確認：資金費率偏負（空頭付費）+ 清算不高 → 更強確認
  if (rcAccumulation && regimeHint === null) {
    regimeHint = "accumulation";   // 資金費率 RC 確認 accumulation
  }
  if (return7dVal !== null && fgValue !== null) {
    if (return7dVal > 3 && fgValue < 40) {
      regimeHint = regimeHint || "wall_of_worry"; // 爬憂慮之牆
    } else if (return7dVal < -3 && fgValue > 60) {
      regimeHint = regimeHint || "bull_trap";     // 多頭陷阱
    }
  }

  // ── §CC: news_sentiment contrarian 訊號（接入 classifier context）─
  // 根據 classifier context 數據（2026-04-16）：
  //   entity:trump bearish  → hit 4.2%，BTC +2.16%（極強 contrarian）
  //   entity:iran  bearish  → hit 17.4%，BTC +1.60%（contrarian）
  //   trade_policy bearish  → hit 6.1%，BTC +1.90%（contrarian）
  //   central_bank bullish  → hit 71.8%，BTC +1.05%（正向訊號）
  // 策略：bearish 新聞中若主要由 contrarian 類別主導 → 反向加分
  let newsSentimentAdj = 0;
  try {
    const recentNews24h = db.prepare(`
      SELECT content FROM jin10_news
      WHERE published_at > datetime('now', '-24 hours')
      LIMIT 50
    `).all();

    let trumpBear = 0, iranBear = 0, tradeBear = 0, cbBull = 0;
    const TRUMP_RX = /trump|川普|特朗普/i;
    const IRAN_RX  = /iran|伊朗/i;
    const TRADE_RX = /tariff|关税|贸易战|trade war|加征|制裁.*中/i;
    const CB_BULL_RX = /降息|rate cut|easing|dovish|鸽派/i;

    for (const row of recentNews24h) {
      const c = row.content || "";
      const dir = quickDirectionEn(c);
      if (dir === "bearish" || dir === "ambiguous") {
        if (TRUMP_RX.test(c)) trumpBear++;
        if (IRAN_RX.test(c))  iranBear++;
        if (TRADE_RX.test(c)) tradeBear++;
      }
      if (dir === "bullish" && CB_BULL_RX.test(c)) cbBull++;
    }

    // contrarian 訊號：貿易/Trump/Iran 利空 → 加多 0.1 ~ 0.3
    const contrarianItems = trumpBear + iranBear + tradeBear;
    if (contrarianItems >= 3) newsSentimentAdj = Math.min(0.3, contrarianItems * 0.05);
    // 央行鴿派（真正利多）→ 加分
    if (cbBull >= 3) newsSentimentAdj += Math.min(0.2, cbBull * 0.04);
  } catch { /* ignore */ }

  // ── 4. 組合分數（正 = 偏多，負 = 偏空）────────────────────────
  const inverseSet = getInverseFactorSet();
  let compositeScore = 0;
  let totalWeight = 0;

  // §4.2 動量 factors（新增，高權重）
  if (return7d !== null)  { compositeScore += adjScore(return7d,  "crypto.momentum.btc.return_7d",  inverseSet) * 3.0; totalWeight += 3.0; }
  if (return24h !== null) { compositeScore += adjScore(return24h, "crypto.momentum.btc.return_24h", inverseSet) * 1.0; totalWeight += 1.0; }
  if (maPos !== null)     { compositeScore += adjScore(maPos,     "crypto.momentum.btc.ma_position", inverseSet) * 1.5; totalWeight += 1.5; }
  if (rsi14 !== null)     { compositeScore += adjScore(rsi14,     "crypto.momentum.btc.rsi_14d",    inverseSet) * 0.5; totalWeight += 0.5; }

  // §4.4 F&G：加 contrarian 調整後的分數（極端 F&G 不再直接做空）
  if (fgScore !== null) {
    const adjustedFg = Math.max(-1, Math.min(1, adjScore(fgScore, "sentiment.fear_greed", inverseSet) + contrarianAdj));
    compositeScore += adjustedFg * 2.0; totalWeight += 2.0;
  }
  // crypto_bias：最直接的新聞訊號
  if (cryptoBias !== null) { compositeScore += adjScore(cryptoBias, "signals.crypto_bias", inverseSet) * 2.5; totalWeight += 2.5; }
  // §CC: 新聞 contrarian 訊號（classifier context 驗證）
  if (newsSentimentAdj !== 0) { compositeScore += newsSentimentAdj; totalWeight += 1.0; }
  // stablecoin 流入
  if (stabChange !== null) { compositeScore += adjScore(stabChange, "liquidity.stablecoin_change_7d", inverseSet) * 1.5; totalWeight += 1.5; }
  // OI + funding（衍生品結構）
  if (oiScore !== null)      { compositeScore += adjScore(oiScore,      "derivatives.btc_open_interest", inverseSet) * 1.0; totalWeight += 1.0; }
  if (fundingScore !== null) { compositeScore += adjScore(fundingScore,  "derivatives.btc_funding_rate",  inverseSet) * 1.0; totalWeight += 1.0; }
  if (etfScore !== null)     { compositeScore += adjScore(etfScore,      "flows.etf_net_flow_7d",         inverseSet) * 1.0; totalWeight += 1.0; }
  // btc_dominance（輕微反指）
  if (domScore !== null) { compositeScore -= adjScore(domScore, "sentiment.btc_dominance", inverseSet) * 0.5; totalWeight += 0.5; }
  // regulatory
  if (regScore !== null) { compositeScore += adjScore(regScore, "risk.regulatory_bias", inverseSet) * 1.0; totalWeight += 1.0; }

  // macro context bonus
  if (macroRegime?.label === "shock")           compositeScore -= 1.0;
  else if (macroRegime?.label === "tightening_late") compositeScore -= 0.5;
  else if (macroRegime?.label === "easing_early")    compositeScore += 0.3;

  let avg = totalWeight > 0 ? compositeScore / totalWeight : 0;

  // §RC: 資金費率確認訊號直接調整綜合分數
  // rcAccumulation（負費率，空頭過度付費）歷史驗證：avg 7d +2.61%，hit 77.3%
  // → avg 加 +0.15（約可將 risk_off_transition 拉向 neutral，或 neutral 拉向 risk_on_transition）
  if (rcAccumulation)  avg = Math.min( 1.0, avg + 0.15);
  // rcLeverageFlush（正費率 z-score 過熱 + 清算偏空）→ 壓低
  if (rcLeverageFlush) avg = Math.max(-1.0, avg - 0.12);

  // ── 5. Regime 分類 + 動態 Confidence ──────────────────────────────
  // confidence = 訊號強度（avg 在區域的深度）+ 覆蓋率
  //   avg 越深入區域 → 越遠離翻轉門檻 → confidence 越高
  //   avg 剛過門檻 → 隨時可能翻轉 → confidence 較低
  let label, confidence;
  if (avg > 0.35) {
    label = "risk_on";
    const depth = Math.min(1, (avg - 0.35) / 0.45);       // 0=avg=0.35, 1=avg=0.8
    confidence = 0.60 + depth * 0.18;
  } else if (avg > 0.12) {
    label = "risk_on_transition";
    const depth = (avg - 0.12) / (0.35 - 0.12);           // 0=bottom, 1=top
    confidence = 0.50 + depth * 0.12;
  } else if (avg > -0.12) {
    label = "neutral_drift";
    const centerDist = Math.abs(avg) / 0.12;               // 0=中心, 1=邊界
    confidence = 0.46 - centerDist * 0.10;
  } else if (avg > -0.35) {
    label = "risk_off_transition";
    const depth = (-avg - 0.12) / (0.35 - 0.12);
    confidence = 0.50 + depth * 0.12;
  } else {
    label = "risk_off";
    const depth = Math.min(1, (-avg - 0.35) / 0.45);
    confidence = 0.60 + depth * 0.18;
  }

  // regime_hint accumulation 確認加成（縮小為 0.08，避免過度加分）
  if (regimeHint === "accumulation" && (label === "risk_on_transition" || label === "neutral_drift")) {
    confidence = Math.min(0.85, confidence + 0.08);
  }

  const coverageBonus = (signals.length / 6) * 0.10;
  confidence = Number(Math.min(0.92, confidence + coverageBonus).toFixed(2));

  return { label, confidence, trigger: null, regime_hint: regimeHint };
}

// ── §4.3 Factor Delta 計算（多時間框歷史基準）───────────────────────────────
//
// 從 factor_snapshots 讀取歷史記錄，計算特定時間點前的 score 當作基準
// 讓各 timeframe 看到的是「相對變化」而非同一份快照
//
// lookback map：
//   intraday  → 6h 前的基準
//   short     → 3d 前的基準
//   mid       → 14d 前的基準
//   long      → 30d 前的基準

const LOOKBACK_HOURS = { intraday: 6, short_term: 72, mid_term: 336, long_term: 720 };

/**
 * 從歷史取得特定 factor 在 N 小時前的 score
 * @returns {number|null}
 */
function getFactorNHoursAgo(factorKey, hoursAgo) {
  try {
    const cutoff = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    const row = db.prepare(`
      SELECT normalized_score FROM factor_snapshots
      WHERE factor_key = ? AND computed_at <= ?
      ORDER BY computed_at DESC LIMIT 1
    `).get(factorKey, cutoff);
    return row?.normalized_score ?? null;
  } catch {
    return null;
  }
}

/**
 * 計算一批 key 的 delta（當前 score − 過去 N 小時 score）
 * @param {object} currentFactors — 當前 factor map
 * @param {string[]} keys         — 要計算 delta 的 factor keys
 * @param {number} hoursAgo       — 基準時間點
 * @returns {object} { key: { current, past, delta } }
 */
function computeFactorDeltas(currentFactors, keys, hoursAgo) {
  const result = {};
  for (const key of keys) {
    const current = safeScore(currentFactors, key);
    if (current === null) continue;
    const past  = getFactorNHoursAgo(key, hoursAgo);
    const delta = past !== null ? Number((current - past).toFixed(4)) : null;
    result[key] = { current, past, delta };
  }
  return result;
}

/**
 * Crypto 短/中/長線分數計算
 * §4.2 更新：加入動量 factors（return_24h / return_7d / ma_position / rsi）
 * §4.3 框架：各時間框用不同 lookback 的 factor 組合
 *
 *   intraday  ← return_24h + crypto_bias + liq_1h（最近 4-6h 動態）
 *   short     ← return_7d + crypto_bias + stablecoin + funding（1-3d 趨勢）
 *   mid       ← ma_position + return_30d + stablecoin_mcap + tvl（1-2w）
 *   long      ← ma200_position + stablecoin_mcap + tvl（1m+）
 */
function computeCryptoScores(factors) {
  const inv = getInverseFactorSet();
  const fgScore    = safeScore(factors, "sentiment.fear_greed");
  const fgValue    = safeValue(factors, "sentiment.fear_greed");
  const cryptoBias = adjScore(safeScore(factors, "signals.crypto_bias"),           "signals.crypto_bias",             inv);
  const liqScore   = adjScore(safeScore(factors, "derivatives.liquidation_7d"),    "derivatives.liquidation_7d",      inv);
  const stabChange = adjScore(safeScore(factors, "liquidity.stablecoin_change_7d"),"liquidity.stablecoin_change_7d",  inv);
  const stabMcap   = adjScore(safeScore(factors, "liquidity.stablecoin_mcap"),     "liquidity.stablecoin_mcap",       inv);
  const tvlScore   = adjScore(safeScore(factors, "liquidity.defi_tvl"),            "liquidity.defi_tvl",              inv);
  const regScore   = adjScore(safeScore(factors, "risk.regulatory_bias"),          "risk.regulatory_bias",            inv);
  const pcRatio    = adjScore(safeScore(factors, "derivatives.btc_put_call_ratio"),"derivatives.btc_put_call_ratio",  inv);
  const ivScore    = adjScore(safeScore(factors, "derivatives.btc_iv"),            "derivatives.btc_iv",              inv);

  // §4.2 動量 factors
  const return24h = adjScore(safeScore(factors, "crypto.momentum.btc.return_24h"), "crypto.momentum.btc.return_24h", inv);
  const return7d  = adjScore(safeScore(factors, "crypto.momentum.btc.return_7d"),  "crypto.momentum.btc.return_7d",  inv);
  const return30d = adjScore(safeScore(factors, "crypto.momentum.btc.return_30d"), "crypto.momentum.btc.return_30d", inv);
  const maPos     = adjScore(safeScore(factors, "crypto.momentum.btc.ma_position"),"crypto.momentum.btc.ma_position",inv);
  const rsiScore  = adjScore(safeScore(factors, "crypto.momentum.btc.rsi_14d"),    "crypto.momentum.btc.rsi_14d",    inv);
  const ma200PosValue = safeValue(factors, "crypto.momentum.btc.ma_position");
  const maFactor  = factors["crypto.momentum.btc.ma_position"];
  const ma200pos  = maFactor?.ma200pos ?? null;

  // 衍生品結構（fallback: 集合 key → 單幣 BTC key，歷史回灌資料用後者）
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
  const etfScore     = adjScore(safeScore(factors, "flows.etf_net_flow_7d"),          "flows.etf_net_flow_7d",         inv);
  const liq1hScore   = adjScore(
    safeScore(factors, "crypto.derivatives.BTC.liquidation_1h") ?? safeScore(factors, "crypto.derivatives.btc.liquidation_1h"),
    "crypto.derivatives.BTC.liquidation_1h", inv
  );

  // §4.4 F&G contrarian（不做 inverse flip：contrarian logic 已內建非線性反指）
  const fgContrarian = (() => {
    if (fgValue === null) return 0;
    if (fgValue < 25)  return +0.3;
    if (fgValue > 75)  return -0.3;
    return 0;
  })();

  function labelScore(s) {
    if (s === null) return { direction: null, label: "無資料", confidence: 0 };
    if (s > 0.3)  return { direction: s, label: "偏多", confidence: 0.65 };
    if (s > 0.08) return { direction: s, label: "中性偏多", confidence: 0.55 };
    if (s > -0.08)return { direction: s, label: "中性", confidence: 0.45 };
    if (s > -0.3) return { direction: s, label: "中性偏空", confidence: 0.55 };
    return         { direction: s, label: "偏空", confidence: 0.65 };
  }

  function weightedAvg(pairs) {
    const valid = pairs.filter(p => p.v !== null && Number.isFinite(p.v));
    if (valid.length === 0) return null;
    const tw = valid.reduce((s, p) => s + p.w, 0);
    return valid.reduce((s, p) => s + p.v * p.w, 0) / tw;
  }

  // ── 日內（最近 4-6h 動態）─────────────────────────────────────
  const intraday = (() => {
    const raw = weightedAvg([
      { v: return24h,   w: 3.0 },
      { v: cryptoBias,  w: 2.0 },
      { v: liq1hScore,  w: 1.5 },
      { v: fgContrarian !== 0 ? fgContrarian : null, w: 1.0 }
    ]);
    if (raw === null) return null;
    const s = Number(Math.max(-1, Math.min(1, raw)).toFixed(3));
    const partCount = [return24h, cryptoBias, liq1hScore].filter(v => v !== null).length;
    return { ...labelScore(s), confidence: partCount >= 2 ? 0.68 : 0.45 };
  })();

  // ── 短線 1-3d（趨勢確認）──────────────────────────────────────
  const shortTerm = (() => {
    const fgAdj = fgScore !== null
      ? Math.max(-1, Math.min(1, adjScore(fgScore, "sentiment.fear_greed", inv) + fgContrarian))
      : null;
    const raw = weightedAvg([
      { v: return7d,     w: 1.0 },   // 3.0→1.0：落後動量，防 7d 均值回歸負 ρ
      { v: cryptoBias,   w: 2.0 },
      { v: stabChange,   w: 2.0 },   // 1.5→2.0：領先流量訊號
      { v: fundingScore, w: 2.5 },   // 1.0→2.5：驗證最強領先指標
      { v: oiScore,      w: 1.5 },   // 1.0→1.5
      { v: fgAdj,        w: 2.0 },   // 1.5→2.0：反指 contrarian
      { v: etfScore,     w: 1.5 }    // 1.0→1.5：機構資金流
    ]);
    if (raw === null) return null;
    const s = Number(Math.max(-1, Math.min(1, raw)).toFixed(3));
    const partCount = [return7d, cryptoBias, stabChange, fundingScore].filter(v => v !== null).length;
    return { ...labelScore(s), confidence: partCount >= 2 ? 0.72 : 0.50 };
  })();

  // ── 中線 1-2w（趨勢方向）─────────────────────────────────────
  const midTerm = (() => {
    const raw = weightedAvg([
      { v: maPos,        w: 2.0 },   // 3.0→2.0：落後，降低主導性
      { v: return30d,    w: 1.0 },   // 2.0→1.0：趨勢背景參考
      { v: stabMcap,     w: 1.5 },
      { v: tvlScore,     w: 1.0 },
      { v: regScore,     w: 1.0 },
      { v: fundingScore, w: 2.0 },   // NEW：中期衍生品領先信號
      { v: etfScore,     w: 1.5 },   // NEW：機構資金（中期結構代理）
      { v: pcRatio,      w: 0.5 }
    ]);
    if (raw === null) return null;
    const s = Number(Math.max(-1, Math.min(1, raw)).toFixed(3));
    const partCount = [maPos, return30d, stabMcap, tvlScore].filter(v => v !== null).length;
    return { ...labelScore(s), confidence: partCount >= 2 ? 0.60 : 0.40 };
  })();

  // ── 長線 1m+（結構性趨勢）──────────────────────────────────────
  // MA200 位置 + stablecoin_mcap level + TVL（流動性基礎）
  const longTerm = (() => {
    // 用 MA200 的相對位置（比 MA50 更長期）
    const ma200score = Number.isFinite(ma200pos)
      ? Math.max(-1, Math.min(1, ma200pos / 30))  // ±30% from MA200 = ±1
      : maPos;  // fallback 到 maPos
    const raw = weightedAvg([
      { v: ma200score, w: 3.0 },
      { v: stabMcap,   w: 2.0 },
      { v: tvlScore,   w: 1.5 },
      { v: return30d,  w: 1.0 }
    ]);
    if (raw === null) return null;
    const s = Number(Math.max(-1, Math.min(1, raw)).toFixed(3));
    const partCount = [ma200score, stabMcap, tvlScore].filter(v => v !== null).length;
    return { ...labelScore(s), confidence: partCount >= 2 ? 0.55 : 0.35 };
  })();

  return { intraday, short_term: shortTerm, mid_term: midTerm, long_term: longTerm };
}

// ── news_sentiment 計算 ───────────────────────────────────────────────────────
//
// v2.4 修正：改用我們自己的 direction_en 分類器（而非 jin10 原始 direction）
// 原因：jin10 direction 欄位大多為「中性」，bearish_ratio 長期偏低（~5%），失去統計意義
// 修正後：用輕量版分類器對 content 即時分類，bearish_ratio ≈ 35%（符合 v2.3.0 實測值）

/**
 * quickDirectionEn: 輕量版 direction_en 分類器（供 news_sentiment 使用）
 * 不需要完整的 classifyDirectionV2 精度，只需快速判斷利空/利多/中性
 */
function quickDirectionEn(text = "") {
  const t = text.toLowerCase();
  let bearScore = 0, bullScore = 0;

  // 利空關鍵詞（w=3）
  for (const kw of ["爆倉","清算","暴跌","崩盤","崩盘","崩溃","crash","collapse","liquidat"]) {
    if (t.includes(kw)) bearScore += 3;
  }
  // 利空關鍵詞（w=2）
  for (const kw of ["加息","收緊","收紧","鷹派","鹰派","hawkish","tightening","rate hike",
                    "禁止","制裁","ban","crackdown","sanction","關稅","关税","tariff","trade war",
                    "戰爭","战争","衝突","冲突","war","conflict","missile","airstrike","空袭",
                    "封锁","中断","袭击","衰退","recession","军事打击","流出","外流","抛售",]) {
    if (t.includes(kw)) bearScore += 2;
  }
  // 利空關鍵詞（w=1）
  for (const kw of ["下跌","下滑","走低","回落","承壓","承压","風險","风险","擔憂","担忧",
                    "利空","悲觀","悲观","壓力","压力","fell","drop","slump","bearish"]) {
    if (t.includes(kw)) bearScore += 1;
  }
  // 利多關鍵詞（w=3）
  for (const kw of ["etf批准","etf approved","比特币战略储备","减半","halving","all-time high","ath"]) {
    if (t.includes(kw)) bullScore += 3;
  }
  // 利多關鍵詞（w=2）
  for (const kw of ["降息","寬鬆","宽松","鴿派","鸽派","dovish","easing","rate cut",
                    "批准","approved","approval","流入","買入","买入","增持","inflow",
                    "刺激","stimulus","pivot","注资","暴漲","暴涨","突破","rally","surge"]) {
    if (t.includes(kw)) bullScore += 2;
  }
  // 利多關鍵詞（w=1）
  for (const kw of ["利好","樂觀","乐观","上漲","上涨","反彈","反弹","看涨","走高","回暖","复苏"]) {
    if (t.includes(kw)) bullScore += 1;
  }

  // 否定句調整
  if (/(不|未|沒有|没有|暂不|不打算|无意)\S{0,6}(降息|寬鬆|宽松|鴿派|鸽派)/.test(t)) bullScore = Math.max(0, bullScore - 2);
  if (/(不|未|沒有|没有|暂不|不打算|无意)\S{0,6}(加息|收緊|收紧|禁止|制裁)/.test(t)) bearScore = Math.max(0, bearScore - 2);

  if (bearScore === 0 && bullScore === 0) return "neutral";
  if (Math.min(bearScore, bullScore) >= 2 && Math.abs(bearScore - bullScore) <= 1) return "ambiguous";
  if (bearScore > bullScore) return "bearish";
  if (bullScore > bearScore) return "bullish";
  return "neutral";
}

function buildNewsSentiment() {
  try {
    const now24h = db.prepare(`
      SELECT content FROM jin10_news
      WHERE published_at > datetime('now', '-24 hours')
    `).all();

    const prev24h = db.prepare(`
      SELECT content FROM jin10_news
      WHERE published_at > datetime('now', '-48 hours')
        AND published_at <= datetime('now', '-24 hours')
    `).all();

    function calcRatios(rows) {
      if (rows.length === 0) return { total: 0, bearish: 0, bullish: 0, neutral: 0, bearish_ratio: null, bullish_ratio: null };
      let bearish = 0, bullish = 0;
      for (const r of rows) {
        const d = quickDirectionEn(r.content || "");
        if (d === "bearish" || d === "ambiguous") bearish++;
        else if (d === "bullish") bullish++;
      }
      const total   = rows.length;
      const neutral = total - bearish - bullish;
      return {
        total,
        bearish,
        bullish,
        neutral,
        bearish_ratio: Number((bearish / total).toFixed(3)),
        bullish_ratio: Number((bullish / total).toFixed(3))
      };
    }

    const cur  = calcRatios(now24h);
    const prev = calcRatios(prev24h);

    if (cur.total === 0) return null;

    const bearishRatio = cur.bearish_ratio;
    const shiftVs48h   = (prev.bearish_ratio !== null)
      ? Number((bearishRatio - prev.bearish_ratio).toFixed(3))
      : null;

    // sentiment regime
    let regime;
    if      (bearishRatio >= 0.70) regime = "panic";
    else if (bearishRatio >= 0.50) regime = "fear";
    else if (bearishRatio >= 0.35) regime = "cautious";
    else if (cur.bullish_ratio >= 0.40) regime = "euphoria";
    else                           regime = "calm";

    // contrarian：bearish_ratio > 0.70 歷史上是底部訊號（確認需更多回測）
    const contrarianSignal = bearishRatio > 0.70;

    return {
      regime,
      total_24h:          cur.total,
      bearish_count_24h:  cur.bearish,
      bullish_count_24h:  cur.bullish,
      bearish_ratio_24h:  bearishRatio,
      bullish_ratio_24h:  cur.bullish_ratio,
      shift_vs_48h:       shiftVs48h,
      contrarian_signal:  contrarianSignal,
      classifier: "direction_en_v2.4_inline",
      note: "v2.4: 改用 direction_en 分類器（非 jin10 原始 direction）。contrarian_signal 需更多歷史回測確認。"
    };
  } catch {
    return null;
  }
}

// ── trigger_news_ids 輔助 ────────────────────────────────────────────────────
const FACTOR_NEWS_KEYWORDS = {
  "sentiment.fear_greed":           ["恐慌", "貪婪", "fear", "greed", "極度"],
  "derivatives.liquidation_7d":     ["清算", "爆倉", "強平", "liquidat", "margin call"],
  "liquidity.stablecoin_change_7d": ["穩定幣", "stablecoin", "USDT", "USDC", "BUSD"],
  "sentiment.btc_dominance":        ["主導率", "dominance", "山寨", "altcoin", "altseason"],
  "derivatives.btc_put_call_ratio": ["選擇權", "options", "put/call", "put call", "期權"],
  "liquidity.defi_tvl":             ["DeFi", "TVL", "鏈上", "去中心化", "協議"],
  "risk.regulatory_bias":           ["監管", "regulation", "SEC", "CFTC", "合規", "執法", "禁止"],
};

function getNewsTriggers(factorKey, limit = 3) {
  const keywords = FACTOR_NEWS_KEYWORDS[factorKey];
  if (!keywords || keywords.length === 0) return [];
  try {
    const conditions = keywords.map(() => "content LIKE ?").join(" OR ");
    const params = keywords.map(k => `%${k}%`);
    const rows = db.prepare(
      `SELECT id FROM jin10_news
       WHERE (${conditions})
         AND published_at > datetime('now', '-48 hours')
       ORDER BY published_at DESC
       LIMIT ${limit}`
    ).all(...params);
    return rows.map(r => r.id);
  } catch { return []; }
}

/**
 * Crypto asset_specific_drivers：列出最主要的貢獻因子
 * 每個 driver 含 key、value、contribution、comment
 */
function buildCryptoDrivers(factors) {
  const bullish = [];
  const bearish = [];

  // ── §4.2 BTC 動量 ────────────────────────────────────────────────
  const ret7dVal  = safeValue(factors, "crypto.momentum.btc.return_7d");
  const ret24hVal = safeValue(factors, "crypto.momentum.btc.return_24h");
  const rsi14Val  = safeValue(factors, "crypto.momentum.btc.rsi_14d");
  const ret7dScore = safeScore(factors, "crypto.momentum.btc.return_7d");
  if (ret7dVal !== null) {
    const entry = {
      key: "crypto.momentum.btc.return_7d",
      value: ret7dVal,
      score: ret7dScore,
      comment: Math.abs(ret7dVal) < 1 ? `BTC 7D 漲跌幅 ${ret7dVal > 0 ? "+" : ""}${ret7dVal.toFixed(1)}%（橫盤整理）`
        : ret7dVal > 0 ? `BTC 7D 上漲 +${ret7dVal.toFixed(1)}%${ret7dVal > 5 ? "，強勢動量" : ""}`
        : `BTC 7D 下跌 ${ret7dVal.toFixed(1)}%${ret7dVal < -5 ? "，動量偏空" : ""}`,
      trigger_news_ids: []
    };
    if (ret7dVal > 0) bullish.push(entry);
    else              bearish.push(entry);
  }
  if (rsi14Val !== null) {
    const rsiEntry = {
      key: "crypto.momentum.btc.rsi_14d",
      value: rsi14Val,
      score: safeScore(factors, "crypto.momentum.btc.rsi_14d"),
      comment: rsi14Val < 30 ? `RSI(14) ${rsi14Val.toFixed(0)} — 超賣區，歷史底部機率較高`
        : rsi14Val > 70 ? `RSI(14) ${rsi14Val.toFixed(0)} — 超買區，注意短線過熱`
        : `RSI(14) ${rsi14Val.toFixed(0)} — 正常區間`,
      trigger_news_ids: []
    };
    // RSI < 30 是看漲訊號（超賣）；RSI > 70 是看跌訊號（超買）
    if (rsi14Val < 40) bullish.push(rsiEntry);
    else if (rsi14Val > 65) bearish.push(rsiEntry);
  }

  // ── 情緒指標 ─────────────────────────────────────────────────────
  const fgValue = safeValue(factors, "sentiment.fear_greed");
  const fgScore = safeScore(factors, "sentiment.fear_greed");
  if (fgValue !== null) {
    const entry = {
      key: "sentiment.fear_greed",
      value: fgValue,
      score: fgScore,
      comment: fgValue < 20 ? `極度恐慌（${fgValue}）— 歷史上常見底部區域`
        : fgValue < 40 ? `恐慌（${fgValue}）— 市場悲觀`
        : fgValue > 75 ? `極度貪婪（${fgValue}）— 短線過熱警示`
        : fgValue > 60 ? `貪婪（${fgValue}）— 情緒積極`
        : `中性（${fgValue}）`,
      trigger_news_ids: getNewsTriggers("sentiment.fear_greed")
    };
    if (fgScore > 0) bullish.push(entry);
    else             bearish.push(entry);
  }

  // ── 清算 ─────────────────────────────────────────────────────────
  const liqValue = safeValue(factors, "derivatives.liquidation_7d");
  const liqScore = safeScore(factors, "derivatives.liquidation_7d");
  if (liqValue !== null) {
    bearish.push({
      key: "derivatives.liquidation_7d",
      value: liqValue,
      score: liqScore,
      comment: liqValue > 1_000_000_000 ? `7D 清算 $${(liqValue/1e9).toFixed(1)}B — 大規模去槓桿`
        : liqValue > 300_000_000 ? `7D 清算 $${(liqValue/1e6).toFixed(0)}M — 中等清算壓力`
        : `7D 清算 $${(liqValue/1e6).toFixed(0)}M — 清算壓力正常`,
      trigger_news_ids: getNewsTriggers("derivatives.liquidation_7d")
    });
  }

  // ── 穩定幣流向 ───────────────────────────────────────────────────
  const stabChange = safeScore(factors, "liquidity.stablecoin_change_7d");
  const stabChangeVal = safeValue(factors, "liquidity.stablecoin_change_7d");
  if (stabChange !== null) {
    const entry = {
      key: "liquidity.stablecoin_change_7d",
      value: stabChangeVal,
      score: stabChange,
      comment: stabChange > 0.1 ? `穩定幣 7D 供應 +${(stabChangeVal ?? 0).toFixed(2)}% — 乾火藥流入`
        : stabChange < -0.1 ? `穩定幣 7D 供應 ${(stabChangeVal ?? 0).toFixed(2)}% — 流動性撤出`
        : `穩定幣供應小幅變動`,
      trigger_news_ids: getNewsTriggers("liquidity.stablecoin_change_7d")
    };
    if (stabChange > 0) bullish.push(entry);
    else                bearish.push(entry);
  }

  // ── BTC 主導率 ───────────────────────────────────────────────────
  const domValue = safeValue(factors, "sentiment.btc_dominance");
  const domScore = safeScore(factors, "sentiment.btc_dominance");
  if (domValue !== null) {
    const entry = {
      key: "sentiment.btc_dominance",
      value: domValue,
      score: domScore,
      comment: domValue > 60 ? `BTC 主導率 ${domValue.toFixed(1)}% — 市場集中 BTC，山寨承壓`
        : domValue < 45 ? `BTC 主導率 ${domValue.toFixed(1)}% — 資金分散，山寨活躍`
        : `BTC 主導率 ${domValue.toFixed(1)}% — 市場結構中性`,
      trigger_news_ids: getNewsTriggers("sentiment.btc_dominance")
    };
    // 高主導 = 對整體偏空（資金集中避險）
    if (domValue > 58) bearish.push(entry);
    else               bullish.push(entry);
  }

  // ── Put/Call Ratio（選擇權）──────────────────────────────────────
  const pcValue = safeValue(factors, "derivatives.btc_put_call_ratio");
  const pcScore = safeScore(factors, "derivatives.btc_put_call_ratio");
  if (pcValue !== null) {
    const entry = {
      key: "derivatives.btc_put_call_ratio",
      value: pcValue,
      score: pcScore,
      comment: pcValue < 0.5 ? `P/C Ratio ${pcValue.toFixed(2)} — Call 為主，選擇權市場偏多`
        : pcValue > 1.2 ? `P/C Ratio ${pcValue.toFixed(2)} — Put 為主，選擇權市場避險`
        : `P/C Ratio ${pcValue.toFixed(2)} — 選擇權市場中性`,
      trigger_news_ids: getNewsTriggers("derivatives.btc_put_call_ratio")
    };
    if (pcScore > 0) bullish.push(entry);
    else             bearish.push(entry);
  }

  // ── DeFi TVL ────────────────────────────────────────────────────
  const tvlValue = safeValue(factors, "liquidity.defi_tvl");
  const tvlScore = safeScore(factors, "liquidity.defi_tvl");
  if (tvlValue !== null && tvlScore !== null && Math.abs(tvlScore) > 0.2) {
    const entry = {
      key: "liquidity.defi_tvl",
      value: tvlValue,
      score: tvlScore,
      comment: `DeFi TVL $${(tvlValue/1e9).toFixed(1)}B — 鏈上活躍度${tvlScore > 0 ? "高" : "偏低"}`,
      trigger_news_ids: getNewsTriggers("liquidity.defi_tvl")
    };
    if (tvlScore > 0) bullish.push(entry);
    else              bearish.push(entry);
  }

  // ── 監管壓力 ────────────────────────────────────────────────────
  const regScore = safeScore(factors, "risk.regulatory_bias");
  const regValue = safeValue(factors, "risk.regulatory_bias");
  if (regScore !== null && regScore < -0.3) {
    bearish.push({
      key: "risk.regulatory_bias",
      value: regValue,
      score: regScore,
      comment: `監管壓力指標 ${regScore.toFixed(2)} — 近期監管消息偏緊`,
      trigger_news_ids: getNewsTriggers("risk.regulatory_bias")
    });
  }

  return { bullish, bearish };
}

/**
 * Sub-segments：目前只有 BTC dominance 可以推算 BTC vs 其他結構
 * per-symbol 需 Coinglass API key，暫用 "insufficient_data"
 */
function buildCryptoSubSegments(factors) {
  const domValue = safeValue(factors, "sentiment.btc_dominance");
  const fgValue  = safeValue(factors, "sentiment.fear_greed");
  const cryptoBias = safeScore(factors, "signals.crypto_bias");

  // BTC 估計：主導率高時 BTC 相對強
  const btcRelStrength = domValue !== null ? (domValue > 55 ? "stronger_than_alts" : domValue < 48 ? "weaker_than_alts" : "parity") : null;

  return {
    btc: {
      relative_strength: btcRelStrength,
      dominance_pct: domValue,
      comment: btcRelStrength === "stronger_than_alts" ? "BTC 相對強，資金集中" : btcRelStrength === "weaker_than_alts" ? "BTC 相對弱，資金分散" : "BTC 表現與大盤持平"
    },
    alts_aggregate: {
      direction: domValue !== null ? (domValue > 58 ? "bearish" : domValue < 48 ? "bullish" : "neutral") : null,
      note: "per-symbol 數據需 Coinglass API key"
    },
    market_wide: {
      direction: cryptoBias !== null ? (cryptoBias > 0.1 ? "bullish" : cryptoBias < -0.1 ? "bearish" : "neutral") : null,
      fear_greed: fgValue
    }
  };
}

/**
 * Crypto narrative 生成
 */
function buildCryptoNarrative(regime, scores, drivers, macroRegime) {
  const regimeLabels = {
    risk_on:             "風險偏好",
    risk_on_transition:  "由觀望轉多",
    neutral_drift:       "中性盤整",
    risk_off_transition: "由中性轉空",
    risk_off:            "風險規避",
    leverage_flush:      "去槓桿清算"
  };
  const label = regimeLabels[regime.label] || regime.label;

  // 標題
  let headline;
  if (regime.label === "leverage_flush") {
    headline = `加密市場進入去槓桿模式：${regime.trigger || "大規模清算"}`;
  } else if (regime.label === "risk_off" || regime.label === "risk_off_transition") {
    const topBear = drivers.bearish[0]?.comment || "多項指標偏空";
    headline = `加密市場 ${label}：${topBear}`;
  } else if (regime.label === "risk_on" || regime.label === "risk_on_transition") {
    const topBull = drivers.bullish[0]?.comment || "情緒改善";
    headline = `加密市場 ${label}：${topBull}`;
  } else {
    headline = `加密市場${label}，方向訊號分歧`;
  }

  // 宏觀注意
  const macroNote = macroRegime?.label === "tightening_late"
    ? "宏觀仍處緊縮後段，注意流動性壓力"
    : macroRegime?.label === "shock"
    ? "宏觀衝擊模式，加密市場與傳統資產高度連動"
    : null;

  const keyObs = [];
  if (drivers.bearish.length > 0) keyObs.push(...drivers.bearish.slice(0, 2).map(d => d.comment));
  if (drivers.bullish.length > 0) keyObs.push(...drivers.bullish.slice(0, 2).map(d => d.comment));
  if (macroNote) keyObs.push(macroNote);

  const whatToWatch = ["BTC 清算金額 24h 變化", "穩定幣淨流入/流出", "恐懼貪婪指數趨勢"];
  if (macroRegime?.label?.includes("tightening")) whatToWatch.push("Fed 利率路徑消息");

  return { headline, key_observations: keyObs, what_to_watch: whatToWatch, language: "zh-Hant" };
}

/**
 * 儲存 asset comment 到 SQLite，並偵測 regime 切換寫入 regime_transitions
 */
function saveAssetComment(assetClass, snapshotId, computedAt, regime, scores, narrative, fullJson) {
  try {
    db.prepare(`
      INSERT INTO asset_comments
        (asset_class, snapshot_id, computed_at, regime_label, regime_confidence,
         score_short_term, score_mid_term, narrative_headline, full_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_class, snapshot_id) DO UPDATE SET
        full_json = excluded.full_json,
        narrative_headline = excluded.narrative_headline
    `).run(
      assetClass, snapshotId, computedAt,
      regime.label, regime.confidence,
      scores.short_term?.direction ?? null,
      scores.mid_term?.direction ?? null,
      narrative.headline,
      JSON.stringify(fullJson)
    );
  } catch (e) {
    console.warn(`[comment/${assetClass}] SQLite write failed:`, e.message);
  }

  // §6 Layer 4: Regime Transition Memory — 偵測 regime 切換
  if (assetClass === "crypto") {
    try {
      trackRegimeTransition(computedAt, regime, fullJson);
    } catch (e) {
      console.warn("[memory] regime transition tracking failed:", e.message);
    }
  }
}

/**
 * 偵測 crypto regime 切換並寫入 regime_transitions 表
 * 只在 regime label 真正改變時寫入（排除重複快照）
 */
function trackRegimeTransition(computedAt, regime, fullJson) {
  // 取上一筆 asset_comment 的 regime（排除同 snapshot）
  const prev = db.prepare(`
    SELECT regime_label, regime_confidence, full_json, computed_at
    FROM asset_comments
    WHERE asset_class = 'crypto'
    ORDER BY computed_at DESC LIMIT 1
  `).get();

  if (!prev) return; // 沒有歷史，無法判斷切換

  const prevLabel = prev.regime_label;
  const newLabel  = regime.label;

  if (prevLabel === newLabel) return; // 未切換，不寫入

  // 準備觸發 factors（從 fullJson 抽取關鍵 factors）
  let triggerFactors = [];
  try {
    const fj = typeof fullJson === "string" ? JSON.parse(fullJson) : fullJson;
    const drivers = fj?.asset_specific_drivers;
    if (drivers?.bullish) {
      triggerFactors = drivers.bullish.slice(0, 3).map(d => ({
        key: d.key, value: d.value, score: d.score
      }));
    }
    if (drivers?.bearish) {
      triggerFactors = [
        ...triggerFactors,
        ...drivers.bearish.slice(0, 2).map(d => ({ key: d.key, value: d.value, score: d.score }))
      ];
    }
  } catch { /* ignore */ }

  // 取 regime_hint（pattern 識別）
  let regimeHint = null;
  try {
    const fj = typeof fullJson === "string" ? JSON.parse(fullJson) : fullJson;
    regimeHint = fj?.regime?.regime_hint ?? null;
  } catch { /* ignore */ }

  const transitionId = `rt_${computedAt.replace(/[-:T.Z]/g, "").slice(0, 14)}_crypto`;

  db.prepare(`
    INSERT OR IGNORE INTO regime_transitions
      (id, timestamp, from_regime, to_regime, confidence,
       trigger_factors, active_pattern, regime_hint, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    transitionId, computedAt,
    prevLabel, newLabel, regime.confidence,
    JSON.stringify(triggerFactors),
    regimeHint,
    regimeHint,
    computedAt
  );

  console.log(`[memory] Regime transition: ${prevLabel} → ${newLabel} (confidence=${regime.confidence.toFixed(2)})`);
}

// ── §6.7 Memory Context 輔助函式 ──────────────────────────────────────────────
//
// 從 Memory System 拉出與當前 regime 相關的 context，
// 整合進 /api/comment/crypto 的 regime_context 欄位。

function buildRegimeContext(regimeLabel, regimeHint) {
  const ctx = {
    active_patterns: [],
    similar_transitions: [],
    note: "需累積更多歷史才具統計意義"
  };

  try {
    // 1. 當前匹配的 patterns（依 signature 篩選，輕量版：只取 name + confidence）
    const patternRows = db.prepare(`
      SELECT id, name, category, description, confidence, stats, signature
      FROM patterns WHERE is_active = 1
    `).all();

    // 只取最新 factors 做輕量匹配
    const factorRows = db.prepare(`
      SELECT factor_key, normalized_score FROM factor_snapshots
      WHERE computed_at = (SELECT MAX(computed_at) FROM factor_snapshots)
    `).all();
    const fMap = {};
    for (const r of factorRows) fMap[r.factor_key] = r.normalized_score;

    function matchesSig(sigJson) {
      let sig;
      try { sig = JSON.parse(sigJson); } catch { return false; }
      for (const [key, cond] of Object.entries(sig)) {
        const val = fMap[key];
        if (val === undefined) continue;
        const m = cond.match(/^([><]=?|=)\s*([-\d.]+)$/);
        if (!m) continue;
        const [, op, numStr] = m;
        const num = parseFloat(numStr);
        if (op === ">"  && !(val >  num)) return false;
        if (op === ">=" && !(val >= num)) return false;
        if (op === "<"  && !(val <  num)) return false;
        if (op === "<=" && !(val <= num)) return false;
        if (op === "="  && val !== num)   return false;
      }
      return true;
    }

    for (const p of patternRows) {
      if (p.signature && matchesSig(p.signature)) {
        let stats = {};
        try { stats = JSON.parse(p.stats); } catch { /**/ }
        ctx.active_patterns.push({
          id:         p.id,
          name:       p.name,
          category:   p.category,
          confidence: p.confidence,
          win_rate_7d: stats.win_rate_7d ?? null,
          description: p.description
        });
      }
    }

    // 2. 類似 regime 的歷史 transition（同 to_regime 或 from_regime）
    const transRows = db.prepare(`
      SELECT id, timestamp, from_regime, to_regime, confidence, outcome_json
      FROM regime_transitions
      WHERE to_regime = ? OR (from_regime = ? AND to_regime IS NOT NULL)
      ORDER BY timestamp DESC LIMIT 5
    `).all(regimeLabel, regimeLabel);

    for (const t of transRows) {
      let outcome = null;
      try { outcome = t.outcome_json ? JSON.parse(t.outcome_json) : null; } catch { /**/ }
      ctx.similar_transitions.push({
        id:            t.id,
        timestamp:     t.timestamp,
        from_regime:   t.from_regime,
        to_regime:     t.to_regime,
        confidence:    t.confidence,
        btc_return_7d: outcome?.btc_return_7d ?? null
      });
    }

    if (ctx.similar_transitions.length > 0 || ctx.active_patterns.length > 0) {
      ctx.note = ctx.active_patterns.length > 0
        ? `匹配 ${ctx.active_patterns.length} 個 pattern，${ctx.similar_transitions.length} 筆類似歷史切換`
        : `${ctx.similar_transitions.length} 筆類似歷史切換，無匹配 pattern`;
    }
  } catch { /* ignore memory errors, context is optional */ }

  return ctx;
}

// ── GET /api/comment/{asset_class} ───────────────────────────────

router.get("/:asset_class", (req, res) => {
  const { asset_class } = req.params;
  const SUPPORTED_LIVE = ["crypto"];
  const SUPPORTED_ALL  = ["crypto", "us_stock", "tw_stock", "fx", "commodity", "bond", "cross_asset"];

  if (!SUPPORTED_ALL.includes(asset_class)) {
    return res.status(400).json({ error: `Unknown asset_class: ${asset_class}`, supported: SUPPORTED_ALL });
  }

  if (!SUPPORTED_LIVE.includes(asset_class)) {
    return res.status(501).json({
      error: "Not implemented yet",
      asset_class,
      message: `/api/comment/${asset_class} is on the roadmap.`,
      shared_macro_endpoint: "/api/comment"
    });
  }

  // ── /api/comment/crypto ─────────────────────────────────────────
  const factorRows = getLatestFactors();
  if (factorRows.length === 0) {
    return res.status(404).json({ error: "No factor data available.", hint: "node v1/scripts/update-data.mjs" });
  }

  const factors = toFactorMap(factorRows);
  const now = new Date();
  const computedAt = now.toISOString();
  const snapshotId = makeSnapshotId(now);

  // 取得 shared macro 作為 context
  const macroRegime = computeMacroRegime(factors);
  const globalRisk  = computeGlobalRisk(factors);

  const regime        = computeCryptoRegime(factors, macroRegime);
  const scores        = computeCryptoScores(factors);
  const drivers       = buildCryptoDrivers(factors);
  const subSegments   = buildCryptoSubSegments(factors);
  const narrative     = buildCryptoNarrative(regime, scores, drivers, macroRegime);
  const newsSentiment = buildNewsSentiment();

  // §4.3 Factor deltas（各時間框的基準變化）
  const DELTA_KEYS = [
    "sentiment.fear_greed",
    "derivatives.btc_funding_rate",
    "derivatives.btc_open_interest",
    "liquidity.stablecoin_change_7d",
    "flows.etf_net_flow_7d",
    "crypto.momentum.btc.return_7d",
    "crypto.momentum.btc.rsi_14d"
  ];
  const factorDeltas = {
    intraday:  computeFactorDeltas(factors, DELTA_KEYS, LOOKBACK_HOURS.intraday),
    short_term: computeFactorDeltas(factors, DELTA_KEYS, LOOKBACK_HOURS.short_term),
    mid_term:   computeFactorDeltas(factors, DELTA_KEYS, LOOKBACK_HOURS.mid_term),
  };

  // §6.7 Memory context（當前匹配 patterns + 類似歷史 transitions）
  const regimeContext = buildRegimeContext(regime.label, regime.regime_hint);

  const limitations = [
    "per-symbol（ETH/SOL/XRP）數據需 Coinglass API key，目前僅回傳 BTC 結構推估",
    "btc_funding_rate / btc_open_interest 需 Coinglass API key",
    "sentiment.fear_greed 為 Alternative.me 每日更新",
    "rule_based engine，不含 LLM 詮釋"
  ];

  // crypto regime 24h 穩定性：過去 24h asset_comments 中同一 regime 的比例
  let cryptoStability24h = null;
  try {
    const since24h = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const hist = db.prepare(`
      SELECT regime_label FROM asset_comments
      WHERE asset_class = 'crypto' AND computed_at >= ?
      ORDER BY computed_at DESC
    `).all(since24h);
    if (hist.length >= 1) {
      const sameCount = hist.filter(r => r.regime_label === regime.label).length;
      cryptoStability24h = Number((sameCount / hist.length).toFixed(2));
    }
  } catch { /* ignore */ }

  const comment = {
    asset_class: "crypto",
    computed_at: computedAt,
    snapshot_id: snapshotId,
    comment_version: "v1.0.0",
    engine: "rule_based",
    session: { state: "24_7" },
    shared_macro_ref: {
      macro_regime: macroRegime.label,
      global_risk_level: globalRisk.level,
      snapshot_id: snapshotId
    },
    regime: {
      label: regime.label,
      candidates: ["risk_on","risk_on_transition","neutral_drift","risk_off_transition","risk_off","leverage_flush"],
      confidence: regime.confidence,
      stability_24h: cryptoStability24h,
      trigger: regime.trigger ?? null,
      regime_hint: regime.regime_hint ?? null  // §4.5 accumulation/distribution/wall_of_worry/bull_trap
    },
    scores,
    factor_deltas: factorDeltas,   // §4.3 各時間框基準變化（intraday/short/mid lookback delta）
    asset_specific_drivers: drivers,
    sub_segments: subSegments,
    narrative,
    news_sentiment: newsSentiment,
    regime_context: regimeContext,   // §6.7 Memory System — active patterns + similar transitions
    limitations
  };

  saveAssetComment("crypto", snapshotId, computedAt, regime, scores, narrative, comment);

  res.json(comment);
});

// ── GET /api/comment/{asset_class}/history ────────────────────────

router.get("/:asset_class/history", (req, res) => {
  const { asset_class } = req.params;
  const limitNum = Math.min(Number(req.query.limit) || 100, 1000);
  const from = req.query.from || null;
  const to   = req.query.to   || null;

  const conditions = ["asset_class = ?"];
  const params = [asset_class];
  if (from) { conditions.push("computed_at >= ?"); params.push(from); }
  if (to)   { conditions.push("computed_at <= ?"); params.push(to); }

  let rows;
  try {
    rows = db.prepare(`
      SELECT snapshot_id, computed_at, regime_label, regime_confidence,
             score_short_term, score_mid_term, narrative_headline
      FROM asset_comments
      WHERE ${conditions.join(" AND ")}
      ORDER BY computed_at DESC
      LIMIT ?
    `).all(...params, limitNum);
  } catch {
    rows = [];
  }

  res.json({ asset_class, count: rows.length, history: rows });
});

// ── Backfill export ───────────────────────────────────────────────────────────
//
// computeCommentForFactors(factorRows, isoTimestamp)
//   factorRows : rows from factor_snapshots for a single run_id
//   isoTimestamp: the pipeline run's completed_at (e.g. "2026-03-25T05:06:45.085Z")
//
// Runs the same computation pipeline as GET /api/comment/crypto but:
//   - Uses provided factorRows instead of getLatestFactors()
//   - Uses time-parameterised buildNewsSentimentAt() for historical news
//   - Saves result to asset_comments and returns the comment object
//
export function computeCommentForFactors(factorRows, isoTimestamp) {
  const factors    = toFactorMap(factorRows);
  const now        = new Date(isoTimestamp);
  const computedAt = now.toISOString();
  const snapshotId = makeSnapshotId(now);

  const macroRegime = computeMacroRegime(factors);
  const globalRisk  = computeGlobalRisk(factors);
  const regime      = computeCryptoRegime(factors, macroRegime);
  const scores      = computeCryptoScores(factors);
  const drivers     = buildCryptoDrivers(factors);
  const subSegments = buildCryptoSubSegments(factors);
  const narrative   = buildCryptoNarrative(regime, scores, drivers, macroRegime);

  // Historical news sentiment: query news relative to the run timestamp
  const newsSentiment = buildNewsSentimentAt(isoTimestamp);

  const DELTA_KEYS = [
    "sentiment.fear_greed",
    "derivatives.btc_funding_rate",
    "derivatives.btc_open_interest",
    "liquidity.stablecoin_change_7d",
    "flows.etf_net_flow_7d",
    "crypto.momentum.btc.return_7d",
    "crypto.momentum.btc.rsi_14d"
  ];
  const factorDeltas = {
    intraday:   computeFactorDeltas(factors, DELTA_KEYS, LOOKBACK_HOURS.intraday),
    short_term: computeFactorDeltas(factors, DELTA_KEYS, LOOKBACK_HOURS.short_term),
    mid_term:   computeFactorDeltas(factors, DELTA_KEYS, LOOKBACK_HOURS.mid_term),
  };

  const limitations = [
    "per-symbol（ETH/SOL/XRP）數據需 Coinglass API key，目前僅回傳 BTC 結構推估",
    "btc_funding_rate / btc_open_interest 需 Coinglass API key",
    "sentiment.fear_greed 為 Alternative.me 每日更新",
    "rule_based engine，不含 LLM 詮釋"
  ];

  // crypto regime 24h 穩定性（同主端點）
  let cryptoStability24hBf = null;
  try {
    const since24h = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const hist = db.prepare(`
      SELECT regime_label FROM asset_comments
      WHERE asset_class = 'crypto' AND computed_at >= ?
      ORDER BY computed_at DESC
    `).all(since24h);
    if (hist.length >= 1) {
      const sameCount = hist.filter(r => r.regime_label === regime.label).length;
      cryptoStability24hBf = Number((sameCount / hist.length).toFixed(2));
    }
  } catch { /* ignore */ }

  const comment = {
    asset_class: "crypto",
    computed_at: computedAt,
    snapshot_id: snapshotId,
    comment_version: "v1.0.0",
    engine: "rule_based_backfill",
    session: { state: "24_7" },
    shared_macro_ref: {
      macro_regime: macroRegime.label,
      global_risk_level: globalRisk.level,
      snapshot_id: snapshotId
    },
    regime: {
      label: regime.label,
      candidates: ["risk_on","risk_on_transition","neutral_drift","risk_off_transition","risk_off","leverage_flush"],
      confidence: regime.confidence,
      stability_24h: cryptoStability24hBf,
      trigger: regime.trigger ?? null,
      regime_hint: regime.regime_hint ?? null
    },
    scores,
    factor_deltas: factorDeltas,
    asset_specific_drivers: drivers,
    sub_segments: subSegments,
    narrative,
    news_sentiment: newsSentiment,
    limitations
  };

  saveAssetComment("crypto", snapshotId, computedAt, regime, scores, narrative, comment);
  return comment;
}

/**
 * Historical version of buildNewsSentiment — queries news around a given timestamp
 */
function buildNewsSentimentAt(isoTs) {
  try {
    const now24h = db.prepare(`
      SELECT content FROM jin10_news
      WHERE published_at > datetime(?, '-24 hours')
        AND published_at <= datetime(?)
    `).all(isoTs, isoTs);

    const prev24h = db.prepare(`
      SELECT content FROM jin10_news
      WHERE published_at > datetime(?, '-48 hours')
        AND published_at <= datetime(?, '-24 hours')
    `).all(isoTs, isoTs);

    function calcRatios(rows) {
      if (rows.length === 0) return { total: 0, bearish: 0, bullish: 0, neutral: 0, bearish_ratio: null, bullish_ratio: null };
      let bearish = 0, bullish = 0;
      for (const r of rows) {
        const d = quickDirectionEn(r.content || "");
        if (d === "bearish" || d === "ambiguous") bearish++;
        else if (d === "bullish") bullish++;
      }
      const total   = rows.length;
      const neutral = total - bearish - bullish;
      return { total, bearish, bullish, neutral,
               bearish_ratio: Number((bearish / total).toFixed(3)),
               bullish_ratio: Number((bullish / total).toFixed(3)) };
    }

    const cur  = calcRatios(now24h);
    const prev = calcRatios(prev24h);
    if (cur.total === 0) return null;

    const bearishRatio = cur.bearish_ratio;
    const shiftVs48h   = prev.bearish_ratio !== null
      ? Number((bearishRatio - prev.bearish_ratio).toFixed(3))
      : null;

    let regime;
    if      (bearishRatio >= 0.70) regime = "panic";
    else if (bearishRatio >= 0.50) regime = "fear";
    else if (bearishRatio >= 0.35) regime = "cautious";
    else if (cur.bullish_ratio >= 0.40) regime = "euphoria";
    else                           regime = "calm";

    return {
      regime,
      total_24h:         cur.total,
      bearish_count_24h: cur.bearish,
      bullish_count_24h: cur.bullish,
      bearish_ratio_24h: bearishRatio,
      bullish_ratio_24h: cur.bullish_ratio,
      shift_vs_48h:      shiftVs48h,
      contrarian_signal: bearishRatio > 0.70,
      classifier:        "direction_en_v2.4_inline",
      note:              "historical backfill"
    };
  } catch {
    return null;
  }
}

export default router;
