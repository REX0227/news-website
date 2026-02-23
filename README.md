# CryptoPulse Repo

此 repo 已把目前可運行的版本整理為 **V1**，全部程式與流程都在：

- `v1/`

V2 目前先放一個空白背景頁（施工中）：

- `v2/`

V1 的完整說明（資料源、Upstash、手動交易員回寫、部署到 CryptoPulse-site）請看：

- `v1/README.md`

後續 V2 會另開資料夾（例如 `v2/`），避免跟 V1 混在一起。

## V2（資訊整合中心：來源清單 + 可用性測試）

V2 目前的重點是把「資訊來源」整理到單一真實來源（SSOT），並提供可用性測試腳本；**尚未加入 AI 判斷/資料庫**。

### 重要檔案

- 來源清單（SSOT）：`v2/data/sources.json`
- 社群監控名單（初稿）：`v2/data/kol.json`
- 清單頁 UI：`v2/index.html` + `v2/app.js`
- 來源測試腳本：`v2/scripts/test-sources.mjs`（Node 18+）

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
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN_READ`

> 注意：本專案有硬性規則：**不得抓取/顯示任何幣價**（例如 CoinGecko `simple/price`）。
