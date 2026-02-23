# Crypto Macro Schedule Dashboard

這個專案會部署到 GitHub Pages，顯示：
- 最近與未來的美國 / 日本重要專業數據與政策日程
- 近期可能影響虛擬幣交易的事件訊息
- 交易員手動撰寫的短/中/長線趨勢與理由（會寫回 Upstash）

## 架構

- 前端頁面：`docs/index.html`
- 資料更新腳本：`scripts/update-data.mjs`
- 定時更新：`.github/workflows/update-data.yml`（每 6 小時）
- 儲存：Upstash Redis（不再依賴本地 JSON）

## 1) 本機初始化

```bash
npm install
```

## 2) 設定環境變數

複製 `.env.example` 為 `.env`，填入：

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN_READ`（用於讀取既有資料、保留交易員結論）
- `UPSTASH_REDIS_REST_TOKEN_WRITE`

> 本專案目前已停用 OpenAI 自動評估；趨勢與理由以交易員手動回寫為主。

> 你提供的 Upstash 連線資訊請放在 GitHub Secrets，不要直接寫進程式碼。

## 3) 手動更新資料

```bash
npm run update:data
```

## 3-1) 交易員手動回寫趨勢（短/中/長線）

用 `npm run update:trader` 將短/中/長線趨勢與理由寫入 Upstash，且會標記為 `manual_trader`，後續自動更新不會覆蓋。

必要環境變數：

- `TRADER_SHORT_TREND` / `TRADER_MID_TREND` / `TRADER_LONG_TREND`（只接受：`偏漲`/`偏跌`/`震盪`）
- `TRADER_SHORT_REASON` / `TRADER_MID_REASON` / `TRADER_LONG_REASON`

理由必須使用固定模板（每行一段）：

```
主因：...
傳導：...
風險情境：...
觀察指標：...
失效條件：...
```

（可選）若偏漲/偏多「附帶條件」，請用下列任一方式提供，網站會自動標示「（有條件）」：

- `TRADER_LONG_CONDITION`（或 `TRADER_SHORT_CONDITION` / `TRADER_MID_CONDITION`）
- 或在 `TRADER_*_REASON` 中加入一行：`附帶條件：...`（腳本會抽出並存到 condition 欄位）

範例：

```bash
npm run update:trader
```

完成後會更新：
- Upstash key: `crypto_dashboard:latest`
- Upstash key: `crypto_dashboard:last_updated`

## 3-1) 如何每 6 小時自動更新

已內建在 GitHub Actions：

```yaml
cron: "0 */6 * * *"
```

若你要立刻更新一次：
1. 到 GitHub Repo → `Actions`
2. 點 `Update Crypto Macro Data`
3. 點 `Run workflow`

## 4) GitHub Secrets 設定

到 GitHub Repo → `Settings` → `Secrets and variables` → `Actions`，新增：

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN_WRITE`
- `UPSTASH_REDIS_REST_TOKEN_READ`（建議加上，用於保留交易員結論）

## 5) 啟用 GitHub Pages

1. Repo → `Settings` → `Pages`
2. Source 選 `Deploy from a branch`
3. Branch 選 `main`，Folder 選 `/docs`

之後網址會是：
`https://<你的帳號>.github.io/<repo-name>/`

## 資料來源（目前）

- 美國：BLS CPI / NFP / PPI 發布排程、FOMC 會議日程
- 日本：BOJ Monetary Policy Meetings 日程
- 幣圈：CoinDesk RSS、Cointelegraph RSS

## 備註

- 已停用 OpenAI 自動評估；趨勢與理由以交易員手動回寫為主。
- 建議把 Upstash token 視為敏感資訊管理；若已外流請立刻 Rotate。
- 重大事件（如川普關稅、FOMC 路徑、戰爭/制裁）會自動提高權重並優先排序在前。
