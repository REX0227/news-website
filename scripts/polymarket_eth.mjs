/**
 * Polymarket — 以太坊預測市場賠率 + K 線歷史抓取器
 *
 * 用途：
 *   1. 從 Gamma API 抓取 top 5 ETH 預測市場（賠率、成交量）
 *   2. 從 CLOB API 抓取每個市場的概率歷史（1分鐘精度，最近 23 小時）
 *   3. 聚合成 15 分鐘 OHLCV K 線
 *   4. 存到 v1/docs/data/polymarket_eth.json（靜態網頁讀取）
 *   5. 寫入 Upstash（key: polymarket:eth:latest）
 *
 * 執行：node scripts/polymarket_eth.mjs
 */

import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, "../v1/docs/data/polymarket_eth.json");
const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";
const UPSTASH_KEY = "polymarket:eth:latest";

// ── 讀取 .env ──────────────────────────────────────────────
function loadEnv() {
  const envPath = path.resolve(__dirname, "../.env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
}

// ── HTTP GET helper ────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "CryptoPulse/1.0", Accept: "application/json" } }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); }
          catch { resolve({}); }
        });
      })
      .on("error", reject);
  });
}

// ── Upstash 寫入 ───────────────────────────────────────────
function upstashSet(key, value) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN_WRITE;
  if (!url || !token) { console.warn("[WARN] 未設定 Upstash 環境變數，跳過寫入。"); return Promise.resolve(); }

  const body = Buffer.from(JSON.stringify(["SET", key, JSON.stringify(value)]));
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: parsed.hostname, path: "/", method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": body.length } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d)); }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Gamma API：掃描取得 top 5 ETH 市場 ────────────────────
async function fetchEthMarkets() {
  const all = [];
  for (let page = 0; page < 6; page++) {
    const batch = await get(
      `${GAMMA_BASE}/markets?active=true&closed=false&limit=500&offset=${page * 500}&order=volume24hr&ascending=false`
    );
    if (!Array.isArray(batch)) break;
    all.push(...batch);
    if (batch.length < 500) break;
  }
  return all
    .filter((m) => /\beth\b|\bethereum\b/i.test(m.question || ""))
    .sort((a, b) => Number(b.volume24hr || 0) - Number(a.volume24hr || 0))
    .slice(0, 5); // top 5，避免歷史抓取太慢
}

// ── CLOB API：抓取 YES token 概率歷史（1d interval, 1 min 精度）──
async function fetchPriceHistory(tokenId) {
  const url = `${CLOB_BASE}/prices-history?market=${tokenId}&interval=1d&fidelity=1`;
  const r = await get(url);
  return Array.isArray(r.history) ? r.history : [];
}

// ── 聚合成 15 分鐘 OHLCV ──────────────────────────────────
function aggregateOHLCV(points, bucketSecs = 900) {
  const buckets = {};
  for (const { t, p } of points) {
    const key = Math.floor(t / bucketSecs) * bucketSecs;
    if (!buckets[key]) {
      buckets[key] = { time: key, open: p, high: p, low: p, close: p };
    } else {
      if (p > buckets[key].high) buckets[key].high = p;
      if (p < buckets[key].low) buckets[key].low = p;
      buckets[key].close = p;
    }
  }
  return Object.values(buckets)
    .sort((a, b) => a.time - b.time)
    .map((c) => ({
      time: c.time,
      open:  Math.round(c.open  * 1000) / 10,
      high:  Math.round(c.high  * 1000) / 10,
      low:   Math.round(c.low   * 1000) / 10,
      close: Math.round(c.close * 1000) / 10,
    }));
}

// ── 解析 outcomes ──────────────────────────────────────────
function parseOutcomes(market) {
  let labels = market.outcomes ?? [];
  let prices = market.outcomePrices ?? [];
  if (typeof labels === "string") { try { labels = JSON.parse(labels); } catch { labels = []; } }
  if (typeof prices === "string") { try { prices = JSON.parse(prices); } catch { prices = []; } }
  return labels.map((label, i) => ({
    label,
    probability: prices[i] != null ? Math.round(Number(prices[i]) * 1000) / 10 : null,
  }));
}

// ── 合併舊新 OHLCV（去重 + 排序，保留最多 N 天）──────────
const MAX_HISTORY_DAYS = 90;
const MAX_HISTORY_SECS = MAX_HISTORY_DAYS * 24 * 60 * 60;

function mergeOhlcv(oldCandles = [], newCandles = []) {
  const map = {};
  for (const c of oldCandles) map[c.time] = c;
  for (const c of newCandles) map[c.time] = c; // 新資料覆蓋同時間點
  const cutoff = Math.floor(Date.now() / 1000) - MAX_HISTORY_SECS;
  return Object.values(map)
    .filter((c) => c.time >= cutoff)
    .sort((a, b) => a.time - b.time);
}

function mergeMarkets(oldMarkets = [], newMarkets = []) {
  const oldMap = {};
  for (const m of oldMarkets) oldMap[m.id] = m;

  const merged = newMarkets.map((m) => {
    const old = oldMap[m.id];
    return {
      ...m,
      ohlcv: mergeOhlcv(old?.ohlcv, m.ohlcv),
    };
  });

  // 保留已下架（舊有但新抓不到）的市場歷史
  const newIds = new Set(newMarkets.map((m) => m.id));
  for (const m of oldMarkets) {
    if (!newIds.has(m.id)) {
      merged.push({ ...m, closed: true }); // 標記已關閉
    }
  }

  return merged;
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  loadEnv();

  // --interval 1m | 5m | 15m（預設 5m）
  const intervalArg = process.argv.find((a) => a.startsWith("--interval="))?.split("=")[1]
    ?? process.argv[process.argv.indexOf("--interval") + 1]
    ?? "5m";
  const bucketSecs = intervalArg === "1m" ? 60 : intervalArg === "15m" ? 900 : 300;
  console.log(`K 線精度：${intervalArg}（${bucketSecs}s/根）`);

  console.log("正在抓取 Polymarket 以太坊預測市場…（掃描 ~3000 個市場）");

  const rawMarkets = await fetchEthMarkets();
  if (!rawMarkets.length) { console.error("[ERROR] 未找到 ETH 市場"); process.exit(1); }

  console.log(`找到 ${rawMarkets.length} 個市場，開始抓取 K 線歷史…`);

  const markets = [];
  for (const m of rawMarkets) {
    // YES token 是 clobTokenIds[0]
    let yesTokenId = null;
    try {
      const ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds ?? []);
      yesTokenId = ids[0] ?? null;
    } catch { /* ignore */ }

    let ohlcv = [];
    if (yesTokenId) {
      const points = await fetchPriceHistory(yesTokenId);
      ohlcv = aggregateOHLCV(points, bucketSecs);
      console.log(`  ✓ ${m.question.slice(0, 55)} → ${ohlcv.length} 根 K 線`);
    } else {
      console.warn(`  ✗ ${m.question.slice(0, 55)} → 無 token ID`);
    }

    markets.push({
      id: m.id,
      question: m.question ?? "",
      endDate: m.endDate ?? null,
      outcomes: parseOutcomes(m),
      volume24hr: Math.round(Number(m.volume24hr || 0)),
      volume: Math.round(Number(m.volume || 0)),
      liquidity: Math.round(Number(m.liquidity || 0)),
      url: `https://polymarket.com/event/${m.slug ?? ""}`,
      ohlcv, // 15 分鐘 K 線，Y 軸為概率 %（0–100）
    });
  }

  // 讀取既有資料並合併（累積模式）
  let existingMarkets = [];
  if (fs.existsSync(OUT_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(OUT_PATH, "utf-8"));
      existingMarkets = existing.markets || [];
    } catch { /* 讀取失敗則從頭開始 */ }
  }
  const mergedMarkets = mergeMarkets(existingMarkets, markets);
  const totalCandles = mergedMarkets.reduce((s, m) => s + (m.ohlcv?.length || 0), 0);
  console.log(`\n合併後：${mergedMarkets.length} 個市場，共 ${totalCandles} 根 K 線（保留最近 ${MAX_HISTORY_DAYS} 天）`);

  const output = {
    fetchedAt: new Date().toISOString(),
    source: "Polymarket Gamma API + CLOB API",
    note: "預測市場概率（%）與成交量，非現貨幣價。K 線為 1 分鐘精度累積，Y 軸為 Yes 概率（%）。",
    markets: mergedMarkets,
  };

  // 寫靜態 JSON
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  console.log(`\n已儲存 → ${OUT_PATH}`);

  // 寫 Upstash
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN_WRITE) {
    await upstashSet(UPSTASH_KEY, output);
    console.log(`已寫入 Upstash → ${UPSTASH_KEY}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
