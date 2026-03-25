---
marp: true
theme: gaia
paginate: true
style: |
  /* ── 基礎版面 ── */
  section {
    font-family: "Microsoft JhengHei", "Noto Sans TC", sans-serif;
    background: #0d1b2a;
    color: #e8f0fe;
    font-size: 24px;
    padding: 44px 56px;
    border-top: 6px solid #3b82f6;
  }

  /* ── 標題層級 ── */
  h1 {
    color: #60a5fa;
    font-size: 1.5em;
    border-bottom: 2px solid #3b82f6;
    padding-bottom: 0.2em;
    margin-bottom: 0.35em;
  }
  h2 { color: #93c5fd; font-size: 1.05em; margin: 0.15em 0 0.25em; }
  h3 { color: #bfdbfe; font-size: 0.92em; margin: 0.25em 0 0.15em; font-weight: 600; }
  p   { color: #e8f0fe; margin: 0.15em 0; font-size: 0.95em; }

  /* ── 表格：完整覆蓋，避免淺色底殘留 ── */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.88em;
    margin-top: 0.35em;
    background: #0d1b2a;
  }
  thead tr { background: #1d4ed8 !important; }
  th {
    background: #1d4ed8 !important;
    color: #ffffff !important;
    padding: 9px 14px;
    font-weight: 700;
    text-align: left;
    border: 1px solid #2563eb;
    font-size: 1em;
  }
  tbody tr { background: #0d1b2a !important; }
  tbody tr:nth-child(even) { background: #162032 !important; }
  td {
    background: inherit !important;
    color: #e8f0fe !important;
    padding: 8px 14px;
    border: 1px solid #1e3a5f;
    font-size: 1em;
  }

  /* ── 程式碼 ── */
  code {
    background: #1e3a5f;
    color: #6ee7b7;
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 0.85em;
  }
  pre {
    background: #111f35;
    color: #a5f3d0;
    padding: 14px 18px;
    border-radius: 8px;
    border-left: 4px solid #3b82f6;
    font-size: 0.82em;
    line-height: 1.6;
    margin: 0.35em 0;
  }
  pre code { background: none; padding: 0; color: #a5f3d0; }

  /* ── 清單 ── */
  ul { margin: 0.2em 0; padding-left: 1.3em; }
  ul li { color: #e8f0fe; margin-bottom: 0.3em; font-size: 0.92em; }

  /* ── 封面頁 ── */
  section.title {
    text-align: center;
    background: linear-gradient(145deg, #0d1b2a 0%, #1e3a5f 60%, #0d1b2a 100%);
    border-top: none;
    border-left: 8px solid #3b82f6;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
  }
  section.title h1 { border: none; font-size: 2.2em; color: #60a5fa; margin-bottom: 0.1em; }
  section.title h2 { color: #93c5fd; font-size: 1.2em; }
  section.title p  { color: #94a3b8; font-size: 0.95em; margin-top: 0.8em; }

  /* ── 精簡字級（內容較多的投影片） ── */
  section.small { font-size: 20px; }
  section.small pre { font-size: 0.78em; }
  section.small table { font-size: 0.84em; }

  /* ── 頁碼 ── */
  section::after { color: #64748b; font-size: 0.7em; }
---

<!-- _class: title -->

# CryptoPulse
## 架構進度報告

**前端 · 後端 · 資料庫 · 自動部署**

2026-03-24（更新版）

---

# 目錄

1. 專案簡介
2. 四版架構總覽
3. 整體資料流（最新）
4. 本機常駐 Server
5. 密碼保護機制
6. V2 來源健康檢查
7. V4 原始資料收集
8. 四版互相切換導覽
9. V1 Gate Score — 8 維度市場評分
10. 本週完成項目摘要
11. 待討論項目
12. 技術名詞速查

---

<!-- _class: small -->

# 專案簡介

## CryptoPulse — 加密市場情報儀表板

整合 **美國/日本宏觀事件** 與 **加密市場非價格訊號**，提供短/中/長線趨勢評估

### 鐵律（任何情況下不可違反）

| 規則 | 說明 |
|------|------|
| 不顯示幣價 | 禁止任何現貨價格卡片 |
| 不呼叫外部 LLM | 趨勢評估為規則型邏輯 |
| 不使用 OKX/OKC | 清算資料來源限制 |
| 新聞只取最新單筆 | 嚴禁多篇數字加總 |

**正式網址：** `https://rex0227.github.io/news-website` ｜ **密碼：** `TRAXXAS`

---

# 四版架構總覽

| 版本 | 定位 | 狀態 |
|------|------|------|
| **V1** | 分析儀表板 — 18 個來源，輸出趨勢結論 | ✅ 運行中 |
| **V2** | 來源健康檢查 — 65 個來源 PASS/SKIP/FAIL | ✅ 運行中 |
| **V3** | Coinglass 衍生品深度資料儀表板 | ✅ 運行中 |
| **V4** | 原始資料庫 — 55 個來源實際抓取內容 | ✅ 運行中 |

### database-side（獨立模組）

Python 程式，定時把 Coinglass API 資料同步到 Upstash，供 V3 讀取

---

<!-- _class: small -->

# 整體資料流（最新）

```
外部 API（65 個來源）
      ↓
本機常駐 Server（每 2 分鐘）
      ├── V1：Node.js 收集器 → 規則型趨勢評估 → Upstash
      └── V4：55 來源抓取 → SQLite → Upstash
      ↓
瀏覽器（每 2 分鐘自動拉）→ 顯示最新資料

GitHub → 只負責前端網頁托管（HTML/CSS/JS）
Coinglass API（付費）→ database-side（本機 Python）→ Upstash → V3
```

**最大延遲：4 分鐘**

---

# 本機常駐 Server

## 為何改用本機執行？

GitHub Actions 設計用於 CI/CD 部署，不適合作為高頻資料更新引擎：
觸發延遲高、排程精度低，無法滿足即時市場資料需求。

改為**本機常駐 Server**，直接掌控更新節奏，資料即時性大幅提升。

### 架構

```
keep-alive.mjs（本機執行）
      ↓ 每 2 分鐘
  V1 update-data.mjs        → Upstash（crypto_dashboard:latest）
  V4 collect-all.mjs        → Upstash（cryptopulse:v4:latest）
  V3 sync_coinglass_to_upstash.py → Upstash（coinglass:derivatives）
```

### 效益比較

| 項目 | GitHub Actions | 本機常駐 Server |
|------|---------------|----------------|
| 更新頻率 | 最快每小時 1 次 | 每 2 分鐘（快 30 倍） |
| 排程精度 | 不穩定，常延遲 | 精準可控 |
| 資料即時性 | 低 | 高 |
| 開機自動啟動 | — | ✅ Windows 工作排程器 |

---

# 密碼保護機制

## 公開 GitHub Pages + sessionStorage 密碼控制

### 運作方式

```
使用者開啟網頁
        ↓
全螢幕密碼遮罩
        ↓
輸入密碼 TRAXXAS
        ↓
localStorage 記錄登入狀態
        ↓
頁面解鎖（V1/V2/V4 共用同一登入狀態，只需輸入一次）
```

### 已套用範圍

| 頁面 | 密碼保護 |
|------|----------|
| V1 主儀表板 | ✅ |
| V2 來源健康檢查 | ✅ |
| V3 衍生品資料 | ✅ |
| V4 原始資料庫 | ✅ |

---

# V2 來源健康檢查

## 65 個來源 × 每小時自動測試

### 目前狀態（2026-03-23）

| 狀態 | 數量 | 說明 |
|------|------|------|
| ✅ PASS | 55 | 正常抓取 |
| ⏭ SKIP | 10 | 需 API Key 或授權（X/Twitter 等） |
| ❌ FAIL | 0 | 無失效來源 |

### 來源分類（19 類）

宏觀事件 / 統計數據（美日）、利率殖利率、政策監管（美日國際）、
加密市場結構、衍生品、流動性、鯨魚機構、交易所公告、
安全事件、傳統市場代理、地緣新聞、加密新聞、宏觀新聞、社群訊號

---

<!-- _class: small -->

# V4 原始資料收集

## 55 個 PASS 來源 → 實際抓取 → 前端展示

```
sources.json（55 個 PASS 來源）→ collect-all.mjs（5 個並行）
      ↓
四種收集器（依格式分派）
  CSV     → FRED 時間序列（最新值 + 前值 + 變化%）
  RSS/ICS → 最新 3 筆標題
  JSON    → 截取 3 筆 / 5000 字元
  HTML    → Cheerio 解析，500 字摘要
      ↓
SQLite gecko_v4.db + latest.json → V4 前端分類顯示
```

### 實際收集結果（2026-03-23）

| 狀態 | 數量 | 說明 |
|------|------|------|
| ✅ 成功 | 52 | 正常抓取完成 |
| ⏭ 略過 | 2 | xlsx 格式（BOJ/Atlanta Fed），暫不支援 |
| ❌ 失敗 | 1 | DeFiLlama Hacks（HTTP 429 限速，偶發） |

---

# 四版互相切換導覽

## V1 / V2 / V3 / V4 全數互聯

| 所在版本 | 可切換至 |
|---------|---------|
| V1 主頁 | → V2、→ V3、→ V4 |
| V2 健康檢查 | → V1、→ V3、→ V4 |
| V3 衍生品資料 | → V1、→ V2、→ V4 |
| V4 原始資料 | → V1、→ V2、→ V3 |

### 部署路徑對應

```
https://rex0227.github.io/news-website/          ← V1
https://rex0227.github.io/news-website/v2/       ← V2
https://rex0227.github.io/news-website/v3/       ← V3
https://rex0227.github.io/news-website/v4/       ← V4
```

---

<!-- _class: small -->

# V1 Gate Score — 8 維度市場評分

## Coinglass API 真實數據驅動，精準評估市場狀態

| 維度 | 資料來源 | 說明 |
|------|---------|------|
| 市場情緒 | Fear & Greed 指數 | 0–100 恐慌貪婪量化 |
| 宏觀變數 | CPI / NFP / FOMC | 美日重要數據事件 |
| 資金流向 | 穩定幣市值、TVL | DeFiLlama 流動性指標 |
| 槓桿大戶風險 | Coinglass 資金費率 / 持倉量 | 衍生品市場槓桿狀況 |
| 巨鯨走向 | Coinglass 鯨魚部位 / 多空比 | 大戶實際倉位方向 |
| 政策監管 | SEC / CFTC / 白宮 RSS | 監管訊號強弱 |
| 外部風險 | 地緣、全球風險事件 | 黑天鵝與系統性風險 |
| ETH 預測市場 | Polymarket 賠率 | 市場對 ETH 走向的定價 |

### 五段閘門狀態

| 閘門 | 分數 | 意義 |
|------|------|------|
| 🟢 全開 | ≥ +1.5 | 多頭環境，積極做多 |
| 🟢 偏開 | +0.5 ～ +1.5 | 偏多，謹慎做多 |
| 🟡 半開 | -0.5 ～ +0.5 | 震盪觀望，不宜重倉 |
| 🔴 偏關 | -1.5 ～ -0.5 | 偏空，謹慎做空 |
| 🔴 全關 | ≤ -1.5 | 空頭環境，避免進場 |

---

<!-- _class: small -->

# 本週完成項目摘要

| 日期 | 完成項目 |
|------|---------|
| 03-20 | 完整前後端架構設定（Express + SQLite） |
| 03-21 | GitHub Pages 自動部署上線 |
| 03-21 | 密碼保護（TRAXXAS）套用 V1/V2 |
| 03-22 | V2 自動更新可用性報告，正式整合部署 |
| 03-22 | Polymarket 預測市場資料整合 |
| 03-23 | V4 Phase 1 建立（55 來源 + SQLite + 前端） |
| 03-23 | V1 / V2 / V4 三版互相切換導覽 |
| 03-23 | V1 Gate Score 雷達圖（8 維度，-3 到 +3） |
| 03-23 | V1/V2/V4 單一登入（localStorage 共用） |
| 03-24 | 本機常駐 Server（keep-alive.mjs）取代 GitHub Actions 排程 |
| 03-24 | V4 資料改推 Upstash，脫離 GitHub 排程 |
| 03-24 | 前端每 2 分鐘自動拉資料，後端每 2 分鐘更新，最大延遲 4 分鐘 |
| 03-24 | 開機自動啟動設定（Windows 工作排程器） |
| 03-24 | V1/V3 整合 Coinglass 真實數據，升級 Gate Score 8 維度評分 |
| 03-24 | Gate Score 新增五段閘門圖例（全開/偏開/半開/偏關/全關），當前狀態高亮 |
| 03-24 | 部署從 Felicia980317/CryptoPulse-site 遷移至 REX0227/news-website |

---

<!-- _class: small -->

# 待討論項目

## 需要團隊決策的方向

### 🔴 高優先

| 項目 | 現況 | 下一步 |
|------|------|--------|
| **Coinglass API 整合** | Key 存在，端點授權待確認 | 確認訂閱方案 → 整合 V1 + V3 |
| **V3 正式上線** | ✅ 已上線，Coinglass API 整合完成 | — |

### 🟡 中優先

| 項目 | 現況 | 下一步 |
|------|------|--------|
| **社群監控 KOL/X** | 10 個來源 SKIP，需 X API | 確認 API 費用後決策 |
| **xlsx 收集器** | BOJ/Atlanta Fed 2 個 SKIP | 用 SheetJS 解析（未做） |

---

<!-- _class: title -->

# 技術名詞速查

| 名詞 | 說明 |
|------|------|
| **GitHub Actions** | GitHub 內建 CI/CD，設定排程自動執行腳本 |
| **GitHub Pages** | 靜態網站免費託管，從 repo 直接部署 |
| **Upstash Redis** | 雲端 Redis，用 REST API 讀寫，無需伺服器 |
| **SQLite** | 嵌入式資料庫，資料存在單一 `.db` 檔案 |
| **node:sqlite** | Node.js v22+ 內建 SQLite，無需額外安裝 |
| **Express.js** | Node.js 後端框架，處理 HTTP 請求/回應 |
| **sessionStorage** | 瀏覽器暫存，關閉分頁即清除 |
| **Marp** | Markdown 轉 PPT/PDF 工具 |
| **Coinglass** | 加密衍生品數據平台（付費 API）|
| **database-side** | 本專案的 Python 同步模組，Coinglass → Upstash |
