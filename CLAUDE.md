# CryptoPulse — CLAUDE.md

## 專案定位

加密市場資訊儀表板：整合美國/日本宏觀事件（CPI/NFP/FOMC/BOJ）與加密市場非價格訊號（清算、資金流、大戶動向、監管），提供短/中/長線趨勢評估。

---

## 鐵律（不可違反，任何情況下）

1. **不抓取、不顯示幣價**（CoinGecko `simple/price`、任何現貨價格卡片均禁止）
2. **不呼叫外部 LLM API**（OpenAI 等）；V1 使用規則型邏輯自動評估（無需 API key）
3. **不使用 OKX/OKC** 作為清算資料來源
4. **新聞提取金額只取「最新單筆」**，嚴禁多篇數字加總（防重複計算）
5. **7D 變化若抓不到就不顯示**，不得以 "—/未提供" 佔位

---

## 版本結構

| 路徑 | 狀態 | 用途 |
|------|------|------|
| `v1/` | 運行中（主站） | 宏觀事件 + 訊號整合前端 |
| `v2/` | Phase 0 | 資訊來源清單治理 / 可用性測試 |
| `v3/` | 開發中（未發布） | database-side 結構資料視覺化 |
| `database-side/` | 獨立 Python 程式 | 定時同步 Coinglass → Upstash |
| `.deploy-site/` | 獨立 Git repo | GitHub Pages 唯一發布管道 |

---

## 常用指令

```bash
# V1：安裝依賴（在 v1/ 目錄下）
npm install

# V1：更新資料（完整工作流見下方）
node v1/scripts/update-data.mjs

# V1：檢查 Upstash 目前 payload 摘要
node v1/scripts/inspect-upstash.mjs

# Polymarket ETH 預測市場賠率更新（輸出到 v1/docs/data/polymarket_eth.json）
node scripts/polymarket_eth.mjs

# V2：測試所有資料來源可用性
node v2/scripts/test-sources.mjs

# V2：產生測試報告（供前端顯示）
node v2/scripts/test-sources.mjs --report v2/data/fetch-report.json

# database-side：dry run
python database-side/sync_coinglass_to_upstash.py --dry-run

# database-side：正式上傳
python database-side/sync_coinglass_to_upstash.py

# database-side：常駐每 30 分鐘執行
python database-side/sync_coinglass_to_upstash.py --loop --every-minutes 30
```

---

## V1 資料更新工作流（自動 AI 評估）

V1 現已整合 Claude API 自動生成交易員評估，**單一指令即可完成整個流程**：

```bash
node v1/scripts/update-data.mjs
```

執行流程：
1. 抓取所有宏觀/加密/風險資料
2. 檢查是否存在 `v1/data/copilot-evaluation.json`（手動評估覆蓋）
   - **若存在**：使用手動評估（優先）
   - **若不存在**：以規則型邏輯自動分析已收集數據，生成評估（不呼叫任何 LLM）
3. 組合完整 payload 並推送到 Upstash

**環境變數需求：**
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN_WRITE`（推送用）
- 評估本身為規則型邏輯，**不需要任何 API key**

**手動覆蓋模式（可選）：**
將評估寫入 `v1/data/copilot-evaluation.json`，下次執行時優先使用（不呼叫 Claude API）。
用完後刪除檔案，即恢復自動模式。

**評估固定 10 個段落標籤：**
`政治/政策`、`央行/利率`、`美/日政策`、`機構資金流`、`巨鯨/鏈上`、`散戶/槓桿`、`市場結構`、`催化/節奏`、`觀察指標`、`失效條件`

---

## V1 Collectors 一覽

| 收集器 | 資料來源 |
|--------|---------|
| `usMacroCollector` | BLS、Fed（CPI/NFP/PPI/FOMC） |
| `japanMacroCollector` | BOJ 行事曆 |
| `cryptoImpactCollector` | CoinDesk/CoinTelegraph RSS（分類配額去重） |
| `globalRiskCollector` | 地緣/外部風險訊號 |
| `marketIntelCollector` | CoinGecko global（非價格）、Fear&Greed |
| `policyCollector` | 白宮/Fed/SEC/CFTC/財政部 RSS |
| `ratesCollector` | FRED CSV（3M/2Y/10Y 殖利率） |
| `liquidityCollector` | DeFiLlama（穩定幣市值、TVL） |
| `coinalyzeLiquidationCollector` | Coinalyze API（7D 清算硬數據，需 key） |
| `majorNoKeyLiquidationCollector` | Binance/Hyperliquid（備援，免 key） |

---

## Upstash Keys

| Key | 用途 |
|-----|------|
| `crypto_dashboard:latest` | V1 主 payload（前端讀取） |
| `crypto_dashboard:last_updated` | V1 更新時間戳 |
| `cryptopulse:database:coinglass:derivatives` | database-side 結構資料（V3 讀取） |
| `cryptopulse:database:coinglass:last_updated` | database-side 更新時間戳 |

---

## 部署流程（手動）

1. 同步 V1 前端：`v1/docs/*` → `.deploy-site/*`
2. 同步 V2：`v2/index.html` → `.deploy-site/v2/index.html`
3. 同步 V2 測試報告：`v2/data/fetch-report.json` → `.deploy-site/v2/data/fetch-report.json`
4. 同步 V3（確認穩定後）：`v3/*` → `.deploy-site/v3/*`
5. 在 `.deploy-site/` 內：`git add -A && git commit -m "Update site" && git push`

> `.deploy-site/` 是唯一部署工作目錄，push 目標為 `Felicia980317/CryptoPulse-site`（GitHub Pages）。

---

## 環境變數（.env）

| 變數 | 必要性 |
|------|--------|
| `UPSTASH_REDIS_REST_URL` | 必填 |
| `UPSTASH_REDIS_REST_TOKEN_WRITE` | 必填 |
| `UPSTASH_REDIS_REST_TOKEN_READ` | 建議 |
| `COINALYZE_API_KEY` | 建議（7D 清算硬數據） |
| `COINGLASS_API_KEY` | database-side 必填 |

---

## 程式碼規範

- Node.js 使用 ESM（`"type": "module"`），全用 `import ... from`，禁用 CommonJS
- 各版本（v1/v2/v3/database-side）嚴格隔離，不混用
- 暫時性偵錯腳本放 `tmp/`，不要散落在根目錄
- UI 文字一律繁體中文（zh-Hant）
