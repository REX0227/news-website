/**
 * update-taiwan.mjs — 台股進出場訊號 獨立更新腳本
 *
 * 執行流程：
 *   1. 並行抓取 TWSE 三大法人、融資融券、TAIEX 指數
 *   2. 計算複合評分與進出場訊號
 *   3. 寫入 SQLite（gecko.db tw_ tables）
 *   4. 推送 Upstash（taiwan_dashboard:latest）
 *
 * 使用方式：
 *   node v1/scripts/update-taiwan.mjs
 *
 * 環境變數（與現有 crypto pipeline 共用 .env）：
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN_WRITE
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── dotenv 載入（支援兩層目錄結構）────────────────────────────────
const require = createRequire(import.meta.url);
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../.env") });
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch { /* dotenv 不可用時靜默跳過 */ }

import { collectTwseInstitutional }     from "../src/collectors/twseInstitutionalCollector.js";
import { collectTwseMargin }            from "../src/collectors/twseMarginCollector.js";
import { collectTaiex }                 from "../src/collectors/taiexCollector.js";
import { collectTaifexForeignFutures }  from "../src/collectors/taifexForeignFuturesCollector.js";
import { buildTaiwanComposite }         from "../src/lib/taiwan/composite.js";
import { saveTaiwanToSQLite }           from "../src/lib/sqlite.js";

const UPSTASH_URL         = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_WRITE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN_WRITE;
const TW_UPSTASH_KEY      = "taiwan_dashboard:latest";
const TW_HISTORY_KEY      = "taiwan_composite:history";

async function pushToUpstash(key, value) {
  if (!UPSTASH_URL || !UPSTASH_WRITE_TOKEN) {
    console.warn("[taiwan] 缺少 UPSTASH 環境變數，跳過推送");
    return false;
  }
  const res = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_WRITE_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(value)  // 單層編碼，Upstash 存字串，前端一次 parse 即可
  });
  return res.ok;
}

async function pushHistoryEntry(score, label) {
  if (!UPSTASH_URL || !UPSTASH_WRITE_TOKEN) return;
  const entry = JSON.stringify({ t: new Date().toISOString(), s: score, l: label });
  await fetch(`${UPSTASH_URL}/lpush/${encodeURIComponent(TW_HISTORY_KEY)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_WRITE_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(entry)
  });
}

async function run() {
  console.log("[taiwan] 開始更新台股資料…");
  const startAt = Date.now();

  // ── 1. 並行抓取四個資料源 ────────────────────────────────────────
  const [institutional, margin, taiex, taifexFutures] = await Promise.all([
    collectTwseInstitutional().catch(e => {
      console.warn("[taiwan] 三大法人抓取失敗:", e.message);
      return { available: false, error: e.message };
    }),
    collectTwseMargin().catch(e => {
      console.warn("[taiwan] 融資融券抓取失敗:", e.message);
      return { available: false, error: e.message };
    }),
    collectTaiex().catch(e => {
      console.warn("[taiwan] TAIEX 抓取失敗:", e.message);
      return { available: false, error: e.message };
    }),
    collectTaifexForeignFutures().catch(e => {
      console.warn("[taiwan] TAIFEX 期貨抓取失敗:", e.message);
      return { available: false, error: e.message };
    })
  ]);

  console.log(`[taiwan] 三大法人: ${institutional.available ? `外資 ${institutional.foreignNetBuyBillions} 億` : "不可用"}`);
  console.log(`[taiwan] 融資融券: ${margin.available ? `融資 ${margin.marginChangeBillions > 0 ? "+" : ""}${margin.marginChangeBillions} 億` : "不可用"}`);
  console.log(`[taiwan] TAIEX:   ${taiex.available ? `${taiex.close} (${taiex.changePct > 0 ? "+" : ""}${taiex.changePct}%)` : "不可用"}`);
  console.log(`[taiwan] 期貨OI:  ${taifexFutures.available ? `外資淨額 ${taifexFutures.netOI > 0 ? "+" : ""}${taifexFutures.netOI} 口` : "不可用"}`);

  // ── 2. 計算複合評分 ──────────────────────────────────────────────
  const composite = buildTaiwanComposite({ institutional, margin, taiex, taifexFutures });
  console.log(`[taiwan] 複合評分: ${composite.score} → ${composite.label} (${composite.signal})`);

  // ── 3. 組合完整 payload ──────────────────────────────────────────
  const payload = {
    generatedAt:   new Date().toISOString(),
    dataDate:      institutional.dataDate || margin.dataDate || taiex.dataDate || null,
    institutional,
    margin,
    taiex,
    taifexFutures,
    composite,
    sources: {
      institutional:  institutional.source ?? null,
      margin:         margin.source ?? null,
      taiex:          taiex.source ?? null,
      taifexFutures:  taifexFutures.source ?? null
    }
  };

  // ── 4. 寫入 SQLite ───────────────────────────────────────────────
  try {
    await saveTaiwanToSQLite(payload);
    console.log("[taiwan] SQLite 寫入完成");
  } catch (e) {
    console.warn("[taiwan] SQLite 寫入失敗:", e.message);
  }

  // ── 5. 推送 Upstash ──────────────────────────────────────────────
  const pushed = await pushToUpstash(TW_UPSTASH_KEY, payload);
  if (pushed) {
    console.log(`[taiwan] Upstash 推送完成：${TW_UPSTASH_KEY}`);
    if (composite.score !== null) {
      await pushHistoryEntry(composite.score, composite.label);
    }
  }

  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
  console.log(`[taiwan] 完成，耗時 ${elapsed}s`);
}

run().catch(err => {
  console.error("[taiwan] 致命錯誤:", err);
  process.exit(1);
});
