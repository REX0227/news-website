/**
 * keep-alive.mjs — CryptoPulse 本機常駐更新 Server
 * 執行方式：node keep-alive.mjs
 *
 * 更新策略：
 *   主循環（每 5 分鐘）：V1 + Polymarket 並行執行
 *     各 collector 自帶 TTL 快取，按數據特性決定是否真正打 API：
 *       VIX/DXY、Deribit P/C    → TTL 3 分鐘  （即時市場）
 *       加密新聞、地緣風險 RSS   → TTL 5 分鐘  （突發新聞）
 *       Coinglass 衍生品、清算   → TTL 20 分鐘 （4-8h K線）
 *       流動性（穩定幣/TVL）     → TTL 30 分鐘
 *       政策 RSS                → TTL 30 分鐘 （白宮/Fed/SEC/CFTC）
 *       Fear&Greed、降息預期     → TTL 60 分鐘
 *       FRED 殖利率、宏觀日曆   → TTL 120 分鐘（月度數據）
 *
 *   慢循環（每 30 分鐘）：V3 + V4 並行執行
 *     Coinglass 28 條歷史 stream 同步 + V4 原始資料
 *
 * 設計：
 *   - setTimeout 鏈式呼叫（非 setInterval），上次跑完才排下次，防止重疊
 *   - V1 + Polymarket 並行（互相獨立，節省執行時間）
 *   - V3 + V4 並行（互相獨立）
 *   - 執行時間記錄，方便監控
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 單一實例鎖（TCP port，跨使用者身分均有效）────────────────────
const LOCK_PORT = 47832;

function acquireLock() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(LOCK_PORT, '127.0.0.1', () => resolve(server));
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[keep-alive] 已有實例在執行（port ${LOCK_PORT} 已佔用），退出。`);
        process.exit(0);
      }
      console.error(`[keep-alive] 鎖 port 錯誤：${err.message}`);
      process.exit(1);
    });
  });
}

await acquireLock();
// ──────────────────────────────────────────────────────────────────

const FAST_INTERVAL_MS = 5  * 60 * 1000;  // 5 分鐘
const SLOW_INTERVAL_MS = 30 * 60 * 1000;  // 30 分鐘

function timestamp() {
  return new Date().toLocaleString('zh-Hant', { timeZone: 'Asia/Taipei' });
}

function runScript(label, cmd, args) {
  return new Promise((resolve) => {
    const start = Date.now();
    console.log(`[${timestamp()}] [${label}] 開始...`);
    const child = spawn(cmd, args, {
      cwd: __dirname,
      stdio: 'inherit',
      shell: true,
    });
    child.on('close', (code) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (code === 0) console.log(`[${timestamp()}] [${label}] ✓ 完成（${elapsed}s）`);
      else console.error(`[${timestamp()}] [${label}] ✗ 失敗（exit ${code}，${elapsed}s）`);
      resolve();
    });
    child.on('error', (err) => {
      console.error(`[${timestamp()}] [${label}] ✗ 錯誤：${err.message}`);
      resolve();
    });
  });
}

// ── 主循環：V1 + Polymarket 並行 ─────────────────────────────────
async function runFast() {
  const start = Date.now();
  console.log(`\n[${timestamp()}] ── 主循環開始（V1 + Polymarket 並行）──`);
  await Promise.all([
    runScript('V1',        'node',   ['v1/scripts/update-data.mjs']),
    runScript('Polymarket','node',   ['scripts/polymarket_eth.mjs']),
  ]);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[${timestamp()}] ── 主循環完成（總計 ${elapsed}s）──\n`);
}

// ── 慢循環：V3 + V4 並行 ─────────────────────────────────────────
async function runSlow() {
  const start = Date.now();
  console.log(`\n[${timestamp()}] ── 慢循環開始（V3 + V4 並行）──`);
  await Promise.all([
    runScript('V3', 'python', ['database-side/sync_coinglass_to_upstash.py']),
    runScript('V4', 'node',   ['v4/scripts/collect-all.mjs']),
  ]);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[${timestamp()}] ── 慢循環完成（總計 ${elapsed}s）──\n`);
}

// ── setTimeout 鏈式排程（防止重疊）───────────────────────────────
function scheduleFast() {
  setTimeout(async () => {
    await runFast();
    scheduleFast(); // 跑完才排下一次
  }, FAST_INTERVAL_MS);
}

function scheduleSlow() {
  setTimeout(async () => {
    await runSlow();
    scheduleSlow(); // 跑完才排下一次
  }, SLOW_INTERVAL_MS);
}

// ── 啟動：立即執行一次，再開始排程 ───────────────────────────────
console.log('CryptoPulse Keep-Alive Server 已啟動');
console.log(`主循環：每 ${FAST_INTERVAL_MS / 60000} 分鐘（V1 + Polymarket 並行，各 collector 獨立 TTL）`);
console.log(`慢循環：每 ${SLOW_INTERVAL_MS / 60000} 分鐘（V3 Coinglass 歷史 + V4 並行）`);
console.log('按 Ctrl+C 停止\n');

// 立即執行一次後才開始排程
runFast().then(scheduleFast);
runSlow().then(scheduleSlow);
