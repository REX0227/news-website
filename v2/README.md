# CryptoPulse V2 — 資料來源清單與可用性測試

加密市場資訊來源治理中心，管理 65 個資料來源，並每小時自動測試可用性，輸出 PASS/SKIP/FAIL 報告。

**正式網址：** `https://rex0227.github.io/news-website/v2/`
**存取密碼：** `TRAXXAS`

---

## 定位

| 版本 | 定位 |
|------|------|
| V1 | 分析儀表板 — 整合 18 個來源，輸出趨勢結論 |
| **V2（本版）** | 來源健康檢查 — 確認 65 個來源是否正常運作 |
| V4 | 原始資料庫 — 實際抓取 55 個來源的內容 |

---

## 核心約束（不可違反）

1. **不抓取、不顯示幣價**（禁止 price endpoint）
2. 社群平台（X/Twitter）**未取得授權前不抓取**；標記 `requiresApi: true` 後測試預設 SKIP
3. HTML 類來源僅做基本可用性檢查，不承諾長期抓取

---

## 架構

```
v2/data/sources.json（65 個來源定義，SSOT）
        ↓
v2/scripts/test-sources.mjs（可用性測試器）
        ↓
v2/data/fetch-report.json（測試報告，GitHub Actions 每小時產生）
        ↓
v2/index.html + v2/app.js（前端顯示）→ GitHub Pages
```

---

## 資料來源分類（65 個）

| 分類 | 來源數 | 說明 |
|------|--------|------|
| 美國關鍵事件/行事曆 | 4 | BLS ICS、Fed FOMC |
| 日本關鍵事件/行事曆 | 2 | BOJ 行事曆 |
| 美國統計/時間序列 | 3 | FRED CSV（CPI、PCE、GDP 等） |
| 利率/殖利率（美國） | 3 | FRED（3M/2Y/10Y） |
| 美國政策/監管 | 5 | 白宮、US Treasury、Fed、SEC、CFTC |
| 日本政策/監管 | 3 | 日本官方機構 |
| 國際政策/監管 | 2 | BIS、FSB |
| 加密市場結構（不含幣價） | 4 | CoinGecko Global、Fear & Greed |
| 加密衍生品/槓桿風險 | 4 | Coinalyze、Binance、Hyperliquid |
| 流動性/資金流 | 4 | DeFiLlama 穩定幣、TVL |
| 鯨魚/機構操作 | 5 | 鏈上 / 交易所流向（多需 API） |
| 交易所公告 | 4 | Binance、Bybit、OKX 等 |
| 安全事件/風險通報 | 3 | Rekt News、CertiK |
| 美股/傳統市場代理 | 3 | VIX、DXY、FRED |
| 地緣/衝突新聞 | 2 | Reuters、UN |
| 加密新聞 | 4 | CoinDesk、CoinTelegraph |
| 宏觀新聞 | 3 | Reuters、Bloomberg |
| 大佬/機構社群訊號 | 7 | X/Twitter（需 API，目前 SKIP） |
| Polymarket 預測市場 | 1 | Polymarket API |

---

## 目前狀態（2026-03-23）

| 狀態 | 數量 | 說明 |
|------|------|------|
| PASS | 55 | 正常抓取 |
| SKIP | 10 | 需 API key 或授權（X/Twitter 等） |
| FAIL | 0 | 無失效來源 |

---

## 核心檔案

| 檔案 | 用途 |
|------|------|
| `v2/data/sources.json` | 65 個來源定義（SSOT，Schema v2） |
| `v2/data/kol.json` | 大佬/機構社群帳號清單 |
| `v2/data/fetch-report.json` | 最新可用性測試報告（自動產生） |
| `v2/scripts/test-sources.mjs` | 可用性測試器 |
| `v2/index.html` | 前端入口 |
| `v2/app.js` | 前端渲染邏輯 |

---

## 本機執行

```bash
# 安裝依賴（根目錄或 v1/）
npm install

# 測試所有來源可用性（結果印在終端）
node v2/scripts/test-sources.mjs

# 產生測試報告（供前端顯示）
node v2/scripts/test-sources.mjs --report v2/data/fetch-report.json
```

---

## 自動更新

GitHub Actions 每小時整點自動執行，測試所有來源並更新 `fetch-report.json`，部署到 GitHub Pages。

設定檔：`.github/workflows/update-data.yml`（步驟：`Update V2 source availability report`）

> 此步驟設有 `continue-on-error: true`，測試失敗不會阻斷整個部署流程。

---

## 下一階段（Phase 1）

V4 已承接 Phase 1 任務：對 55 個 PASS 來源實際抓取內容，儲存到 SQLite，並顯示在前端。
