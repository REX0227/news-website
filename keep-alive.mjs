/**
 * keep-alive.mjs — CryptoPulse 本機常駐更新 Server
 * 執行方式：node keep-alive.mjs
 * 每 5 分鐘自動執行 V1 + V4 資料更新
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTERVAL_MS = 5 * 60 * 1000; // 5 分鐘

function timestamp() {
  return new Date().toLocaleString('zh-Hant', { timeZone: 'Asia/Taipei' });
}

function runScript(label, scriptPath) {
  return new Promise((resolve) => {
    console.log(`[${timestamp()}] [${label}] 開始更新...`);
    const child = spawn('node', [scriptPath], {
      cwd: __dirname,
      stdio: 'inherit',
      shell: true,
    });
    child.on('close', (code) => {
      if (code === 0) console.log(`[${timestamp()}] [${label}] ✓ 成功`);
      else console.error(`[${timestamp()}] [${label}] ✗ 失敗（exit code: ${code}）`);
      resolve();
    });
    child.on('error', (err) => {
      console.error(`[${timestamp()}] [${label}] ✗ 錯誤：${err.message}`);
      resolve();
    });
  });
}

async function runUpdate() {
  console.log(`\n[${timestamp()}] ── 開始更新 ──`);
  await runScript('V1', 'v1/scripts/update-data.mjs');
  await runScript('V4', 'v4/scripts/collect-all.mjs');
  console.log(`[${timestamp()}] ── 完成，下次更新：${INTERVAL_MS / 60000} 分鐘後 ──\n`);
}

// 啟動時立即執行一次
runUpdate();

// 之後每 5 分鐘執行
setInterval(runUpdate, INTERVAL_MS);

console.log(`CryptoPulse Keep-Alive Server 已啟動`);
console.log(`更新頻率：每 ${INTERVAL_MS / 60000} 分鐘（V1 + V4）`);
console.log(`按 Ctrl+C 停止\n`);
