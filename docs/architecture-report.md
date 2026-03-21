---
marp: true
theme: default
paginate: true
style: |
  section {
    font-family: "Microsoft JhengHei", "Noto Sans TC", sans-serif;
    background: #0f172a;
    color: #e2e8f0;
  }
  h1 { color: #38bdf8; font-size: 2em; border-bottom: 2px solid #38bdf8; padding-bottom: 0.3em; }
  h2 { color: #7dd3fc; font-size: 1.5em; }
  h3 { color: #93c5fd; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th { background: #1e40af; color: #fff; padding: 8px 12px; }
  td { padding: 7px 12px; border-bottom: 1px solid #334155; }
  tr:nth-child(even) td { background: #1e293b; }
  code { background: #1e293b; color: #34d399; padding: 2px 6px; border-radius: 4px; font-size: 0.85em; }
  pre { background: #1e293b; padding: 16px; border-radius: 8px; border-left: 4px solid #38bdf8; }
  pre code { background: none; padding: 0; }
  .highlight { color: #fbbf24; font-weight: bold; }
  section.title { text-align: center; }
  section.title h1 { border: none; font-size: 2.5em; }
  section.title p { font-size: 1.1em; color: #94a3b8; }
  ul li { margin-bottom: 0.3em; }
---

<!-- _class: title -->

# CryptoPulse
## 完整架構設定報告

**前端 · 後端 · 資料庫**

2026-03-20

---

# 目錄

1. 專案簡介
2. 原有架構 vs 新架構
3. 前端（Frontend）
4. 後端（Backend）— Express.js
5. 資料庫（Database）— SQLite
6. 資料管線更新
7. API 端點一覽
8. 啟動方式
9. 對外 Demo 分享
10. 未來規劃

---

# 專案簡介

## CryptoPulse — 加密市場情報儀表板

整合 **美國/日本宏觀事件** 與 **加密市場非價格訊號**，提供短/中/長線趨勢評估

### 資料來源（10+ 個）

| 類型 | 來源 |
|------|------|
| 宏觀事件 | BLS、Federal Reserve、BOJ |
| 加密訊號 | CoinGecko、Coinalyze、Hyperliquid |
| 政策/監管 | 白宮、SEC、CFTC RSS |
| 流動性 | DeFiLlama、ETF 資金流 |
| 預測市場 | Polymarket |

---

# 原有架構 vs 新架構

## 原有架構（僅雲端）

```
外部 API → Node.js 收集器 → Upstash Redis（雲端）→ 前端直讀
```

## 新架構（本地 + 雲端雙軌）

```
外部 API → Node.js 收集器 → Upstash Redis（雲端）
                          → SQLite（本地）← Express API Server
                                               ↓
                                          前端（優先讀本地 API）
                                          （備援讀 Upstash）
```

### 改動重點

- 新增本地 **Express.js API 伺服器**
- 新增本地 **SQLite 資料庫**
- 前端支援**雙來源備援切換**

---

# 前端（Frontend）

## 技術：HTML / CSS / JavaScript（Vanilla）

### 檔案位置：`v1/docs/`

| 檔案 | 用途 |
|------|------|
| `index.html` | 主儀表板頁面結構 |
| `app.js` | 資料讀取與 UI 渲染邏輯 |
| `styles.css` | 樣式設定 |

### 本次更新：雙來源讀取邏輯

```javascript
// 優先讀本地 API（3 秒超時）
const data = await fetchFromAPI();      // http://localhost:3000/api/dashboard

// 失敗時自動備援
const data = await fetchFromUpstash();  // Upstash Redis 雲端
```

右上角顯示資料來源標籤：`本地 API` 或 `Upstash`

---

# 後端（Backend）— Express.js

## 技術：Node.js + Express.js

### 檔案位置：`backend/`

| 檔案 | 用途 |
|------|------|
| `server.js` | Express 主程式，監聽 Port 3000 |
| `routes/api.js` | REST API 路由定義 |
| `database.js` | SQLite 初始化與 CRUD 函式 |
| `package.json` | 相依套件（Express、CORS、dotenv） |

### 使用技術名詞

- **Express.js** — Node.js 最主流 HTTP 框架
- **CORS** — 允許跨來源請求的安全機制
- **REST API** — 用 URL + HTTP 方法表示操作的 API 設計風格
- **dotenv** — 讀取 `.env` 環境變數

---

# 資料庫（Database）— SQLite

## 技術：Node.js 內建 `node:sqlite`（v22.5+）

> 不需安裝任何額外套件，零配置，資料存在單一 `.db` 檔案

### 資料表結構

| 資料表 | 用途 | 主要欄位 |
|--------|------|----------|
| `dashboard_data` | 儀表板快照 | key、value（JSON）、updated_at |
| `macro_events` | 宏觀事件 | title、date、country、importance |
| `crypto_signals` | 加密訊號 | signal_type、value、change_7d |
| `update_log` | 更新日誌 | status、collectors_ran、created_at |

### 效能設定

- **WAL 模式**（Write-Ahead Logging）— 允許同時讀寫，不互相鎖定

---

# 資料管線更新

## 新增：SQLite 同步寫入

`v1/scripts/update-data.mjs` 執行後同時寫入兩個地方：

```
執行 update-data.mjs
        ↓
抓取 10+ 外部 API（並行）
        ↓
        ├── 寫入 Upstash Redis（雲端備援）
        └── 寫入 SQLite gecko.db（本地 API 使用）
        ↓
記錄至 update_log 資料表
```

### 本次執行結果（2026-03-20 17:45）

- 87 個宏觀事件
- 16 個加密訊號
- 11 個收集器全數完成

---

# API 端點一覽

## Base URL：`http://localhost:3000/api`

| 方法 | 路徑 | 說明 |
|------|------|------|
| `GET` | `/health` | 伺服器狀態檢查 |
| `GET` | `/dashboard` | 完整儀表板資料 |
| `GET` | `/dashboard/updated` | 最後更新時間戳 |
| `GET` | `/macro-events` | 宏觀事件（支援 `?country=US&days=7`） |
| `GET` | `/signals` | 加密貨幣訊號列表 |
| `GET` | `/update-log` | 最近 10 筆更新記錄 |
| `POST` | `/dashboard` | 儲存新資料（供更新腳本呼叫） |

---

# 啟動方式

## 三個步驟啟動完整服務

### Step 1 — 安裝後端套件（只需一次）
```bash
cd schedule_website_v0_1/backend
npm install
```

### Step 2 — 啟動後端 API 伺服器
```bash
npm start
# 伺服器啟動於 http://localhost:3000
```

### Step 3 — 更新資料
```bash
node v1/scripts/update-data.mjs
# 抓取所有外部 API → 寫入 SQLite
```

開啟瀏覽器：**`http://localhost:3000`**

---

# 對外 Demo 分享

## 使用 localtunnel 建立臨時對外網址

```bash
npx localtunnel --port 3000
# 產生類似：https://flat-pets-drop.loca.lt
```

### 分享給外部人士

| 項目 | 內容 |
|------|------|
| 網址 | `https://flat-pets-drop.loca.lt` |
| 通行密碼 | 你的對外 IP（`61.220.176.252`） |

### 注意事項

- 網址為**臨時性**，關閉後失效
- 資料不會自動更新，需手動執行 `update-data.mjs`
- localtunnel 免費版連線偶爾不穩定

---

# 未來規劃

## 上線正式版建議方案

### GitHub Actions 自動排程（推薦）

```
GitHub Actions 每小時排程
        ↓
自動執行 update-data.mjs
        ↓
資料寫入 Upstash（雲端）
        ↓
GitHub Pages 前端自動顯示最新資料
```

### 免費額度評估

| 更新頻率 | 每月用量 | 建議 |
|----------|----------|------|
| 每 30 分鐘 | ~2,880 分鐘 | 略超，有風險 |
| **每 1 小時** | **~1,440 分鐘** | **建議，安全** |
| 每 6 小時 | ~240 分鐘 | 最省 |

---

<!-- _class: title -->

# 技術名詞速查

| 名詞 | 說明 |
|------|------|
| **Express.js** | Node.js 後端框架，處理 HTTP 請求/回應 |
| **REST API** | 用 URL + HTTP 方法表示操作的 API 設計風格 |
| **SQLite** | 無伺服器嵌入式資料庫，資料存在單一 `.db` 檔案 |
| **node:sqlite** | Node.js v22+ 內建 SQLite，無需安裝 |
| **WAL 模式** | SQLite 寫入最佳化，允許同時讀寫 |
| **CORS** | 瀏覽器安全機制，後端需明確允許跨來源請求 |
| **localtunnel** | 將本地 port 暴露到對外網址的工具 |
| **GitHub Actions** | GitHub 內建 CI/CD，可設定排程自動執行腳本 |
| **Upstash Redis** | 雲端 Redis，用 REST API 讀寫，無需伺服器 |
