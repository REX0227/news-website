# CryptoPulse Repo

此 repo 已把目前可運行的版本整理為 **V1**，全部程式與流程都在：

- `v1/`

V2 目前先放一個空白背景頁（施工中）：

- `v2/`

另外，現在也新增了一個 **V3 視覺化頁面**：

- `v3/`

另外，現在新增了一個**完全獨立**的新目錄作為資料庫端：

- `database-side/`

V1 的完整說明（資料源、Upstash、手動交易員回寫、部署到 CryptoPulse-site）請看：

- `v1/README.md`

後續 V2 會另開資料夾（例如 `v2/`），避免跟 V1 混在一起。

## 新資料庫端（獨立，不混入 V1 / V2）

目前新的資料庫端獨立放在：

- `database-side/`

用途很單純：

- 用 **純 Python 程式** 定時抓 Coinglass
- 做遞增式去重
- 上傳到 Upstash

目前主程式：

- `database-side/sync_coinglass_to_upstash.py`

相關說明：

- `database-side/README.md`
- `database-side/.env.example`

這一套**不使用 GitHub Actions**，也**不放進 `v1/` 或 `v2/`**。

### 資料內容

- Aggregated Open Interest（BTC / ETH，4h）
- Aggregated Stablecoin Margin Open Interest（BTC / ETH，4h）
- Aggregated Coin Margin Open Interest（BTC / ETH，4h）
- Aggregated Liquidation（BTC / ETH，4h；排除 OKX / OKC）
- Funding Rate（Binance BTCUSDT / ETHUSDT，8h）
- Top Long/Short Account Ratio（Binance BTCUSDT / ETHUSDT，4h）
- Top Long/Short Position Ratio（Binance BTCUSDT / ETHUSDT，4h）
- Global Long/Short Account Ratio（Binance BTCUSDT / ETHUSDT，4h）
- Aggregated Taker Buy/Sell Volume（BTC / ETH，4h）
- Aggregated CVD（BTC / ETH，4h）
- Futures Basis（Binance BTCUSDT / ETHUSDT，4h）
- Bitcoin / Ethereum ETF Flow History（日線）
- Bitcoin ETF Net Assets History（日線）
- Hyperliquid Whale Alert（即時大戶開倉 / 平倉警報）
- Hyperliquid Whale Position（即時大戶持倉 / PnL / 槓桿）
- Hyperliquid Wallet Position Distribution（倉位層級分布 / 多空偏向 / 盈虧分布）

### 執行方式

Dry run：

```bash
python database-side/sync_coinglass_to_upstash.py --dry-run
```

正式上傳：

```bash
python database-side/sync_coinglass_to_upstash.py
```

常駐定時執行：

```bash
python database-side/sync_coinglass_to_upstash.py --loop --every-minutes 30
```

### Upstash key

預設使用：

- `cryptopulse:database:coinglass:derivatives`
- `cryptopulse:database:coinglass:last_updated`

## V3（database-side 結構資料儀表板）

V3 是新的 **資料庫端視覺化頁面**，專門把 `database-side/` 剛寫進 Upstash 的資料整理成可閱讀的儀表板。

目前位置：

- `v3/index.html`
- `v3/app.js`
- `v3/styles.css`

V3 目前直接讀取：

- `cryptopulse:database:coinglass:derivatives`

畫面重點：

- BTC / ETH 衍生品結構總覽
- OI、清算、Funding、Basis、多空比、Taker Volume、CVD
- Hyperliquid 巨鯨流向 / 大戶監控
- Bitcoin / Ethereum ETF Flow 與 Bitcoin ETF Net Assets
- stream catalog，方便確認資料庫裡實際有哪些欄位正在被追蹤

用途定位：

- V1：對外主站 / 宏觀 + 訊號整合
- V2：來源清單 / 可用性測試
- V3：資料庫端結構資料展示

## V2（資訊整合中心：來源清單 + 可用性測試）

V2 目前的重點是把「資訊來源」整理到單一真實來源（SSOT），並提供可用性測試腳本；**尚未加入 AI 判斷/資料庫**。

V2 的當前設計與願景（活文件，後續變更必須同步更新）：

- `v2/DESIGN-VISION.md`

### 重要檔案

- 來源清單（SSOT）：`v2/data/sources.json`
- 社群監控名單（初稿）：`v2/data/kol.json`
- 清單頁 UI：`v2/index.html` + `v2/app.js`
- 來源測試腳本：`v2/scripts/test-sources.mjs`（Node 18+）
- 設計與願景（活文件）：`v2/DESIGN-VISION.md`

另外，V2 也會同步鏡像到：

- `v1/docs/v2/`（V1 docs 下的 v2 靜態頁）
- `.deploy-site/v2/`（GitHub Pages 部署工作目錄）

### 執行測試

在 repo 根目錄執行：

```bash
node v2/scripts/test-sources.mjs
```

測試輸出會以 `PASS / SKIP / FAIL` 顯示。

若要把「最近一次測試結果」顯示在 V2 網頁上（表格會多一欄狀態），可產生報告檔：

```bash
node v2/scripts/test-sources.mjs --report v2/data/fetch-report.json
```

接著把 `v2/data/fetch-report.json` 同步到 `v1/docs/v2/data/` 與 `.deploy-site/v2/data/`，V2 網頁就會自動讀取並顯示。

### requiresApi 規則（重要）

- `sources.json` 內標記 `requiresApi: true` 的來源，代表需要 API key / token / 授權。
- 目前策略是：**若缺少對應環境變數，測試腳本會直接 `SKIP`**（避免「尚未開通 API」造成大量噪音）。

常見的環境變數（有需要再設定）：

- `X_BEARER_TOKEN`
- `COINGLASS_API_KEY`
- `WHALEALERT_API_KEY`
- `ESTAT_APP_ID`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN_READ`

> 注意：本專案有硬性規則：**不得抓取/顯示任何幣價**（例如 CoinGecko `simple/price`）。
