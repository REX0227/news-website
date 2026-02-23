# Copilot Instructions (CryptoPulse)

## 溝通語言
- 助理回覆一律使用中文（繁體，zh-Hant）。

## 文件同步（必做）
- 只要我們在開發/溝通中新增或變更了規則、約束、流程、或重要決策，且該內容會影響後續開發與使用，就必須即時同步更新文件。
- 文件更新的優先順序：
  - 協作規則/專案約束/工作流程 → 更新本檔案（`/.github/copilot-instructions.md`）。
  - 使用方式、安裝、執行命令、部署步驟、對外說明 → 更新 `README.md`。
  - V2 架構、資料模型、資訊架構、演進路線圖（願景/設計）→ 更新 `v2/DESIGN-VISION.md`。
- 避免「只在聊天紀錄存在」：能寫進 repo 的規則就寫進去，確保未來回頭看得懂、跑得起來。
- 硬性規則：只要涉及 **push/部署策略** 的任何變更（例如「主 repo 暫時不推」、「只推 `.deploy-site/`」），必須在同一回合把決策寫進本檔案，並在主 repo 立刻 commit（依當前決策可不 push）。

## Repo layout (V1 is canonical)
- V1 app (source of truth): `v1/`
  - Frontend static site: `v1/docs/` (`index.html`, `app.js`, `styles.css`)
  - Data pipeline (Node ESM): `v1/scripts/` + `v1/src/collectors/` + `v1/src/lib/`
- V2 (currently placeholder UI): `v2/index.html`
  - V2 will have its **own** data pipeline later; keep all V2 pipeline code under `v2/` (do not mix into `v1/`).
- Deployment working copy (separate git repo for GitHub Pages): `.deploy-site/`
  - Website root files live here (`index.html`, `app.js`, `styles.css`, `.nojekyll`)
  - V2 is deployed at `.deploy-site/v2/index.html`

## Big picture data flow
- `v1/scripts/update-data.mjs` collects from multiple sources → builds payload → writes Upstash keys:
  - `crypto_dashboard:latest` (JSON payload)
  - `crypto_dashboard:last_updated`
- Frontend (`v1/docs/app.js` and deployed `.deploy-site/app.js`) reads Upstash and renders sections.

## Non-negotiable product constraints (do not break)
- No price scraping/display anywhere (no CoinGecko `simple/price`, no BTC/ETH price cards).
- V1 **絕對不使用** 任何外部 LLM API (如 OpenAI API)，也 **絕對不使用** Rule-based 寫死邏輯。
- V1 的「專業交易員評估」由 **Copilot (你)** 親自完成。
- 當使用者要求「更新 V1 數據」時，請執行以下標準流程：
  1. 執行 `node v1/scripts/update-data.mjs`。腳本會抓取最新數據並輸出到 `v1/tmp/raw-data-for-copilot.json`，然後報錯暫停（提示缺少評估檔）。
  2. 你 (Copilot) 讀取 `v1/tmp/raw-data-for-copilot.json` 的內容。
  3. 你 (Copilot) 作為專業虛擬貨幣交易員，根據這些最新數據，思考並撰寫整體的市場評估（包含短中長線趨勢、理由、重點摘要等）。
  4. 將你的評估結果寫入 `v1/data/copilot-evaluation.json`。
  5. 再次執行 `node v1/scripts/update-data.mjs`，腳本會讀取你的評估並與數據結合，推送到 Upstash。
  6. 刪除 `v1/data/copilot-evaluation.json` 以確保下次更新必須重新評估。
  7. 提交並推送 `.deploy-site/`。
- Any “7D change” line must be backed by a real number; if missing, hide the line (don’t show “—/未提供”).

## UX rules we agreed on (V1)
- Overview cards must NOT show meaningless counts like “有幾則/共幾則”.
- Important numeric deltas should be color-coded (use existing `.bias-*` classes; do not invent new colors).
- “下一個高影響事件” must include “當前預期判定” (偏漲/偏跌/震盪) with a short basis note.
- Liquidation is a risk metric: do not show it as green/“bullish”; small liquidation should be neutral/muted.
- Policy/Regulatory section should display Traditional Chinese where possible（來源/標題翻譯採規則式）。

## Critical workflows (how we actually run things)
- Install deps (V1 only): run in `v1/` → `npm install`
- Update data to Upstash: `npm run update:data` (from `v1/`) or `node v1/scripts/update-data.mjs` (from repo root)
- Inspect current Upstash payload: `node v1/scripts/inspect-upstash.mjs`

## Deployment workflow (single deploy location)
- Sync V1 site assets:
  - `v1/docs/*` → `.deploy-site/*`
- Sync V2 placeholder:
  - `v2/index.html` → `.deploy-site/v2/index.html`
- Publish: commit/push inside `.deploy-site/` (this pushes to `Felicia980317/CryptoPulse-site`).
- Current decision: do NOT push the main repo for now; only push `.deploy-site/` to update the public GitHub Pages site.
- `.deploy-site/` is the ONLY allowed deploy working copy (do not create `v1/.deploy-site` or other deploy dirs).
- Never treat `.deploy-site/` as part of this repo’s history; it’s a separate working copy.

## Repo hygiene
- Temporary artifacts belong in `tmp/` (do not scatter `tmp_*` or `.tmp_*` files in the repo root).

## Conventions/patterns to follow
- Node is ESM (`"type": "module"`). Prefer `import ... from` and avoid CommonJS.
- Collectors return structured sections added into the Upstash payload (e.g., `ratesIntel`, `liquidityIntel`).
  - Example: `v1/src/collectors/liquidityCollector.js` uses DeFiLlama `https://api.llama.fi/charts` for TVL 7D.
- `cryptoSignals` must be category-isolated.
  - `v1/src/collectors/cryptoImpactCollector.js` keeps per-category quotas (flow/regulation/risk/macro/market) so categories don’t crowd each other out; quotas can be tuned via `QUOTA_*` env vars.
  - 截斷/排序以「時間優先」為主（避免分數排序造成缺東缺西）。
  - Overview 的 7D `ETF/清算` 估算使用 `cryptoSignalMetrics7d`（由完整去重訊號計算，不受 signals 截斷影響；並避免把價格如 $65K 誤判為清算規模）。
- V2 pipeline should follow the same ESM/collector pattern as V1, but MUST remain isolated under `v2/`.
- Local-friendly navigation must be explicit:
  - V1 → V2 link should target `./v2/index.html`
  - V2 → V1 link should target `../index.html`

## When changing UI
- Homepage section order is fixed in `v1/docs/index.html` (and mirrored in `.deploy-site/index.html`).
- Keep all user-facing text in Traditional Chinese (`zh-Hant`).
