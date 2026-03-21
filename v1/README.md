# CryptoPulse（宏觀日程 × 加密市場訊號）

這個專案是一個「靜態前端 + 自動資料更新管線」的儀表板：

- 顯示美國/日本重要宏觀事件（CPI/NFP/FOMC/BOJ…）的近期與未來窗口
- 整合加密市場的「非價格型」訊號（資金流、監管、外部風險、槓桿清算、巨鯨…）
- 顯示短/中/長線趨勢與理由（每次更新由交易員評估自動產生並覆蓋寫回 Upstash）

本專案的核心約束（不可違反）：

1. **網站端不顯示幣價**、更新端也不抓幣價（禁止 price endpoint / price 卡片）。
2. **不呼叫任何外部模型服務**：更新流程會同時產生交易員評估（短/中/長線 + 理由）並覆蓋寫回。
3. 「7D 變化」只在能計算/抓到時才顯示；抓不到就不顯示該行（避免誤導）。

---

## 架構總覽

- 前端（GitHub Pages）：`docs/`
	- `docs/index.html`：頁面區塊順序與容器
	- `docs/app.js`：讀取 Upstash payload、渲染所有區塊
	- `docs/styles.css`：樣式
- 更新管線（Node.js ESM）：
	- `scripts/update-data.mjs`：整合 collectors、寫入 Upstash
	- `src/collectors/*`：各資料源收集器
	- `scripts/inspect-upstash.mjs`：本機檢查 Upstash payload 摘要
- 儲存：Upstash Redis REST
	- key：`crypto_dashboard:latest`
	- key：`crypto_dashboard:last_updated`

> V1 已移除 GitHub Actions；更新採「你通知 → 我們手動執行更新/回寫」的流程。

---

## 本機初始化

```bash
npm install
```

---

## 環境變數（.env）

複製 `.env.example` → `.env`，填入：

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN_WRITE`（必填）
- `UPSTASH_REDIS_REST_TOKEN_READ`（建議：用於讀取既有資料、保留交易員結論）
- `COINALYZE_API_KEY`（建議：用於 7D 槓桿清算硬數據）
- `COINALYZE_LIQ_SYMBOLS`（可選，預設 `BTCUSDT_PERP.A,ETHUSDT_PERP.A`）

安全提醒：Upstash token 請放 GitHub Secrets，不要硬寫進程式碼。

補充：若有設定 `COINALYZE_API_KEY`，系統會優先使用 Coinalyze 的 `liquidation-history`
作為 `cryptoSignalMetrics7d.liquidationTotalUsd`，避免僅靠新聞文案估算清算規模。
若 Coinalyze 不可用，系統不會改用 OKX；僅保留主流交易所（Binance/Hyperliquid）no-key 可用性探測，
並在 payload 的 `liquidationIntelNoKey.exchangeBreakdown` 明確標示來源可用性與限制。
若 7D 內抓不到可量化清算金額，會以「最近一筆可量化的清算新聞」作暫代並加註 fallback 註記。

---

## 指令（Scripts）

### 1) 更新資料（寫入 Upstash）

```bash
npm run update:data
```

### 2) 檢查 Upstash 目前資料（摘要）

```bash
node scripts/inspect-upstash.mjs
```

---

## Payload 結構（crypto_dashboard:latest）

前端主要使用以下欄位（實際可能略有增減，以 `docs/app.js` 的讀取為準）：

- `macroEvents[]`：宏觀事件（US/JP，含 upcoming/recent）
- `cryptoSignals[]`：加密市場訊號（資金流/監管/風險/宏觀/市場）
- `marketOverview`：短/中/長線趨勢與理由（每次更新會重新評估並覆蓋寫回）
- `marketIntel`：非價格型市場總覽
	- `global`：CoinGecko global（總市值、成交量、市值變化、dominance）
	- `sentiment`：Fear & Greed 指標
- `policySignals[]`：政策/監管官方 RSS 整理
- `ratesIntel`：殖利率（FRED：3M/2Y/10Y + spreads）
- `liquidityIntel`：流動性硬數據（DeFiLlama：穩定幣總市值、DeFi TVL + 7D）

---

## 資料來源（目前整合）

### 1) 市場總覽（不含幣價）

- CoinGecko global（全市場總市值/成交量/市值變化/dominance）
	- `https://api.coingecko.com/api/v3/global`
- Alternative.me Fear & Greed
	- `https://api.alternative.me/fng/`

### 2) 政策 / 監管（官方 RSS）

收集並標註 impact/短線偏向（僅作資訊整理，非投資建議）：

- White House
- U.S. Treasury
- Federal Reserve
- SEC
- CFTC

（來源 URL 以 `src/collectors/policyCollector.js` 內設定為準）

### 3) 利率 / 殖利率（FRED CSV）

- 10Y：`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10`
- 2Y：`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2`
- 3M：`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO`

### 4) 流動性（DeFiLlama）

- 穩定幣總市值（含歷史序列）：`https://stablecoins.llama.fi/stablecoincharts/all`
- DeFi TVL（總量歷史序列，用於計算 7D）：`https://api.llama.fi/charts`

---

## 前端頁面順序（已固定）

首頁區塊順序：

1. 市場趨勢總覽
2. 交易員重點摘要
3. 短/中/長線總趨勢（交易員判斷）

---

## 部署（推到指定 GitHub Pages Repo）

網站實際對外發布的 repo：

- `https://github.com/Felicia980317/CryptoPulse-site.git`

此工作區中，`.deploy-site/` 是站點 repo 的獨立 git working copy（用來承載 GitHub Pages 站點檔案）。

（目前只保留一個 deploy 位置在根目錄；V2 的來源頁面在 `v2/`。）

部署流程（手動、可重複）：

1. 確認 `docs/` 已是最新（`index.html` / `app.js` / `styles.css` / `.nojekyll`）
2. 將 `v1/docs/` 內容同步覆蓋到 `.deploy-site/`（對應網站根目錄檔案）
3. 將 `v2/index.html` 同步覆蓋到 `.deploy-site/v2/index.html`
4. 在 `.deploy-site/` 內 `git add -A; git commit -m "Update site"; git push`

注意：本 repo 的 `.gitignore` 會忽略 `.deploy-site/`，避免把公開站 repo 的 git 內容混進來。

---

## 常見檢查點（非常重要）

- 若看到任何「幣價」欄位/卡片/抓取端點，代表違反約束，必須移除。
- 趨勢/理由必須在每次執行 `scripts/update-data.mjs` 時自動重算並寫回。
- 7D 變化若抓不到，前端不應顯示該行（避免 “未提供/—” 造成誤判）。
