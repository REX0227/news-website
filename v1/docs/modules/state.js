/**
 * state.js — 跨模組共享的可變狀態
 * 所有模組透過 import { state } from './state.js' 讀寫
 */
export const state = {
  dashboardData: null,
  coinglassCache: null,
  compositeHistory: [],
  polymarketMarketsCache: null,
  onlyHighImpact: false,
  macroFilter: "all",
  _dataSource: "Upstash"
};
