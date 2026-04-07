/**
 * collectorCache.js — Collector 快取工具
 *
 * 各 collector TTL：
 *   VIX/DXY、Deribit P/C    → 3 分鐘  （即時市場）
 *   加密新聞、地緣風險 RSS   → 5 分鐘  （突發新聞）
 *   Coinglass 衍生品、清算   → 20 分鐘 （4-8h K線）
 *   流動性（穩定幣/TVL）     → 30 分鐘
 *   政策 RSS、Fear&Greed    → 60 分鐘 （重大政策）
 *   FRED 殖利率、宏觀日曆   → 120 分鐘（月度數據）
 *
 * 設計：
 *   - 記憶體快取（module singleton）解決 Promise.all 並行讀寫競爭
 *   - 啟動時從 collector-cache.json 載入，讓重啟後快取依然有效
 *   - fetchFn 失敗時自動降級使用過期快取，避免資料斷層
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.resolve(__dirname, '../../data/collector-cache.json');

// ── 記憶體快取（程序生命週期內共享）─────────────────────────────
let _memCache = null;

function getMemCache() {
  if (_memCache) return _memCache;
  // 首次呼叫：從檔案載入
  try {
    _memCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    console.log(`[cache] 從檔案載入快取（${Object.keys(_memCache).length} 個 key）`);
  } catch {
    _memCache = {};
  }
  return _memCache;
}

function persistCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_memCache, null, 2));
  } catch (e) {
    console.warn(`[cache] 無法寫入快取檔案：${e.message}`);
  }
}

/**
 * withCache(key, ttlMs, fetchFn)
 *
 * @param {string}   key      快取鍵名
 * @param {number}   ttlMs    快取存活時間（毫秒）
 * @param {Function} fetchFn  實際呼叫 API 的 async function
 * @returns {Promise<any>}
 */
export async function withCache(key, ttlMs, fetchFn) {
  const cache = getMemCache();
  const entry = cache[key];
  const now = Date.now();

  if (entry?.fetchedAt) {
    const ageMs = now - new Date(entry.fetchedAt).getTime();
    if (ageMs < ttlMs) {
      const ageMin = (ageMs / 60000).toFixed(1);
      const ttlMin = (ttlMs / 60000).toFixed(0);
      console.log(`[cache] ${key} → 快取有效（${ageMin}/${ttlMin} 分）`);
      return entry.data;
    }
  }

  try {
    const data = await fetchFn();
    cache[key] = { data, fetchedAt: new Date().toISOString() };
    persistCache();
    console.log(`[cache] ${key} → 已更新`);
    return data;
  } catch (err) {
    if (entry?.data !== undefined) {
      const staleMin = ((now - new Date(entry.fetchedAt).getTime()) / 60000).toFixed(1);
      console.warn(`[cache] ${key} → 抓取失敗，使用 ${staleMin} 分前的舊快取：${err.message}`);
      return entry.data;
    }
    throw err;
  }
}

/**
 * getCacheMeta() — 回傳各 key 的 fetchedAt 時間（供 payload 傳給前端）
 * @returns {{ [key: string]: string }}  key → ISO 時間字串
 */
export function getCacheMeta() {
  const cache = getMemCache();
  const meta = {};
  for (const [k, v] of Object.entries(cache)) {
    if (v?.fetchedAt) meta[k] = v.fetchedAt;
  }
  return meta;
}

/**
 * clearCache(key?) — 清除快取（debug 用）
 */
export function clearCache(key) {
  const cache = getMemCache();
  if (key) {
    delete cache[key];
    console.log(`[cache] 已清除 ${key}`);
  } else {
    Object.keys(cache).forEach(k => delete cache[k]);
    console.log('[cache] 已清除全部快取');
  }
  persistCache();
}
