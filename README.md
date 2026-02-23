# Crypto Macro Schedule Dashboard

這個專案會部署到 GitHub Pages，顯示：
- 最近與未來的美國 / 日本重要專業數據與政策日程
- 近期可能影響虛擬幣交易的事件訊息
- AI 整理出的關鍵交易節點摘要

## 架構

- 前端頁面：`docs/index.html`
- 資料更新腳本：`scripts/update-data.mjs`
- 定時更新：`.github/workflows/update-data.yml`（每 30 分鐘）
- 儲存：Upstash Redis（同時回寫 `docs/data/latest.json`）

## 1) 本機初始化

```bash
npm install
```

## 2) 設定環境變數

複製 `.env.example` 為 `.env`，填入：

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN_WRITE`
- （可選）`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`

> 你提供的 Upstash 連線資訊請放在 GitHub Secrets，不要直接寫進程式碼。

## 3) 手動更新資料

```bash
npm run update:data
```

完成後會更新：
- Upstash key: `crypto_dashboard:latest`
- Upstash key: `crypto_dashboard:last_updated`
- 本地檔案：`docs/data/latest.json`

## 4) GitHub Secrets 設定

到 GitHub Repo → `Settings` → `Secrets and variables` → `Actions`，新增：

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN_WRITE`
- `OPENAI_API_KEY`（可選）
- `OPENAI_BASE_URL`（可選，不填則預設 OpenAI）
- `OPENAI_MODEL`（可選）

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

- 若 `OPENAI_API_KEY` 未設定，系統會使用內建規則產生摘要（仍可運作）。
- 建議把 Upstash token 視為敏感資訊管理；若已外流請立刻 Rotate。
