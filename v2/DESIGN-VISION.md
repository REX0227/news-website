# CryptoPulse V2：當前設計與願景（Living Document）

> 本文件用來描述 V2 的**設計目標、架構、資料治理、運維流程、與長期願景**。
> 
> 重要：本文件是「活文件」。只要 V2 的資料規格、部署策略、或核心工作流程有變更，就必須同步更新本文件，避免只存在聊天紀錄。

## 1. 產品定位與邊界

### 1.1 產品定位
CryptoPulse V2 的定位是「資訊整合中心（Intelligence Hub）」，以**可追溯、可測試、可治理**的方式把各類訊號來源（政策、宏觀、交易所公告、安全事件、地緣、社群等）整理成統一結構，供後續的資料管線、摘要、告警與決策工具使用。

### 1.2 目前階段（Phase 0）
目前 V2 僅做：
- 來源清單（SSOT）與分類治理
- 可用性測試與狀態報告輸出（PASS/SKIP/FAIL）
- 靜態頁面展示（GitHub Pages）

目前刻意**不做**：
- AI 自動判讀/自動評估
- 資料庫/長期儲存/查詢 API
- 複雜爬蟲（HTML 大規模抓取與解析）

### 1.3 非談判限制（必須遵守）
- **不得抓取/顯示任何幣價**（例如 CoinGecko `simple/price`、任何現貨價格卡片）。
- 社群平台（例如 X/Twitter）與付費/授權 API：**未取得授權前不抓取**；可先列入清單並標記 `requiresApi: true`。
- 對 HTML 類來源：需尊重 ToS/robots/合法性；現階段僅列入清單與基本可用性檢查，不承諾可長期抓取。

## 2. Repo 結構與部署模型

### 2.1 單一真實來源（SSOT）與鏡像
- SSOT：
  - `v2/data/sources.json`
  - `v2/data/kol.json`
- 鏡像（對外展示/部署用）：
  - `v1/docs/v2/`：V1 docs 下的 V2 靜態頁
  - `.deploy-site/v2/`：GitHub Pages 部署工作目錄（獨立 git repo）

**原則**：長 JSON 不做局部 patch 同步，採「整檔覆蓋」同步，避免混雜/截斷。

### 2.2 部署策略（GitHub Pages）
- `.deploy-site/` 是 GitHub Pages 的唯一部署工作目錄（獨立 git repo）。
- 目前決策：**主 repo 暫時不 push**；公開頁面只透過 `.deploy-site/` commit/push 更新。

## 3. 資料模型（Sources Schema v2）

### 3.1 `sources.json` 頂層
- `schemaVersion`: 目前為 `2`
- `categoryDefinitions`: 分類定義（ID、顯示 label、描述）
- `sources`: 來源陣列

### 3.2 `categoryDefinitions`
分類是「資訊架構」的核心：
- UI 用來分組與排序
- 測試/報告用來彙總
- 後續 collectors 可以用分類決定抓取頻率與解析策略

### 3.3 `sources[]` 欄位（治理欄位優先）
每個來源至少建議具備：
- `id`: 唯一識別（穩定、不可隨意更名）
- `category`: 必須對應到 `categoryDefinitions[].id`
- `name`: 人類可讀名稱
- `url` 或 `urlTemplate`: 來源 URL（可包含 `${ENV}` 佔位）
- `format`: `json | csv | rss | xml | html | ics | xlsx`
- `required`: 是否為「必須來源」
- `region`: `US | JP | GLOBAL | ...`
- `access`: `public | official_api | third_party_api | html_scrape`
- `requiresApi`: 是否需要 API key/token/授權
- `stability`: `high | medium | low`（穩定性預估）
- `tags`: 標籤（用於後續檢索/篩選/彙總）
- `termsNote`: ToS/授權/合規備註（重要）
- `expect`: 基本驗證（例如 jsonPaths/textIncludes）

### 3.4 `kol.json`
`kol.json` 是「社群監控名單」資料，不等於「可合法抓取」。
- 用於列出監控對象
- 是否可抓取與展示，需視 API/授權與 ToS

## 4. 可用性測試與狀態報告

### 4.1 測試腳本
- `v2/scripts/test-sources.mjs`（Node 18+）
- 輸出：逐項 `PASS / SKIP / FAIL` + summary

### 4.2 requiresApi 的策略（降低噪音）
- 若 `requiresApi: true` 且缺少必要 token/設定：測試直接 `SKIP`
- optional 來源（`required: false`）即使抓取/解析失敗：也會被視為 `SKIP`（避免 HTML 403/404/限流造成噪音）
- 只有 `required: true` 的來源 FAIL 才會導致 exit code=1

### 4.3 報告檔（供網頁顯示）
- 指令：`node v2/scripts/test-sources.mjs --report v2/data/fetch-report.json`
- 網頁會讀取 `./data/fetch-report.json`，在表格顯示「最近測試」狀態欄

## 5. 前端展示（靜態頁）

### 5.1 頁面目標
- 讓團隊與使用者能「快速掃描來源矩陣」：分類、地區、取得方式、是否需要 API、穩定性、標籤
- 顯示最近測試結果，快速知道哪些端點開始 403/404/限流

### 5.2 安全與展示規則
- `urlTemplate` 含 `${ENV}` 佔位時，UI 不產生可點連結（避免暴露內部 API 形狀或誤點）

## 6. 目前來源覆蓋盤點（截至本文件撰寫）

以下為目前 `sources.json` 的概況（用腳本統計）：
- 總來源數：65
- 必須來源：30
- 需要 API：5
- 地區分佈：US 28、GLOBAL 27、JP 10

分類分佈（節錄）：
- `macro_data_us`: 9
- `policy_us`: 7
- `rates_yields_us`: 5
- `news_crypto`: 5
- `exchanges_announcements`: 3

目前狀態與剩餘缺口：
- 已補齊所有分類（`emptyCategories: []`），不再有「分類定義存在但完全沒有來源」的洞。
- 日本（JP）來源已從 3 提升到 8，但與 US/GLOBAL 相比仍偏少；且 `macro_calendar_jp`、`policy_jp` 的來源深度仍需加強。
- 部分官方/大型站點對非瀏覽器環境可能回 403/503（目前以 optional + SKIP 控噪）；若要做正式抓取需設計授權/節流/可用性策略。

## 7. 補強優先順序（建議）

### P0（加深 JP 與官方來源深度）
- `macro_calendar_jp`：補 BOJ/政府部門的行事曆/發布日程（優先找 ICS/RSS；沒有再用 HTML）。
- `policy_jp`：把 MOF/FSA 由「入口頁」逐步替換/補上更可機器讀取的公告頁、RSS、或官方資料下載。
- `macro_data_jp`：在已納入 e-Stat/統計局/BOJ 統計入口的基礎上，補一批「可直接下載的時間序列」或可定位的統計表 ID（仍允許 requiresApi 占位）。

### P1（提高國際監管來源可靠性）
- `policy_global`：對 403/易變動來源，優先找同機構的 RSS/文件清單頁/鏡像頁，或補同等級替代（例如 IOSCO 等）。

### P2（把易壞的 HTML 來源換成較穩的 feed）
- 交易所公告：優先找官方 RSS/JSON；HTML 若常 403/404，降低期望或改成 optional

### P2（提升市場結構與風險代理的可讀性）
- TradFi risk proxies：補更多 FRED 指標（信用利差、收益率曲線利差、波動率代理等）
- Liquidity flows：ETF flows、stablecoin 指標更多切片（若需要 API 可先佔位）

## 8. 長期願景（Roadmap）

### Phase 1：Collector 化與增量更新
- 依 category 設定不同抓取頻率、timeout、重試策略
- 把測試腳本擴展為「抓取 + 正規化輸出」的 collectors（仍維持 v2 隔離）

### Phase 2：結構化事件與風險訊號
- 針對政策/地緣事件建立「事件表」：時間、來源、影響標籤、關聯資產類別（仍不含幣價）

### Phase 3：告警與摘要（可選）
- 只在有明確授權/合規前提下，做通知與摘要
- AI 若導入：必須可關閉、可回溯、且不覆寫人工輸出（延續 V1 的原則）

## 9. 維護規範（必做）
- 若新增/調整分類：同步更新 `categoryDefinitions` 與本文件的資訊架構章節
- 若改動部署策略：同步更新本文件 + `.github/copilot-instructions.md`
- 若新增 requiresApi 來源：必須寫清楚 `termsNote`（授權/費用/ToS）

---

（最後更新：2026-02-24）
