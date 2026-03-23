# CryptoPulse V1 — 市場情報儀表板

加密市場情報儀表板，整合美國/日本宏觀事件與加密市場非價格訊號，提供短/中/長線趨勢評估。

**正式網址：** `https://rex0227.github.io/news-website`
**存取密碼：** `TRAXXAS`

---

## 定位

| 版本 | 定位 |
|------|------|
| **V1（本版）** | 分析儀表板 — 整合 18 個來源，輸出趨勢結論 |
| V2 | 來源健康檢查 — 確認 65 個來源是否正常運作 |
| V4 | 原始資料庫 — 實際抓取 55 個來源的內容 |

---

## 核心約束（不可違反）

1. **不顯示幣價**（禁止 price endpoint / price 卡片）
2. **不呼叫外部 LLM API**（趨勢評估為規則型邏輯）
3. **不使用 OKX/OKC** 作為清算資料來源
4. **7D 變化**抓不到就不顯示（避免誤導）
5. **新聞只取最新單筆**（嚴禁多篇數字加總）

---

## 架構

```
外部 API (18 個來源)
        ↓
Node.js 收集器 (v1/src/collectors/)
        ↓
規則型趨勢評估 (v1/src/lib/ai.js)
        ↓
        ├── Upstash Redis（雲端，前端讀取）
        └── SQLite (backend/gecko.db)（本機備份）
        ↓
前端 (v1/docs/) → GitHub Pages
```

---

## 資料來源（18 個）

| 分類 | 來源 |
|------|------|
| 宏觀日程 | BLS ICS、Fed FOMC |
| 日本宏觀 | BOJ 行事曆 |
| 加密新聞 | CoinDesk RSS、CoinTelegraph RSS |
| 市場結構 | CoinGecko Global、Alternative.me Fear & Greed |
| 政策/監管 | 白宮、US Treasury、Fed、SEC、CFTC（RSS） |
| 利率/殖利率 | FRED（DGS10、DGS2、DGS3MO） |
| 流動性 | DeFiLlama 穩定幣、DeFi TVL |
| 清算 | Coinalyze API（需金鑰）、Binance/Hyperliquid（備援） |

---

## 前端頁面區塊

1. 市場趨勢總覽（恐懼貪婪、主導率）
2. 交易員重點摘要
3. 短/中/長線總趨勢
4. 未來 7 日關鍵窗口
5. 美日宏觀事件日程
6. 加密訊號
7. 巨鯨走向
8. 政策/監管
9. 外部風險
10. Polymarket 預測市場

---

## 本機啟動

```bash
# 安裝依賴
cd v1 && npm install

# 更新資料（寫入 Upstash + SQLite）
node v1/scripts/update-data.mjs

# 啟動本機後端 API（port 3000）
cd backend && npm install && npm start
```

---

## 自動更新

GitHub Actions 每小時整點自動執行，更新資料並部署到 GitHub Pages。

設定檔：`.github/workflows/update-data.yml`

---

## 環境變數

複製 `.env.example` → `.env`，填入：

| 變數 | 必要性 |
|------|--------|
| `UPSTASH_REDIS_REST_URL` | 必填 |
| `UPSTASH_REDIS_REST_TOKEN_WRITE` | 必填 |
| `UPSTASH_REDIS_REST_TOKEN_READ` | 建議 |
| `COINGLASS_API_KEY` | database-side 必填 |
| `COINALYZE_API_KEY` | 建議（清算硬數據） |

---

## Upstash Keys

| Key | 用途 |
|-----|------|
| `crypto_dashboard:latest` | 主 payload（前端讀取） |
| `crypto_dashboard:last_updated` | 更新時間戳 |
