---
marp: true
theme: gaia
paginate: true
style: |
  section {
    font-family: "Microsoft JhengHei", "Noto Sans TC", sans-serif;
    background: #0d1b2a;
    color: #e8f0fe;
    font-size: 22px;
    padding: 44px 56px;
    border-top: 6px solid #3b82f6;
  }
  h1 {
    color: #60a5fa;
    font-size: 1.45em;
    border-bottom: 2px solid #3b82f6;
    padding-bottom: 0.2em;
    margin-bottom: 0.35em;
  }
  h2 { color: #93c5fd; font-size: 1.05em; margin: 0.15em 0 0.25em; }
  h3 { color: #bfdbfe; font-size: 0.92em; margin: 0.25em 0 0.15em; font-weight: 600; }
  p   { color: #e8f0fe; margin: 0.15em 0; font-size: 0.92em; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.86em;
    margin-top: 0.35em;
    background: #0d1b2a;
  }
  thead tr { background: #1d4ed8 !important; }
  th {
    background: #1d4ed8 !important;
    color: #ffffff !important;
    padding: 8px 12px;
    font-weight: 700;
    text-align: left;
    border: 1px solid #2563eb;
  }
  tbody tr { background: #0d1b2a !important; }
  tbody tr:nth-child(even) { background: #162032 !important; }
  td {
    background: inherit !important;
    color: #e8f0fe !important;
    padding: 7px 12px;
    border: 1px solid #1e3a5f;
  }
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
    font-size: 0.8em;
    line-height: 1.6;
    margin: 0.35em 0;
  }
  pre code { background: none; padding: 0; color: #a5f3d0; }
  ul { margin: 0.2em 0; padding-left: 1.3em; }
  ul li { color: #e8f0fe; margin-bottom: 0.28em; font-size: 0.9em; }
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
  section.small { font-size: 19px; }
  section.small table { font-size: 0.82em; }
  section::after { color: #64748b; font-size: 0.7em; }
  .tag-done { color: #34d399; font-weight: 700; }
  .tag-wip  { color: #fbbf24; font-weight: 700; }
---

<!-- _class: title -->

# CryptoPulse
## 進度報告

2026-03-25

---

# 目錄

1. 專案現況快覽
2. 本週完成項目摘要
3. 架構建立
4. 部署上線 + 密碼保護
5. V2 整合 + Polymarket
6. V4 原始資料庫 + Gate Score
7. 本機 Server + Coinglass 整合
8. 現況架構總覽
9. 待討論項目

---

# 專案現況快覽

## CryptoPulse — 加密市場情報儀表板

| 版本 | 定位 | 狀態 |
|------|------|------|
| **V1** | 分析儀表板（8 維度 Gate Score + 趨勢評估） | ✅ 運行中 |
| **V2** | 65 來源健康檢查（PASS / SKIP / FAIL） | ✅ 運行中 |
| **V3** | Coinglass 衍生品深度資料視覺化 | ✅ 運行中 |
| **V4** | 55 來源原始資料庫 | ✅ 運行中 |

**正式網址：** `https://rex0227.github.io/news-website` ｜ **密碼：** `TRAXXAS`

---

<!-- _class: small -->

# 本週完成項目摘要

| 項目 | 說明 |
|------|------|
| 前後端架構 | Node.js + Express + SQLite + Upstash Redis |
| GitHub Pages 部署 | 靜態網頁免費托管，密碼保護（TRAXXAS） |
| V2 來源健康檢查 | 65 來源 PASS/SKIP/FAIL 自動測試報告 |
| Polymarket 整合 | ETH 預測市場賠率資料 |
| V4 原始資料庫 | 55 來源實際抓取結果全展示 |
| Gate Score 雷達圖 | 8 維度 × -3 到 +3，視覺化市場評分 |
| Coinglass 真實數據 | 資金費率、持倉量、爆倉、多空比等 6 項整合 Gate Score |
| Gate Score 圖例 | 全開 / 偏開 / 半開 / 偏關 / 全關 五段說明 |
| 本機常駐 Server | 每 2 分鐘自動更新 V1/V3/V4，取代 GitHub Actions |
| 開機自動啟動 | Windows 工作排程器設定 |

**本週累計：** 四個版本全數上線，資料更新架構完整，最大延遲 4 分鐘

---

# 架構建立

## 完整前後端骨架搭建完成

### 完成項目

- **Node.js 後端**：Express.js 框架，處理 API 路由與資料收集
- **SQLite 資料庫**：`backend/gecko.db`，儲存宏觀 + 加密事件資料
- **V1 Collectors**：10 個資料收集器（美日宏觀、加密訊號、清算、政策）
- **Upstash Redis**：雲端資料庫，前後端資料橋接
- **規則型趨勢評估**：不呼叫 LLM，純邏輯自動生成市場評估

### 資料收集器清單

| 分類 | 來源 |
|------|------|
| 宏觀（美） | BLS、Fed（CPI/NFP/PPI/FOMC） |
| 宏觀（日） | BOJ 行事曆 |
| 加密新聞 | CoinDesk / CoinTelegraph RSS |
| 市場結構 | CoinGecko（非價格）、Fear & Greed |
| 清算 | Coinalyze、Binance、Hyperliquid |

---

# 部署上線 + 密碼保護

## GitHub Pages 正式對外，加入存取控制

### GitHub Pages 自動部署

```
v1/docs/* → .deploy-site/ → push → GitHub Pages
```

- 靜態網頁（HTML / CSS / JS）免費托管
- GitHub Actions 處理自動部署流程

### 密碼保護機制

```
使用者開啟網頁 → 全螢幕密碼遮罩
        ↓
輸入密碼 TRAXXAS → localStorage 記錄
        ↓
V1 / V2 / V4 共用同一登入狀態（只需輸入一次）
```

| 頁面 | 密碼保護 |
|------|----------|
| V1 分析儀表板 | ✅ |
| V2 健康檢查 | ✅ |
| V4 原始資料庫 | ✅ |

---

# V2 整合 + Polymarket

## 來源健康檢查上線，加入預測市場資料

### V2 來源健康檢查

| 狀態 | 數量 | 說明 |
|------|------|------|
| ✅ PASS | 55 | 正常抓取 |
| ⏭ SKIP | 10 | 需 API Key（X/Twitter 等） |
| ❌ FAIL | 0 | 無失效來源 |

涵蓋 **19 個分類**：宏觀統計、利率、政策監管、衍生品、流動性、鯨魚機構、加密新聞、地緣風險…

### Polymarket ETH 預測市場

- 整合 Polymarket 智能合約賠率資料
- 顯示 ETH 相關預測市場當前多空比例
- 作為 V1 Gate Score「ETH 預測市場」維度的數據來源

---

<!-- _class: small -->

# V4 原始資料庫 + Gate Score

## 原始資料全展示，加入 8 維度市場評分

### V4 原始資料庫

```
sources.json（55 PASS 來源）→ collect-all.mjs（5 並行）
  CSV  → FRED 時間序列（最新值 + 前值 + 變化%）
  RSS  → 最新 3 筆標題
  JSON → 截取 3 筆資料
  HTML → Cheerio 解析，500 字摘要
        ↓
SQLite gecko_v4.db + Upstash → V4 前端分類展示
```

### V1 Gate Score 雷達圖

| 維度 | 評分說明 |
|------|---------|
| 市場情緒 | Fear & Greed 指數 |
| 宏觀變數 | CPI/NFP/FOMC 事件 |
| 資金流向 | 穩定幣市值、TVL |
| 槓桿大戶風險 | 資金費率、持倉量 |
| 巨鯨走向 | Hyperliquid 大戶部位 |
| 政策監管 | SEC/CFTC/白宮訊號 |
| 外部風險 | 地緣、全球風險事件 |
| ETH 預測市場 | Polymarket 賠率 |

每維度 -3 到 +3，雷達圖視覺化呈現

---

<!-- _class: small -->

# 本機 Server + Coinglass 整合

## 架構全面升級

### ① 本機常駐 Server 取代 GitHub Actions

```
keep-alive.mjs（電腦常駐）每 2 分鐘依序執行：
  V1 update-data.mjs  → Upstash
  V4 collect-all.mjs  → Upstash
  V3 sync_coinglass.py → Upstash
```

- 開機自動啟動（Windows 工作排程器）
- GitHub Actions 排程已關閉，僅保留手動部署

### ② Coinglass 真實數據整合 Gate Score

| 維度 | 資料來源 |
|------|---------|
| 資金費率 | Coinglass fundingRate |
| 持倉量變化 | Coinglass openInterestAggregated |
| 爆倉資料 | Coinglass aggregatedLiquidation |
| 多空比 | Coinglass globalLongShortAccountRatio |
| ETF 資金流 | Coinglass etfFlowHistory |
| 鯨魚部位 | Coinglass hyperliquidWhalePosition |

### ③ Gate Score 新增五段閘門圖例

| 閘門狀態 | 平均分範圍 | 意義 |
|---------|-----------|------|
| 🟢 全開 | ≥ +1.5 | 多頭環境，積極做多 |
| 🟢 偏開 | +0.5 ～ +1.5 | 偏多，謹慎做多 |
| 🟡 半開 | -0.5 ～ +0.5 | 震盪觀望，不宜重倉 |
| 🔴 偏關 | -1.5 ～ -0.5 | 偏空，謹慎做空 |
| 🔴 全關 | ≤ -1.5 | 空頭環境，避免進場 |


---

# 現況架構總覽

## 資料流

```
外部 API（65 個來源）
      ↓
本機常駐 Server（每 2 分鐘）
  ├── V1：Node.js 規則型評估 → Upstash
  ├── V3：Python Coinglass 同步 → Upstash
  └── V4：55 來源抓取 → SQLite → Upstash
      ↓
瀏覽器（每 2 分鐘自動拉）→ 顯示最新資料
```

**最大延遲：4 分鐘**

## 四版網址

| 版本 | 網址 |
|------|------|
| V1 主儀表板 | https://rex0227.github.io/news-website |
| V2 健康檢查 | https://rex0227.github.io/news-website/v2 |
| V3 衍生品資料 | https://rex0227.github.io/news-website/v3 |
| V4 原始資料庫 | https://rex0227.github.io/news-website/v4 |

---

<!-- _class: small -->

# 待討論項目

### 🔴 高優先

| 項目 | 現況 | 需決策 |
|------|------|--------|
| **Coinglass API 授權確認** | Key 已存在，V1/V3 已整合 | 確認訂閱方案是否包含所有端點 |
| **V3 正式上線** | 開發完成，未公開 | 確認 Coinglass 授權後部署 |

### 🟡 中優先

| 項目 | 現況 | 需決策 |
|------|------|--------|
| **社群監控 KOL/X** | 10 個來源 SKIP | X API 月費是否值得投入 |
| **xlsx 收集器** | BOJ/Atlanta Fed 2 個 SKIP | 是否用 SheetJS 補上 |

### 🟢 下階段規劃

- V3 上線後：Coinglass 深度資料儀表板對外開放
- Gate Score 持續優化：加入更多 Coinglass 維度
- 考慮加入 LINE Notify / Telegram 警報推送

---

<!-- _class: title -->

# 謝謝

`https://rex0227.github.io/news-website`

密碼：`TRAXXAS`

2026-03-25 開會
