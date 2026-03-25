# database-side

這裡是新的 **資料庫端**，完全獨立於 `v1/`、`v2/`。

目前只做一件事：

- 定時把 Coinglass 的結構化資料遞增同步到 Upstash

## 程式

- `sync_coinglass_to_upstash.py`

## 會上傳的資料

- Aggregated Open Interest（BTC / ETH，4h）
- Aggregated Stablecoin Margin Open Interest（BTC / ETH，4h）
- Aggregated Coin Margin Open Interest（BTC / ETH，4h）
- Aggregated Liquidation（BTC / ETH，4h）
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

## 規則

- 純 Python 標準函式庫，不依賴 GitHub Actions
- 遞增式同步：以 `stream + series + timestamp` 去重
- 已存在的資料不重複寫入
- ETF 類端點即使全量抓回，也只在本地去重後再寫入
- 不保存 `price_usd`
- 清算資料明確排除 OKX / OKC
- Hyperliquid 巨鯨資料屬即時快照型端點，保存最新同步快照，不強制做長歷史累加

## 環境變數

可複製 `.env.example` 為：

- repo root 的 `.env`
- 或 `database-side/.env`

必要變數：

- `COINGLASS_API_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN_WRITE`

建議同時設定：

- `UPSTASH_REDIS_REST_TOKEN_READ`

## 執行

單次 dry run：

```bash
python database-side/sync_coinglass_to_upstash.py --dry-run
```

單次正式上傳：

```bash
python database-side/sync_coinglass_to_upstash.py
```

常駐每 30 分鐘跑一次：

```bash
python database-side/sync_coinglass_to_upstash.py --loop --every-minutes 30
```

## Upstash key

預設會寫到：

- `cryptopulse:database:coinglass:derivatives`
- `cryptopulse:database:coinglass:last_updated`

如果要改 key，可用：

- `DATABASE_SIDE_UPSTASH_KEY`
- `DATABASE_SIDE_UPSTASH_LAST_UPDATED_KEY`

## 建議排程方式

你既然不要 GitHub Actions，建議直接用：

- Windows 工作排程器（Task Scheduler）
- PM2 / NSSM / 常駐 terminal
- Linux cron / systemd timer

這個 repo 內的程式本身只負責：

- 抓資料
- 去重
- 寫 Upstash
- 輸出同步摘要
