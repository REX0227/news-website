/**
 * taiwan/normalize.js
 * 將各台股原始數值正規化至 [-1.0, +1.0]
 * +1.0 = 最強看多訊號，-1.0 = 最強看空訊號，0 = 中性
 * null = 資料不可用（不計入複合評分）
 */

function clamp(v) {
  return Math.max(-1, Math.min(1, v));
}

/**
 * 外資買賣超（億元）
 * 外資是台股最重要的法人，訊號權重最高
 * 基準：±200 億視為強訊號門檻
 */
export function normForeignNetBuy(billionsNTD) {
  if (billionsNTD == null || !Number.isFinite(billionsNTD)) return null;
  // 線性映射：200 億→+1.0，-200 億→-1.0
  return clamp(billionsNTD / 200);
}

/**
 * 三大法人合計買賣超（億元）
 * 包含外資、投信、自營商，但外資影響力最大
 * 基準：±300 億視為強訊號門檻
 */
export function normInstitutionalTotal(billionsNTD) {
  if (billionsNTD == null || !Number.isFinite(billionsNTD)) return null;
  return clamp(billionsNTD / 300);
}

/**
 * 融資餘額日變化（億元）
 * 融資增加 = 散戶加槓桿（短期偏多，但極端值反指標）
 * 融資減少 = 散戶去槓桿（短期偏空，但可能是健康洗盤）
 * 全市場融資餘額約 5000-6000 億，日常波動 50-300 億，基準：±200 億
 */
export function normMarginChange(changeBillions) {
  if (changeBillions == null || !Number.isFinite(changeBillions)) return null;
  return clamp(changeBillions / 200);
}

/**
 * 融券餘額日變化（千股）
 * 融券增加 = 市場看空情緒升溫（負訊號）
 * 融券減少 = 空頭回補（短期正訊號）
 * 基準：±5000 千股
 */
export function normShortChange(changeKShares) {
  if (changeKShares == null || !Number.isFinite(changeKShares)) return null;
  // 融券增加 → 偏空，取負號
  return clamp(-changeKShares / 5000);
}

/**
 * TAIEX MA 方向
 * 5MA 在 20MA 之上 → 多頭排列
 */
export function normMaDirection(maDirection) {
  if (!maDirection) return null;
  if (maDirection === "bullish") return 0.7;
  if (maDirection === "bearish") return -0.7;
  return 0;
}

/**
 * TAIEX 近 5 日動能（%）
 * 基準：±5% 視為強訊號
 */
export function normMomentum5d(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  return clamp(pct / 5);
}

/**
 * TAIFEX 外資 TX 期貨未平倉淨額口數
 * 正值=淨多（看多），負值=淨空（看空）
 * 歷史區間約 -150,000 ~ +80,000 口，飽和閾值 ±50,000
 */
export function normTaifexForeignOI(netContracts) {
  if (netContracts == null || !Number.isFinite(netContracts)) return null;
  return clamp(netContracts / 50000);
}
