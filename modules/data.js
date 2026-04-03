/**
 * data.js — 資料取得層 + Coinglass payload 輔助函式
 * 負責：Upstash / 本地 API fetch、Coinglass cache fetch
 */

import { state } from './state.js';

const UPSTASH_URL = "https://sensible-grouper-89071.upstash.io";
const UPSTASH_READ_TOKEN = "gQAAAAAAAVvvAAIncDE4ZjIwMzAwMmMxNTI0N2UxYjk1ZGJkNDc2MTE4YzA4ZXAxODkwNzE";
const UPSTASH_KEY = "crypto_dashboard:latest";
const COINGLASS_UPSTASH_KEY = 'cryptopulse:database:coinglass:derivatives';
const LOCAL_API_URL = "http://localhost:3000/api/dashboard";

// ── Coinglass payload helpers（供 gate.js import）──────────────────
export function cgSeries(payload, streamKey, seriesKey) {
  const s = payload?.streams?.[streamKey]?.series?.[seriesKey];
  return Array.isArray(s) ? s : [];
}
export function cgLatest(series) {
  return Array.isArray(series) && series.length ? series[series.length - 1] : null;
}
export function cgPrevious(series) {
  return Array.isArray(series) && series.length > 1 ? series[series.length - 2] : null;
}
export function cgPositions(payload) {
  const s = payload?.streams?.hyperliquidWhalePosition?.series?.latest;
  return Array.isArray(s) ? s : [];
}

// ── Dashboard data fetch ───────────────────────────────────────────
async function fetchFromAPI() {
  const response = await fetch(LOCAL_API_URL, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`本地 API 回應異常 (${response.status})`);
  const data = await response.json();
  if (!data || typeof data !== "object") throw new Error("本地 API 回傳格式異常");
  return data;
}

async function fetchFromUpstash() {
  const upstashResponse = await fetch(`${UPSTASH_URL}/get/${UPSTASH_KEY}`, {
    headers: { Authorization: `Bearer ${UPSTASH_READ_TOKEN}` }
  });
  if (!upstashResponse.ok) throw new Error("無法從 Upstash 載入最新資料");
  const payload = await upstashResponse.json();
  const result = payload?.result;
  if (typeof result === "string") return JSON.parse(result);
  if (result && typeof result === "object") return result;
  throw new Error("Upstash 回傳資料格式異常");
}

export async function loadData() {
  try {
    const data = await fetchFromAPI();
    state._dataSource = "本地 API";
    return data;
  } catch {
    const data = await fetchFromUpstash();
    state._dataSource = "Upstash";
    return data;
  }
}

// ── composite_score 歷史走勢（Redis list，最新在前）─────────────────
export async function fetchCompositeHistory() {
  try {
    const res = await fetch(`${UPSTASH_URL}/lrange/${encodeURIComponent('crypto_composite:history')}/0/143`, {
      headers: { Authorization: `Bearer ${UPSTASH_READ_TOKEN}` }
    });
    if (!res.ok) return [];
    const json = await res.json();
    if (!Array.isArray(json.result)) return [];
    return json.result.map(item => {
      try {
        let v = typeof item === 'string' ? JSON.parse(item) : item;
        if (Array.isArray(v)) v = v[0];
        if (typeof v === 'string') v = JSON.parse(v);
        return v;
      } catch { return null; }
    }).filter(Boolean).reverse();  // 反轉：舊→新（方便 Chart.js 繪圖）
  } catch { return []; }
}

// ── Coinglass V3 cache fetch（只更新 state，不觸發 render）─────────
export async function fetchCoinglass() {
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(COINGLASS_UPSTASH_KEY)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_READ_TOKEN}` }
    });
    if (!res.ok) return;
    const json = await res.json();
    if (!json.result) return;
    state.coinglassCache = typeof json.result === 'string'
      ? JSON.parse(json.result)
      : json.result;
  } catch (_) {}
}
