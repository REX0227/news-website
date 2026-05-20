/**
 * openapi.js — GET /api/openapi.json
 *
 * 自動從此檔案維護，作為 single source of truth。
 * 每次部署前 contract test 應拉此 spec 驗證所有 endpoint。
 */

import { Router } from "express";

const router = Router();

const SPEC = {
  openapi: "3.0.3",
  info: {
    title: "CryptoPulse API",
    version: "2.5.0",
    description: `CryptoPulse 跨市場交易消息面與量化因子資料平台。

## Quick Start（5 分鐘上手）

\`\`\`bash
# 1. 當前 Crypto 市場 Regime + 降息概率
curl http://34.29.130.233/api/comment/crypto | jq '.regime,.news_sentiment'

# 2. Fed 路徑（EFFR + rate_cut_prob_3m）
curl http://34.29.130.233/api/comment | jq '.macro_drivers.fed_path'

# 3. 最新新聞（分類 + 方向已標注）
curl http://34.29.130.233/api/news?limit=5

# 4. 量化 Factor Vector（73 factors）
curl http://34.29.130.233/api/v2/factors
\`\`\`

四個 request 就能看到整個平台在做什麼。

## 三層資料架構

| 層次 | 端點 | 說明 |
|------|------|------|
| **事實層** | \`/api/news\` | 原始新聞（Jin10）；方向/類別/事件類型由分類器即時計算 |
| **詮釋層** | \`/api/comment\` | 宏觀 regime 評估（rule-based），每 5 分鐘更新 |
| **機器層** | \`/api/v2/factors\` | 量化 factor vector，供程式交易直接消費 |

## 時間戳語義

- \`published_at\`：上游發布時間（UTC）
- \`available_at\`：本系統收到並入庫時間（UTC）
- \`ingest_lag_seconds\`：\`available_at - published_at\`；反映即時性
- \`computed_at\`：factor / comment 計算時間，非新聞發布時間

## 清算資料架構

清算資料覆蓋 Binance + Bybit + OKX + Gate，歷史最長 ~500 天（1d 精度），近期支援 15m 精度。`,
    contact: { url: "http://34.29.130.233/api_docs.html" }
  },
  servers: [{ url: "/api", description: "本機 / GCP VM" }],

  tags: [
    { name: "news",         description: "新聞事實層 — 發生了什麼？" },
    { name: "comment",      description: "詮釋層 — 現在是什麼狀態？（/api/comment）" },
    { name: "factors",      description: "Factor vector — 量化指標" },
    { name: "liquidations",   description: "清算數據 — 即時快照 + 歷史時序（Binance / Bybit / OKX 自建聚合）" },
    { name: "funding_rates",  description: "資金費率 — 多交易所歷史時序 + z-score（Binance/Bybit/OKX/Gate/Hyperliquid）" },
    { name: "gates",        description: "Gate conditions — 交易條件開關" },
    { name: "macro",        description: "宏觀事件行事曆" },
    { name: "validation",   description: "自驗證系統 — 量化「訊號到底準不準」（Spearman ρ / hit rate）" },
    { name: "system",       description: "健康 / 維運 / SLA" },
    { name: "sse",          description: "Server-Sent Events 即時推播（消滅 polling 延遲）" },
    { name: "memory",       description: "§6 Memory System — 市場記憶（Episode / Pattern / Regime Transition）" },
    { name: "kg",           description: "§6 Knowledge Graph — 實體關係圖譜與影響鏈推理" },
  ],

  "x-tagGroups": [
    { name: "核心",     tags: ["news", "comment", "factors"] },
    { name: "清算",     tags: ["liquidations", "funding_rates"] },
    { name: "交易條件", tags: ["gates", "macro"] },
    { name: "即時推播", tags: ["sse"] },
    { name: "市場記憶", tags: ["memory", "kg"] },
    { name: "驗證",     tags: ["validation"] },
    { name: "系統",     tags: ["system"] }
  ],

  paths: {

    // ── /api/news ────────────────────────────────────────────────
    "/news": {
      get: {
        tags: ["news"],
        summary: "最新新聞（分類、方向已標注）",
        description: "Source-agnostic news 端點，回傳已分類的最新新聞。\n\n⚠️ **direction_en 語義說明**：`direction_en` 分類的是新聞本身的看多/看空**語氣**，不代表標的價格會朝同方向移動。新聞情緒與價格方向的相關性可能為正、為負、或無相關（contrarian effect）。如何使用 direction_en 做交易決策是 client 的責任。",
        parameters: [
          { name: "limit",               in: "query", schema: { type: "integer", default: 50, maximum: 200 }, description: "最多返回筆數（最大 200）" },
          { name: "offset",              in: "query", schema: { type: "integer", default: 0 }, description: "分頁偏移" },
          { name: "source",              in: "query", schema: { type: "string", example: "jin10" }, description: "來源篩選（目前僅 jin10）" },
          { name: "category",            in: "query", schema: { type: "string", enum: ["crypto","macro","regulatory","geopolitical","commodity","general"] }, description: "新聞大類篩選" },
          { name: "event_type",          in: "query", schema: { type: "string", enum: ["fed_speech","data_release","etf_flow","liquidation_event","regulation","geopolitical_shock","trade_policy","central_bank","general"] }, description: "事件類型篩選（由 rule-based 分類器即時計算）" },
          { name: "direction",           in: "query", schema: { type: "string", enum: ["bullish","bearish","neutral","ambiguous"] }, description: "情緒方向篩選。⚠️ 這是新聞語氣分類，不是價格方向預測" },
          { name: "relevance_min",       in: "query", schema: { type: "number", minimum: 0, maximum: 1, default: 0.3 }, description: "最低加密相關分數（0–1）。建議預設 0.3 過濾無關新聞" },
          { name: "min_confidence",      in: "query", schema: { type: "integer", minimum: 1, maximum: 5 }, description: "最低置信度（1–5，5 最高）" },
          { name: "include_low_relevance", in: "query", schema: { type: "boolean", default: false }, description: "是否包含 relevance < 0.3 的低相關新聞（預設不包含）" }
        ],
        responses: {
          "200": {
            description: "新聞列表",
            headers: {
              "X-API-Version":        { schema: { type: "string" } },
              "X-Classifier-Version": { schema: { type: "string" } }
            },
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                ok:      { type: "boolean" },
                count:   { type: "integer", description: "本頁實際返回筆數" },
                total_matched: { type: "integer", description: "符合篩選條件的總筆數。純時間篩選（from/to/since）時為完整 COUNT(*) 不受 limit 影響；有 in-memory 篩選（category/direction 等）時為篩選後計數" },
                classifier_version: { type: "string" },
                sources: { type: "object" },
                items:   { type: "array", items: { "$ref": "#/components/schemas/NewsItem" } }
              }
            }}}
          }
        }
      }
    },

    "/news/history": {
      get: {
        tags: ["news"],
        summary: "新聞歷史查詢（最長保存 30 天）",
        description: "從持久化資料庫查詢歷史新聞。支援時間範圍、來源、分類、方向等多維篩選。\n\n`since` 參數適合 live polling：每次傳入上一批最新的 `available_at`，只拉取更新的資料。\n\n**`total_matched` 說明**：純時間篩選（`from`/`to`）時回傳完整 `COUNT(*)`，不受 `limit` 影響，可直接用於分頁計算。有 in-memory 篩選（`category`/`direction` 等）時回傳篩選後計數。",
        parameters: [
          { name: "limit",  in: "query", schema: { type: "integer", default: 100, maximum: 1000 }, description: "最多返回筆數（最大 1000）" },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 }, description: "分頁偏移" },
          { name: "from",   in: "query", schema: { type: "string", format: "date-time" }, description: "查詢起始時間（published_at >= from）" },
          { name: "to",     in: "query", schema: { type: "string", format: "date-time" }, description: "查詢結束時間（published_at < to）" },
          { name: "since",  in: "query", schema: { type: "string", format: "date-time" }, description: "Live polling cursor：只返回 available_at > since 的新資料" },
          { name: "source", in: "query", schema: { type: "string" }, description: "來源篩選（目前僅 jin10）" },
          { name: "category",   in: "query", schema: { type: "string" }, description: "分類篩選：crypto / macro / regulatory / geopolitical / commodity / general" },
          { name: "event_type", in: "query", schema: { type: "string" }, description: "事件類型篩選：fed_speech / data_release / etf_flow / liquidation_event / regulation / geopolitical_shock / trade_policy / central_bank / general" },
          { name: "direction",  in: "query", schema: { type: "string" }, description: "情緒方向篩選：bullish / bearish / neutral / ambiguous" },
          { name: "relevance_min", in: "query", schema: { type: "number" }, description: "最低加密相關分數（0–1，建議 0.3）" },
          { name: "min_confidence", in: "query", schema: { type: "integer" }, description: "最低置信度（1–5）" }
        ],
        responses: {
          "200": {
            description: "歷史新聞列表",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                count: { type: "integer", description: "本頁實際返回筆數" },
                total_matched: { type: "integer", description: "符合篩選條件的總筆數。純時間篩選時為完整 COUNT(*) 不受 limit 影響；有 in-memory 篩選時為篩選後計數" },
                items: { type: "array", items: { "$ref": "#/components/schemas/NewsItem" } }
              }
            }}}
          }
        }
      }
    },

    // ── /api/comment ─────────────────────────────────────────────
    "/comment": {
      get: {
        tags: ["comment"],
        summary: "Shared macro 詮釋層（全資產共用宏觀觀點）",
        description: "回傳當前宏觀 regime、全球風險評估與 narrative。每 5 分鐘更新。",
        responses: {
          "200": {
            description: "Shared macro comment",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/MacroComment" } } }
          },
          "404": { description: "尚無資料（需先執行 pipeline）" }
        }
      }
    },

    "/comment/history": {
      get: {
        tags: ["comment"],
        summary: "Macro comment 歷史快照",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 1000 }, description: "最多返回筆數（最大 1000）" },
          { name: "from",  in: "query", schema: { type: "string", format: "date-time" }, description: "查詢起始時間（computed_at >= from）" },
          { name: "to",    in: "query", schema: { type: "string", format: "date-time" }, description: "查詢結束時間（computed_at < to）" }
        ],
        responses: {
          "200": { description: "歷史 comment 列表（僅 structured 欄位，不含 narrative）" }
        }
      }
    },

    "/comment/{asset_class}": {
      get: {
        tags: ["comment"],
        summary: "Per-asset-class comment（crypto 已上線）",
        description: "加密市場完整詮釋層。回傳 regime / scores / factor_deltas / news_sentiment / regime_context 等。每 5 分鐘更新。\n\n**Regime Engine v2.4 — Validation-Driven Score Adjustment**：Regime engine 會自動從 `/v2/comment/validation/factors` 讀取 Spearman ρ 結果，對 `direction=inverse` 的 factor（即 ρ < −0.1，高分反而預測下跌）自動乘以 −1 後再納入 composite score 計算。此調整只影響 regime/scores 預測方向，factor 的原始 `normalized_score` 顯示值不變。詳見 `GET /v2/comment/validation/factors` 的 `inverse_factors` 清單。",
        parameters: [
          { name: "asset_class", in: "path", required: true,
            schema: { type: "string", enum: ["crypto","us_stock","tw_stock","fx","commodity","bond"] },
            description: "資產類別。目前 crypto 已上線；cross_asset / 其他返回 HTTP 501" }
        ],
        responses: {
          "200": {
            description: "Asset class comment（以 crypto 為例）",
            content: { "application/json": { schema: { "$ref": "#/components/schemas/CryptoComment" } } }
          },
          "501": { description: "尚未實作的 asset class" }
        }
      }
    },

    "/comment/{asset_class}/history": {
      get: {
        tags: ["comment"],
        summary: "Per-asset-class comment 歷史快照",
        parameters: [
          { name: "asset_class", in: "path", required: true,
            schema: { type: "string", enum: ["crypto"] } },
          { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 1000 } },
          { name: "from",  in: "query", schema: { type: "string", format: "date-time" } },
          { name: "to",    in: "query", schema: { type: "string", format: "date-time" } }
        ],
        responses: {
          "200": { description: "歷史 comment 列表（結構欄位，不含 narrative）" }
        }
      }
    },

    // ── /api/v2/factors ──────────────────────────────────────────
    "/v2/factors": {
      get: {
        tags: ["factors"],
        summary: "完整 factor vector（當前快照）",
        responses: {
          "200": {
            description: "Factor vector",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                computed_at: { type: "string", format: "date-time" },
                count: { type: "integer", example: 53,
                  description: "目前 53 個 factors，含 macro（含 macro.fed_funds_rate EFFR）、sentiment、liquidity、flows、derivatives（清算/資金費率/OI/L/S/CVD/P-C ratio/IV）、risk、event、crypto.derivatives.{symbol}.* per-symbol 衍生品（6 symbols × 4 factors = 24 個）" },
                factors: { type: "object", additionalProperties: { "$ref": "#/components/schemas/Factor" } }
              }
            }}}
          },
          "404": { description: "無資料" }
        }
      }
    },

    "/v2/factors/history": {
      get: {
        tags: ["factors"],
        summary: "Factor 歷史時序（支援 multi-key + resample）",
        description: "查詢一個或多個 factor 的歷史時序。支援 server 端降採樣（raw / 1h / 4h / 1d）以節省傳輸量。",
        parameters: [
          { name: "key",      in: "query", schema: { type: "string", example: "macro.yield_10y" },
            description: "單一 factor key（向下相容）。與 keys 二擇一" },
          { name: "keys",     in: "query", schema: { type: "string", example: "macro.yield_10y,macro.vix,macro.dxy" },
            description: "多個 factor key，逗號分隔，最多 10 個" },
          { name: "days",     in: "query", schema: { type: "integer", default: 30, minimum: 1, maximum: 730 }, description: "回溯天數（1–730，預設 30）" },
          { name: "resample", in: "query", schema: { type: "string", enum: ["raw","1h","4h","1d"], default: "raw" },
            description: "server 端降採樣（raw = 原始精度，約每 5 分鐘一筆）" }
        ],
        responses: {
          "200": { description: "Factor 歷史序列（依 key 分組回傳）" },
          "400": { description: "缺少 key/keys 參數，或 keys 超過 10 個" }
        }
      }
    },

    // ── /api/v2/gates ────────────────────────────────────────────
    "/v2/gates": {
      get: {
        tags: ["gates"],
        summary: "完整 gate conditions",
        responses: {
          "200": { description: "Gate conditions 完整版" },
          "404": { description: "無資料" }
        }
      }
    },

    "/v2/gates/summary": {
      get: {
        tags: ["gates"],
        summary: "Gates key-value 精簡版（程式交易直接用）",
        responses: {
          "200": {
            description: "Gate 純 key-value",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                computed_at: { type: "string", format: "date-time" },
                summary: {
                  type: "object",
                  example: {
                    "macro.favorable": true,
                    "liquidity.adequate": true,
                    "event.blackout_window": false,
                    "risk.leverage_overextended": false
                  }
                }
              }
            }}}
          }
        }
      }
    },

    // ── /api/macro-events ────────────────────────────────────────
    "/macro-events": {
      get: {
        tags: ["macro"],
        summary: "宏觀事件行事曆（CPI / NFP / FOMC / BOJ）",
        parameters: [
          { name: "country", in: "query", schema: { type: "string", enum: ["US","JP","TW","CN"] }, description: "國家篩選（US=美聯準、JP=BOJ、TW=台灣、CN=中國）；不傳回傳所有國家" },
          { name: "days",    in: "query", schema: { type: "integer", example: 7 }, description: "往後查詢天數（預設 7；查詢未來幾天的預定事件）" }
        ],
        responses: {
          "200": { description: "事件列表" }
        }
      }
    },

    // ── /api/v2/snapshots（Snapshot Lineage）────────────────────
    "/v2/snapshots": {
      get: {
        tags: ["system"],
        summary: "Pipeline run 索引（snapshot lineage）",
        description: "列出歷史 pipeline runs，每筆含 `replay_url` 指向該快照的完整 factor/gate 資料。",
        parameters: [
          { name: "limit",  in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
          { name: "before", in: "query", schema: { type: "string", format: "date-time" }, description: "分頁游標（返回此時間之前的 runs）" }
        ],
        responses: {
          "200": { description: "Pipeline run 列表，含 replay_url" }
        }
      }
    },

    "/v2/snapshot": {
      get: {
        tags: ["system"],
        summary: "單一 pipeline 快照回放（replay）",
        description: "以指定 run_id 查詢歷史 factor + gate 快照，格式與 /v2/factors 相同，附 `replay: true` 標記。",
        parameters: [
          { name: "id", in: "query", required: true,
            schema: { type: "string", example: "run_20260415_103000" },
            description: "Pipeline run_id（從 /v2/snapshots 取得）" }
        ],
        responses: {
          "200": { description: "歷史快照（factors + gates），replay: true" },
          "404": { description: "找不到指定 run_id" }
        }
      }
    },

    // ── /api/v2/pipeline/runs ────────────────────────────────────
    "/v2/pipeline/runs": {
      get: {
        tags: ["system"],
        summary: "最近 N 次 pipeline 執行記錄",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 10, maximum: 50 }, description: "返回最近 N 次執行記錄（最大 50）" }
        ],
        responses: {
          "200": { description: "Pipeline run 列表" }
        }
      }
    },

    "/update-log": {
      get: {
        tags: ["system"],
        summary: "最近 10 次更新 log",
        responses: {
          "200": { description: "Update log" }
        }
      }
    },

    "/health": {
      get: {
        tags: ["system"],
        summary: "健康狀態",
        responses: {
          "200": { description: "OK" }
        }
      }
    },

    // ── /api/stream (SSE) ────────────────────────────────────────
    "/stream/events": {
      get: {
        tags: ["sse"],
        summary: "高衝擊事件 SSE（importance=high 宏觀事件 + 非中性高相關新聞）",
        description: "text/event-stream。event types: connected | news | macro_event。每天估計 < 20 條。25 秒 keep-alive。",
        responses: {
          "200": { description: "SSE stream", content: { "text/event-stream": {} } },
          "503": { description: "連線數超過上限（MAX 200）" }
        }
      }
    },
    "/stream/news": {
      get: {
        tags: ["sse"],
        summary: "非中性新聞 SSE（可自訂方向與相關性門檻）",
        parameters: [
          { name: "direction",     in: "query", schema: { type: "string", default: "bullish,bearish" }, description: "方向篩選，逗號分隔（bullish / bearish / neutral）；預設只推播非中性新聞" },
          { name: "relevance_min", in: "query", schema: { type: "number", default: 0.5 }, description: "最低加密相關分數（0–1）；預設 0.5 過濾低相關新聞" }
        ],
        responses: { "200": { description: "SSE stream", content: { "text/event-stream": {} } } }
      }
    },
    "/stream/comment": {
      get: {
        tags: ["sse"],
        summary: "Regime 轉換 SSE（只在 regime label 改變時推播）",
        description: "每天估計 < 5 條推播。",
        parameters: [
          { name: "asset_class", in: "query", schema: { type: "string", default: "crypto", enum: ["crypto"] }, description: "目前僅支援 crypto；未來擴展至 us_stock / bond 等資產類別" }
        ],
        responses: { "200": { description: "SSE stream", content: { "text/event-stream": {} } } }
      }
    },
    "/stream/status": {
      get: {
        tags: ["sse"],
        summary: "SSE 連線狀態（監控用）",
        responses: { "200": { description: "連線數與輪詢狀態" } }
      }
    },

    // ── /api/v2/liquidations ─────────────────────────────────────
    "/v2/liquidations": {
      get: {
        tags: ["liquidations"],
        summary: "清算即時快照（多幣種 × 多時窗）",
        description: "從自建 WebSocket aggregator（Binance + Bybit + OKX）讀取最新清算數據。每 5 分鐘更新一次 factor 分數；raw USD 總量即時可查。",
        parameters: [
          { name: "symbol", in: "query",
            schema: { type: "string", example: "BTC,ETH" },
            description: "逗號分隔，預設全部（BTC ETH SOL BNB XRP DOGE ADA TRX FIL LINK）" },
          { name: "window", in: "query",
            schema: { type: "string", enum: ["1h","4h","24h","7d"], example: "1h,24h" },
            description: "時間窗口，逗號分隔，預設全部" },
          { name: "format", in: "query",
            schema: { type: "string", enum: ["grouped","factors"], default: "grouped" },
            description: "grouped = 按 symbol 分層；factors = 平鋪 factor-vector（供程式交易直接使用）" }
        ],
        responses: {
          "200": {
            description: "清算快照",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                generated_at:    { type: "string", format: "date-time" },
                data_as_of:      { type: "string", format: "date-time" },
                has_data:        { type: "boolean" },
                aggregator_note: { type: "string" },
                symbols: {
                  type: "object",
                  additionalProperties: {
                    type: "object",
                    properties: {
                      symbol:  { type: "string" },
                      windows: {
                        type: "object",
                        additionalProperties: {
                          type: "object",
                          properties: {
                            total_usd:     { type: "number" },
                            long_liq_usd:  { type: "number" },
                            short_liq_usd: { type: "number" },
                            score:         { type: "number", minimum: -1, maximum: 1 },
                            direction:     { type: "string", enum: ["bullish","bearish","neutral"] },
                            computed_at:   { type: "string", format: "date-time" }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }}}
          },
          "400": { description: "無效 symbol 或 window 參數" }
        }
      }
    },

    "/v2/liquidations/history": {
      get: {
        tags: ["liquidations"],
        summary: "清算歷史時序（最長 ~500 天）",
        description: "雙資料源合併：CoinGlass 回灌（1h/1d bucket，最長 ~500 天）+ 自建聚合（5m bucket，從服務啟動後累積）。相同時間戳優先使用自建資料。resample < 1h 時 CoinGlass 資料不參與（無亞小時精度）。",
        parameters: [
          { name: "symbol",   in: "query", required: true,
            schema: { type: "string", enum: ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","TRX","FIL","LINK"] },
            description: "必填。單一幣種符號" },
          { name: "from",     in: "query",
            schema: { type: "string", format: "date-time" },
            description: "起始時間（預設：30 天前）" },
          { name: "to",       in: "query",
            schema: { type: "string", format: "date-time" },
            description: "結束時間（預設：現在）" },
          { name: "resample", in: "query",
            schema: { type: "string", enum: ["5m","15m","1h","4h","1d"], default: "1h" },
            description: "重採樣粒度。5m/15m 只有自建資料；1h/4h/1d 會合併 CoinGlass 回灌" }
        ],
        responses: {
          "200": {
            description: "歷史時序資料",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                symbol:      { type: "string" },
                resample:    { type: "string" },
                from:        { type: "string", format: "date-time" },
                to:          { type: "string", format: "date-time" },
                count:       { type: "integer" },
                history: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      timestamp:     { type: "string", format: "date-time" },
                      total_usd:     { type: "number" },
                      long_liq_usd:  { type: "number" },
                      short_liq_usd: { type: "number" },
                      source:        { type: "string", enum: ["self_hosted","coinglass_backfill"] }
                    }
                  }
                }
              }
            }}}
          },
          "400": { description: "symbol 或 resample 參數無效，或 from/to 格式錯誤" }
        }
      }
    },

    // ── /api/v2/funding-rates ────────────────────────────────────
    "/v2/funding-rates": {
      get: {
        tags: ["funding_rates"],
        summary: "資金費率歷史時序（多交易所）",
        description: "CoinGlass 回灌 + 即時輪詢。各交易所原生解析度：Binance/Bybit/OKX/Gate 8h，Hyperliquid 1h。",
        parameters: [
          { name: "symbol",   in: "query", schema: { type: "string", default: "BTC", enum: ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA"] }, description: "幣種（預設 BTC）" },
          { name: "exchange", in: "query", schema: { type: "string", example: "Binance" }, description: "交易所篩選（省略則回傳全部）" },
          { name: "days",     in: "query", schema: { type: "integer", default: 7, maximum: 90 }, description: "回溯天數（最大 90）" },
          { name: "limit",    in: "query", schema: { type: "integer", default: 200, maximum: 2000 }, description: "最多回傳筆數（最大 2000）" }
        ],
        responses: {
          "200": {
            description: "按交易所分組的資金費率時序",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                generated_at: { type: "string", format: "date-time" },
                symbol:       { type: "string" },
                exchange:     { type: "string" },
                days:         { type: "integer" },
                total_rows:   { type: "integer" },
                by_exchange: {
                  type: "object",
                  additionalProperties: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        time:           { type: "string", format: "date-time" },
                        rate:           { type: "number", description: "原始費率，如 0.0001 = 0.01%" },
                        annualized_pct: { type: "number", description: "年化利率（%）" },
                        interval_h:     { type: "number", description: "結算週期（小時）" },
                        source:         { type: "string" }
                      }
                    }
                  }
                }
              }
            }}}
          }
        }
      }
    },

    "/v2/funding-rates/latest": {
      get: {
        tags: ["funding_rates"],
        summary: "各交易所最新資金費率",
        parameters: [
          { name: "symbol", in: "query", schema: { type: "string", default: "BTC", description: "幣種，或 all 取 7 個主幣種" } }
        ],
        responses: {
          "200": {
            description: "各交易所最新費率 + 情緒判斷",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                generated_at: { type: "string", format: "date-time" },
                data: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      exchange:       { type: "string" },
                      rate:           { type: "number" },
                      annualized_pct: { type: "number" },
                      interval_h:     { type: "number" },
                      time:           { type: "string", format: "date-time" },
                      sentiment:      { type: "string", enum: ["overheated_long","positive","neutral","negative_squeeze"] }
                    }
                  }
                }
              }
            }}}
          }
        }
      }
    },

    "/v2/funding-rates/stats": {
      get: {
        tags: ["funding_rates"],
        summary: "資金費率統計摘要（z-score / 歷史百分位）",
        description: "90 天歷史窗口，多交易所均值序列計算 z-score + 歷史百分位。z-score > 2 → 多頭過熱（bearish contrarian）；< -2 → 空頭過熱（bullish contrarian）。",
        parameters: [
          { name: "symbol", in: "query", schema: { type: "string", default: "BTC" }, description: "幣種（預設 BTC）" },
          { name: "days",   in: "query", schema: { type: "integer", default: 90, maximum: 180 }, description: "統計窗口天數（最大 180）" }
        ],
        responses: {
          "200": {
            description: "統計摘要",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                generated_at: { type: "string", format: "date-time" },
                symbol:       { type: "string" },
                latest_by_exchange: { type: "array", items: { type: "object" } },
                history_stats: {
                  type: "object",
                  properties: {
                    mean:         { type: "number" },
                    std:          { type: "number" },
                    min:          { type: "number" },
                    max:          { type: "number" },
                    current:      { type: "number" },
                    zscore:       { type: "number" },
                    percentile:   { type: "number", description: "當前費率在歷史分布中的百分位（0–100）" },
                    sample_count: { type: "integer" },
                    window_days:  { type: "integer" }
                  }
                }
              }
            }}}
          }
        }
      }
    },

    // ── /api/v2/signals ──────────────────────────────────────────
    "/v2/signals": {
      get: {
        tags: ["factors"],
        summary: "加密市場訊號列表（含 bias 正規化）",
        description: "從最新 dashboard snapshot 取出 cryptoSignals，支援按類別、衝擊程度、偏向篩選。bias_en / bias_score 欄位已自動將中文偏向轉換為英文（bullish / bearish / neutral）及數值（+1 / -1 / 0）。",
        parameters: [
          { name: "category", in: "query", schema: { type: "string", example: "flow" },
            description: "訊號類別（flow / on_chain / derivatives …）" },
          { name: "impact",   in: "query", schema: { type: "string", enum: ["high","medium","low"] },
            description: "衝擊程度篩選" },
          { name: "bias",     in: "query", schema: { type: "string", example: "bullish" },
            description: "方向篩選，接受英文（bullish/bearish/neutral）或中文（偏漲/偏跌/震盪）" },
          { name: "since",    in: "query", schema: { type: "string", format: "date-time" },
            description: "只返回 time >= since 的訊號" },
          { name: "limit",    in: "query", schema: { type: "integer", default: 50, maximum: 200 }, description: "最多返回筆數（最大 200）" }
        ],
        responses: {
          "200": {
            description: "訊號列表",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                count:   { type: "integer" },
                signals: { type: "array", items: {
                  type: "object",
                  properties: {
                    bias_en:    { type: "string", enum: ["bullish","bearish","neutral","strong_bullish","strong_bearish","unknown"] },
                    bias_score: { type: "number", enum: [1, -1, 0] }
                  }
                }}
              }
            }}}
          },
          "404": { description: "尚無 dashboard 資料" }
        }
      }
    },

    // ── /api/v2/trade/signal ─────────────────────────────────────
    "/v2/trade/signal": {
      get: {
        tags: ["factors"],
        summary: "進出場訊號快照（Level 1+2+3）",
        description: `整合 composite score、gate 條件、動能三層邏輯，輸出單一進出場訊號供下游參考。

## 三層訊號邏輯

| 層 | 來源 | 作用 |
|----|------|------|
| Level 1 — Direction | composite score vs ±0.15 門檻 | 判斷多空偏向 |
| Level 2 — Gate 驗證 | macro / liquidity / risk gates | 確認市場條件是否允許進場 |
| Level 3 — Momentum | 最近 3 筆 vs 前 3 筆 composite score 差 | 動能升溫/降溫調整倉位乘數 |

## action 語義

| action | 意義 |
|--------|------|
| \`enter_long\` | 多頭方向確認 + gate 通過 + 動能不衰退 |
| \`enter_short\` | 空頭方向確認 + gate 通過 + 動能不升溫 |
| \`hold_long\` | 方向看多但動能轉弱，持倉不加碼 |
| \`hold_short\` | 方向看空但動能升溫，持倉不加碼 |
| \`reduce\` | 槓桿過熱（gate \`risk.leverage_overextended\` 觸發），建議降倉 |
| \`neutral\` | score 在 ±0.15 中性區間 |
| \`wait\` | 重大事件黑盒窗口，或多個 gate 同時封鎖 |

## position_size_mult 計算

\`strength × momentum_mult × gate_mult\`，上限 1.0。

- \`momentum_mult\`：rising=1.1 / flat=1.0 / falling=0.75
- \`gate_mult\`：0 blocking=1.0 / 1=0.6 / 2=0.3 / 3+=0.0`,
        responses: {
          "200": {
            description: "訊號快照",
            headers: {
              "X-Data-Age-Hours": { schema: { type: "string" }, description: "資料距今小時數（浮點數）" }
            },
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                computed_at: { type: "string", format: "date-time", description: "Factor 計算時間" },
                age_hours:   { type: "number", description: "資料距今小時數" },
                signal: {
                  type: "object",
                  description: "程式交易直接消費的核心訊號",
                  properties: {
                    action: {
                      type: "string",
                      enum: ["enter_long","enter_short","hold_long","hold_short","reduce","neutral","wait"],
                      description: "建議行動（詳見上方語義說明）"
                    },
                    direction: {
                      type: "string",
                      enum: ["long","long_weak","short","short_weak","neutral"],
                      description: "方向判斷（long_weak/short_weak = score 方向但 gate 未確認）"
                    },
                    position_size_mult: {
                      type: "number", minimum: 0, maximum: 1,
                      description: "倉位乘數建議（0=不進場，1=滿倉；由 strength × momentum × gate 計算）"
                    }
                  }
                },
                composite: {
                  type: "object",
                  description: "Composite score 詳情",
                  properties: {
                    score:        { type: "number", minimum: -1, maximum: 1, description: "Factor 加權合成分數（負=偏空，正=偏多）" },
                    label:        { type: "string", description: "分數語義標籤（如 risk_on / risk_off）" },
                    coverage_pct: { type: "number", description: "有效 factor 覆蓋率 %（0–100）" },
                    strength:     { type: "number", minimum: 0, maximum: 1, description: "訊號強度（abs(score) 正規化 + 覆蓋率加成）" },
                    momentum:     { type: "string", enum: ["rising","falling","flat"], description: "動能方向（最近 3 筆 vs 前 3 筆均值差）" },
                    momentum_delta: { type: "number", description: "動能數值差（正=升溫，負=降溫）" }
                  }
                },
                gates: {
                  type: "object",
                  description: "Gate 風險評估",
                  properties: {
                    risk_level: { type: "string", enum: ["low","medium","high"], description: "整體風險等級（由 blocking 數量決定）" },
                    blocking:   { type: "array", items: { type: "string" }, description: "觸發中的封鎖 gate 列表（空陣列=全通過）" },
                    all_clear:  { type: "boolean", description: "true = 無任何 gate 封鎖" },
                    detail: {
                      type: "object",
                      description: "各 gate 狀態",
                      properties: {
                        macro_favorable:       { type: "boolean", nullable: true },
                        liquidity_adequate:    { type: "boolean", nullable: true },
                        blackout_window:       { type: "boolean", nullable: true },
                        leverage_overextended: { type: "boolean", nullable: true },
                        yield_curve_inverted:  { type: "boolean", nullable: true },
                        regulatory_level:      { type: "string",  nullable: true, enum: ["low","medium","high"] }
                      }
                    }
                  }
                }
              }
            }}}
          },
          "404": { description: "尚無 factor 資料（需先執行 update-data.mjs）" },
          "503": {
            description: "資料過舊（age_hours > 閾值）或 composite score 無法計算",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                error:                  { type: "string" },
                computed_at:            { type: "string", format: "date-time" },
                age_hours:              { type: "number" },
                stale_threshold_hours:  { type: "number" }
              }
            }}}
          }
        }
      }
    },

    // ── /api/v2/sla ──────────────────────────────────────────────
    "/v2/sla": {
      get: {
        tags: ["system"],
        summary: "Collector SLA 統計（各 collector 成功率）",
        description: "彙總指定回溯天數內每個 collector 的執行成功率。sla_pct 越低表示該 collector 越不穩定。結果按 sla_pct 升序排列（最差的排第一）。",
        parameters: [
          { name: "days", in: "query",
            schema: { type: "integer", default: 7, minimum: 1, maximum: 30 },
            description: "回溯天數（1–30，預設 7）" }
        ],
        responses: {
          "200": {
            description: "SLA 統計結果",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                generated_at:  { type: "string", format: "date-time" },
                lookback_days: { type: "integer" },
                total_runs:    { type: "integer" },
                collectors: {
                  type: "object",
                  additionalProperties: {
                    type: "object",
                    properties: {
                      total_runs:      { type: "integer" },
                      success_runs:    { type: "integer" },
                      failed_runs:     { type: "integer" },
                      sla_pct:         { type: "number", description: "成功率 %（0–100）" },
                      last_success_at: { type: "string", format: "date-time" },
                      last_failure_at: { type: "string", format: "date-time" }
                    }
                  }
                }
              }
            }}}
          },
          "500": { description: "資料庫查詢失敗" }
        }
      }
    },

    // ── /api/v2/comment/validation/* ─────────────────────────────
    "/v2/comment/validation/summary": {
      get: {
        tags: ["validation"],
        summary: "綜合驗證摘要（Regime + Scores + Factors + Gates + News）",
        description: "一次回傳所有驗證層的最新結果與 overall_verdict。\n\n**評分說明**：\n- `PASSING`：Spearman ρ > 0.15 且統計顯著\n- `PARTIAL`：部分時框通過\n- `NEEDS_IMPROVEMENT`：ρ 接近 0 或反向\n- `INSUFFICIENT_DATA`：樣本數 < 10，無法評估\n\n每日 02:00 UTC 自動執行（pm2 regime-heartbeat）。可手動觸發：`node backend/scripts/validation-runner.js --days=90`",
        parameters: [
          { name: "days", in: "query", schema: { type: "integer", default: 90 }, description: "回溯天數" }
        ],
        responses: {
          "200": {
            description: "綜合驗證結果",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                computed_at:      { type: "string", format: "date-time" },
                data_window_days: { type: "integer" },
                overall_verdict:  { type: "string", enum: ["PASSING","PARTIAL","NEEDS_IMPROVEMENT","INSUFFICIENT_DATA"] },
                regime:           { type: "object", properties: { status: { type: "string" }, spearman_rho: { type: "number", nullable: true } } },
                scores:           { type: "object", properties: { status: { type: "string" } } },
                factors:          { type: "object", properties: { status: { type: "string" }, total_factors: { type: "integer" } } },
                gates:            { type: "object", properties: { status: { type: "string" } } },
                news_direction:   { type: "object", properties: { status: { type: "string" }, overall_hit_rate: { type: "number", nullable: true } } },
                priority_actions: { type: "array", items: { type: "string" } }
              }
            }}}
          },
          "404": { description: "尚無驗證資料，請先執行 validation-runner.js" }
        }
      }
    },

    "/v2/comment/validation/regime": {
      get: {
        tags: ["validation"],
        summary: "Regime 標籤預測力驗證（Spearman ρ vs t+7d BTC 報酬）",
        description: "驗證 `risk_on` / `risk_off` / `neutral_drift` 等 regime 標籤對 BTC 7日後報酬的預測力。\n\n`separated=true` 表示 risk_on 的平均報酬 > risk_off，方向判斷正確。`spearman_rho > 0.1` 為通過門檻。",
        responses: {
          "200": {
            description: "Regime 驗證結果",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                status:        { type: "string", enum: ["PASSING","WEAK","INSUFFICIENT_DATA"] },
                spearman_rho:  { type: "number", nullable: true, description: "Spearman ρ（regime 數值化 vs t+7d BTC 報酬）" },
                n:             { type: "integer", description: "有效樣本數" },
                separated:     { type: "boolean", description: "risk_on avg return > risk_off avg return" },
                regime_stats:  { type: "object", description: "各 regime 的平均 7d 報酬與樣本數" }
              }
            }}}
          },
          "404": { description: "尚無驗證資料" }
        }
      }
    },

    "/v2/comment/validation/scores": {
      get: {
        tags: ["validation"],
        summary: "Comment Score 預測力驗證（intraday / short-term / mid-term）",
        description: "驗證三個時框的 score 對 BTC 前向報酬的 Spearman ρ。\n\n各時框通過門檻：ρ > 0.15。至少 2 個時框通過 → `PASSING`；1 個 → `PARTIAL`；0 個 → `FAILING`。",
        responses: {
          "200": {
            description: "Score 驗證結果",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                status: { type: "string", enum: ["PASSING","PARTIAL","FAILING","INSUFFICIENT_DATA"] },
                horizons: {
                  type: "object",
                  properties: {
                    intraday_4h:   { type: "object", properties: { rho: { type: "number", nullable: true }, n: { type: "integer" }, passing: { type: "boolean" } } },
                    short_term_3d: { type: "object", properties: { rho: { type: "number", nullable: true }, n: { type: "integer" }, passing: { type: "boolean" } } },
                    mid_term_7d:   { type: "object", properties: { rho: { type: "number", nullable: true }, n: { type: "integer" }, passing: { type: "boolean" } } }
                  }
                }
              }
            }}}
          },
          "404": { description: "尚無驗證資料" }
        }
      }
    },

    "/v2/comment/validation/factors": {
      get: {
        tags: ["validation"],
        summary: "Factor 預測力排名（Spearman ρ vs t+24h BTC 報酬）",
        description: "對所有 factor_snapshots 中的 factor 計算與 t+24h BTC 報酬的 Spearman ρ，排名並分類。\n\n**`inverse_factors`**：ρ < −0.1 的 factor，即 score 越高、報酬越低（反向預測）。Regime engine 會自動將這些 factor 的 score 乘以 −1 後再使用（validation-driven 自動校正）。\n\n此結果每 30 分鐘被 Regime engine 快取讀取一次。",
        responses: {
          "200": {
            description: "Factor 預測力報告",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                status:          { type: "string", enum: ["COMPUTED","INSUFFICIENT_DATA"] },
                total_factors:   { type: "integer", description: "參與評估的 factor 數量" },
                top_useful:      { type: "array", description: "|ρ| > 0.12 的 factor，按 |ρ| 降序排列（最多 10 個）",
                  items: { type: "object", properties: {
                    factor_key: { type: "string" },
                    rho_24h:    { type: "number" },
                    n:          { type: "integer" },
                    useful:     { type: "boolean" },
                    direction:  { type: "string", enum: ["normal","inverse"], description: "normal=正向預測；inverse=反向，regime engine 自動翻轉" }
                  }}
                },
                top_useless:     { type: "array", description: "|ρ| ≤ 0.12 的 factor（最多 5 個）" },
                inverse_factors: { type: "array", description: "ρ < −0.1 的反向 factor，regime engine 已自動翻轉其 score 方向",
                  items: { type: "object", properties: {
                    factor_key: { type: "string" },
                    rho_24h:    { type: "number" }
                  }}
                }
              }
            }}}
          },
          "404": { description: "尚無驗證資料" }
        }
      }
    },

    "/v2/comment/validation/gates": {
      get: {
        tags: ["validation"],
        summary: "Gate 條件有效性驗證（觸發時 vs 未觸發時的波動率比）",
        description: "驗證各 gate 條件觸發時是否帶來更高的市場波動率。`vol_ratio ≥ 1.5` → gate 有效（能區分高/低波動期）。",
        responses: {
          "200": {
            description: "Gate 驗證結果",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                status:            { type: "string", enum: ["PASSING","WEAK","INSUFFICIENT_DATA"] },
                effective_gates:   { type: "array", items: { type: "string" }, description: "vol_ratio ≥ 1.5 的有效 gate" },
                ineffective_gates: { type: "array", items: { type: "string" } },
                gate_stats:        { type: "object", description: "各 gate 的詳細統計（triggered_n / normal_n / avg_vol_on / avg_vol_off / vol_ratio）" }
              }
            }}}
          },
          "404": { description: "尚無驗證資料" }
        }
      }
    },

    "/v2/comment/validation/composite": {
      get: {
        tags: ["validation"],
        summary: "Composite Score 對 BTC 前向報酬驗證（含分桶統計）",
        description: "同 `/v2/comment/validation/scores`，但針對 composite_score 整體分析，額外提供按 score 區間分桶的前向報酬分布統計（可用於判斷 score 的線性程度）。",
        responses: {
          "200": { description: "Composite score 驗證結果" }
        }
      }
    },

    // ── /api/v2/news/validation ──────────────────────────────────
    "/v2/news/validation": {
      get: {
        tags: ["validation"],
        summary: "新聞方向分類器驗證結果（hit rate）",
        description: "讀取 `v1/data/direction-validation.json`。預設只返回 summary；加 `?detail=1` 返回完整驗證記錄。需先執行 `node v1/scripts/validate-news-direction.mjs` 產生驗證檔案。",
        parameters: [
          { name: "detail", in: "query",
            schema: { type: "integer", enum: [0, 1], default: 0 },
            description: "1 = 返回完整逐條驗證記錄，0（預設）= 只返回 summary" }
        ],
        responses: {
          "200": { description: "驗證結果（summary 或完整版）" },
          "404": { description: "驗證結果尚未生成（請先執行驗證腳本）" },
          "500": { description: "讀取驗證結果失敗" }
        }
      }
    },

    // ── §6 /api/v2/memory/* ──────────────────────────────────────
    "/v2/memory/summary": {
      get: {
        tags: ["memory"],
        summary: "Memory 系統健康狀態總覽",
        description: "回傳 Layer 1-5 各層的狀態：episode 數量、pattern 數量、regime transition 累積量等。",
        responses: { "200": { description: "Memory 系統狀態" } }
      }
    },

    "/v2/memory/episodes": {
      get: {
        tags: ["memory"],
        summary: "重大市場事件列表（Layer 1: Episode Memory）",
        description: "回傳歷史重大市場事件，含發生時的市場快照與事後結果。\n\n用途：narrative 引用（「上次 F&G=21 + OI 上升時 BTC +12%」）",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
          { name: "type",  in: "query", schema: { type: "string", enum: ["fed_speech","geopolitical_shock","etf_flow","liquidation_event","halving","regulation","macro_data"] }, description: "事件類型篩選" },
          { name: "days",  in: "query", schema: { type: "integer", default: 365 }, description: "回溯天數" }
        ],
        responses: { "200": { description: "Episode 列表" } }
      },
      post: {
        tags: ["memory"],
        summary: "新增重大事件（human review 工作流）",
        description: "手動新增一筆 episode。通常在重大事件發生後由人工填入。",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object",
            required: ["title", "trigger_at", "trigger_type"],
            properties: {
              title:            { type: "string", example: "Fed 意外鷹派：Powell 暗示暫停降息" },
              trigger_at:       { type: "string", format: "date-time" },
              trigger_type:     { type: "string", enum: ["fed_speech","geopolitical_shock","etf_flow","liquidation_event","halving","regulation","macro_data"] },
              trigger_entities: { type: "array", items: { type: "string" } },
              context:          { type: "object" },
              category:         { type: "string" },
              severity:         { type: "string", enum: ["low","medium","high","critical"] },
              tags:             { type: "array", items: { type: "string" } }
            }
          }}}
        },
        responses: { "201": { description: "Episode 建立成功" } }
      }
    },

    "/v2/memory/episodes/similar": {
      get: {
        tags: ["memory"],
        summary: "與當前市場最相似的歷史事件",
        description: "根據當前 regime + F&G 分數，從 episode 庫中找最相似的歷史案例供 narrative 引用。",
        responses: { "200": { description: "相似 episode 列表" } }
      }
    },

    "/v2/memory/patterns": {
      get: {
        tags: ["memory"],
        summary: "所有 Pattern 定義（Layer 2: Pattern Memory）",
        description: "回傳 8 個預定義的因子組合 pattern，含統計（occurrences / win_rate / avg_return）。",
        responses: { "200": { description: "Pattern 列表" } }
      }
    },

    "/v2/memory/patterns/active": {
      get: {
        tags: ["memory"],
        summary: "當前匹配的 Pattern 列表",
        description: "根據最新 factor snapshot，回傳當前符合 signature 的 pattern。\n\n例：F&G=21 + OI↑ + funding↑ → 匹配 Accumulation pattern（歷史勝率 83%）",
        responses: { "200": { description: "匹配的 pattern 列表" } }
      }
    },

    "/v2/memory/transitions": {
      get: {
        tags: ["memory"],
        summary: "Regime 切換歷史（Layer 4: Regime Transition Memory）",
        description: "回傳 crypto regime 的歷史切換記錄，含切換時的觸發 factors 與事後結果（outcome）。",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
          { name: "days",  in: "query", schema: { type: "integer", default: 90 } }
        ],
        responses: { "200": { description: "Regime transition 列表" } }
      }
    },

    "/v2/memory/transitions/stats": {
      get: {
        tags: ["memory"],
        summary: "各 Regime 切換的結果統計",
        description: "統計各 from_regime → to_regime 的平均 7d return + 勝率（需先有 outcome 資料）。",
        responses: { "200": { description: "切換統計表" } }
      }
    },

    "/v2/memory/transitions/{id}/outcome": {
      post: {
        tags: ["memory"],
        summary: "回填 regime transition 的事後結果",
        description: "在 regime 切換後，事後填入標的資產的前向報酬（7d / 14d），用於驗證 regime 切換的預測力。",
        parameters: [
          { name: "id", in: "path", required: true,
            schema: { type: "integer" }, description: "Transition ID（從 /v2/memory/transitions 取得）" }
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: {
            type: "object",
            properties: {
              btc_return_7d:  { type: "number", description: "BTC 7 日前向報酬（%）" },
              btc_return_14d: { type: "number", description: "BTC 14 日前向報酬（%）" },
              notes:          { type: "string" }
            }
          }}}
        },
        responses: {
          "200": { description: "Outcome 已記錄" },
          "404": { description: "找不到指定 transition" }
        }
      }
    },

    "/v2/memory/classifier/context": {
      get: {
        tags: ["memory"],
        summary: "分類器 Context 準確率（Layer 5: Classifier Context Memory）",
        description: "回傳 per-entity / per-category / per-event_type 的 direction_en 準確率。\n\n用途：動態調整 news confidence（hit_rate < 0.4 → 考慮 contrarian）",
        parameters: [
          { name: "context_key", in: "query", schema: { type: "string", example: "entity:powell" }, description: "context 篩選（entity:xxx / category:xxx / event_type:xxx）" },
          { name: "direction",   in: "query", schema: { type: "string", enum: ["bullish","bearish","neutral"] } }
        ],
        responses: { "200": { description: "Classifier context 準確率" } }
      }
    },

    // ── §6 Layer 3: /api/v2/kg/* ─────────────────────────────────
    "/v2/kg/stats": {
      get: {
        tags: ["kg"],
        summary: "Knowledge Graph 統計概覽",
        description: "回傳節點數、邊數、節點類型分佈、最高連接度節點、邊關係分佈。",
        responses: { "200": { description: "KG 統計" } }
      }
    },

    "/v2/kg/entities": {
      get: {
        tags: ["kg"],
        summary: "所有節點列表",
        description: "回傳 KG 中所有節點，可依 type 篩選或關鍵字搜尋。\n\n節點類型：`Person` / `Institution` / `Asset` / `Event_Type` / `Concept` / `Country` / `Exchange` / `Sector`",
        parameters: [
          { name: "type", in: "query",
            schema: { type: "string", enum: ["Person","Institution","Asset","Event_Type","Concept","Country","Exchange","Sector"] },
            description: "節點類型篩選" },
          { name: "q", in: "query", schema: { type: "string", example: "powell" }, description: "關鍵字搜尋（名稱 / 別名 / id）" }
        ],
        responses: { "200": { description: "節點列表，依類型分組" } }
      }
    },

    "/v2/kg/entity/{name}": {
      get: {
        tags: ["kg"],
        summary: "查詢實體節點及其關係",
        description: "根據節點名稱、id 或別名查詢節點，並回傳所有 outgoing/incoming 關係邊及鄰居列表。\n\n範例：`/v2/kg/entity/powell`、`/v2/kg/entity/iran`、`/v2/kg/entity/btc`",
        parameters: [
          { name: "name", in: "path", required: true,
            schema: { type: "string", example: "powell" },
            description: "節點 id、名稱或別名（不分大小寫，支援部分比對）" }
        ],
        responses: {
          "200": { description: "節點詳情 + 關係邊 + 鄰居列表" },
          "404": { description: "找不到對應節點" }
        }
      }
    },

    "/v2/kg/impact_chain": {
      get: {
        tags: ["kg"],
        summary: "影響鏈推理（BFS）",
        description: "從觸發事件/實體出發，以 BFS 遍歷知識圖譜，推理影響路徑。\n\n**範例**：\n- `?trigger=iran` → 伊朗 → 荷莫茲 → 油價 → 通脹 → Fed 鷹派 → BTC 承壓\n- `?trigger=fomc` → FOMC → 利率路徑 → DXY → BTC\n- `?trigger=trump` → 關稅 → 通脹 → 衰退風險 → BTC\n\n每條路徑包含：跳數、累積信心權重、每步影響方向。",
        parameters: [
          { name: "trigger", in: "query", required: true,
            schema: { type: "string", example: "iran" },
            description: "觸發實體名稱或 id（例：iran / powell / cpi / tariff）" },
          { name: "depth", in: "query",
            schema: { type: "integer", default: 4, minimum: 1, maximum: 6 },
            description: "最大推理跳數（1-6）" },
          { name: "targets", in: "query",
            schema: { type: "string", example: "btc,gold,spx" },
            description: "目標資產篩選（逗號分隔，空=全部）" }
        ],
        responses: {
          "200": {
            description: "影響鏈推理結果",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                trigger:       { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, type: { type: "string" } } },
                summary: {
                  type: "object",
                  properties: {
                    btc_impact: { type: "string", enum: ["bullish","bearish","neutral","mixed","depends","unknown"] },
                    oil_impact: { type: "string" },
                    narrative:  { type: "string", description: "自然語言影響摘要" }
                  }
                },
                asset_impacts: { type: "array", description: "各資產的影響路徑（依信心權重排序）" },
                all_paths:     { type: "array", description: "所有推理路徑（含跳數/累積權重/每步關係）" }
              }
            }}}
          },
          "400": { description: "缺少 trigger 參數" },
          "404": { description: "找不到觸發實體" }
        }
      }
    },

    "/v2/kg/related_news": {
      get: {
        tags: ["kg"],
        summary: "實體相關新聞（含邊際遞減）",
        description: "搜尋與指定實體相關的近期新聞，並計算邊際影響係數。\n\n**邊際遞減邏輯**：同一實體反覆出現時，影響力遞減（1st=1.0, 2nd=0.6, 3rd=0.3, 4th+=0.2）。這避免對「Powell 本月第 5 次提通脹」過度反應。",
        parameters: [
          { name: "entity", in: "query", required: true,
            schema: { type: "string", example: "powell" },
            description: "實體名稱或 id" },
          { name: "days", in: "query",
            schema: { type: "integer", default: 30, maximum: 180 },
            description: "回溯天數" },
          { name: "limit", in: "query",
            schema: { type: "integer", default: 20, maximum: 100 } }
        ],
        responses: {
          "200": {
            description: "相關新聞列表 + 邊際遞減係數",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                entity:           { type: "object" },
                total_found:      { type: "integer" },
                month_count:      { type: "integer", description: "本月出現次數" },
                marginal_note:    { type: "string",  description: "邊際影響說明（若出現次數 > 5）" },
                direction_stats:  { type: "object",  description: "方向統計（bullish/bearish/neutral 各幾篇）" },
                news:             { type: "array",   description: "新聞列表（含 marginal_multiplier / effective_confidence）" }
              }
            }}}
          },
          "404": { description: "找不到實體" }
        }
      }
    },

  },

  components: {
    schemas: {

      NewsItem: {
        type: "object",
        properties: {
          id:                  { type: "integer" },
          source:              { type: "string", example: "jin10" },
          source_id:           { type: "string" },
          source_url:          { type: "string" },
          published_at:        { type: "string", format: "date-time" },
          available_at:        { type: "string", format: "date-time" },
          ingest_lag_seconds:  { type: "integer" },
          content:             { type: "string" },
          is_clickbait:        { type: "boolean" },
          relevance_crypto:    { type: "number", minimum: 0, maximum: 1 },
          category:            { type: "string", enum: ["crypto","macro","regulatory","geopolitical","commodity","general"] },
          event_type:          { type: "string", enum: ["fed_speech","data_release","etf_flow","liquidation_event","regulation","geopolitical_shock","trade_policy","central_bank","general"] },
          direction_en:        { type: "string", enum: ["bullish","bearish","neutral","ambiguous"],
            description: "新聞情緒方向。⚠️ **這是新聞語氣分類，不是價格方向預測。** 新聞情緒與標的價格的相關性可能為正、為負、甚至無相關（contrarian effect）。不可直接做為買賣訊號。如何詮釋此欄位做交易決策是 client 的責任。" },
          entities:            { type: "array", items: { type: "string" } },
          confidence:          { type: "integer", minimum: 1, maximum: 5 },
          classifier_version:  { type: "string", example: "v2.3.0" }
        }
      },

      Factor: {
        type: "object",
        properties: {
          category:    { type: "string" },
          score:       { type: "number", minimum: -1, maximum: 1 },
          value:       { type: "number" },
          direction:   { type: "string", enum: ["bullish","bearish","neutral","unknown"] },
          confidence:  { type: "number", minimum: 0, maximum: 1 },
          source_tier: { type: "integer", minimum: 1, maximum: 3 },
          computed_at: { type: "string", format: "date-time" }
        }
      },

      MacroComment: {
        type: "object",
        properties: {
          computed_at:     { type: "string", format: "date-time" },
          snapshot_id:     { type: "string", example: "snap_20260416_1015" },
          comment_version: { type: "string", example: "v1.0.0" },
          engine:          { type: "string", enum: ["rule_based"] },
          macro_regime: {
            type: "object",
            properties: {
              label:        { type: "string", enum: ["easing_early","easing_late","tightening_early","tightening_late","neutral","shock"] },
              confidence:   { type: "number" },
              stability_24h:{ type: "number" }
            }
          },
          macro_drivers: {
            type: "object",
            properties: {
              yields: {
                type: "object",
                properties: {
                  us_10y:       { type: "number", example: 4.26, description: "美國 10Y 殖利率（%）" },
                  us_2y:        { type: "number", example: 3.76 },
                  us_3m:        { type: "number", example: 3.71 },
                  spread_2s10s: { type: "number", example: 0.5, description: "2s10s 殖利率差（正 = 正常斜率；負 = 倒掛）" },
                  regime:       { type: "string", enum: ["steepening","inverted","flat"] }
                }
              },
              dxy: {
                type: "object",
                properties: {
                  value:   { type: "number", example: 98.2 },
                  z_score: { type: "number", nullable: true }
                }
              },
              vix: {
                type: "object",
                properties: {
                  value:  { type: "number", example: 18.1 },
                  regime: { type: "string", enum: ["low","expanding","extreme"] }
                }
              },
              fed_path: {
                type: "object",
                description: "Fed 路徑推算（FRED EFFR vs 3M T-bill implied；非 CME FedWatch）",
                properties: {
                  rate_cut_prob_3m: { type: "number", nullable: true, minimum: 0.05, maximum: 0.95,
                    example: 0.05,
                    description: "T-bill implied 未來 3 個月降息概率。公式：clamp(0.05, 0.95, (effr - yield_3m) / 0.50)。資料源：FRED DFF + DGS3MO。" },
                  effr:   { type: "number", nullable: true, example: 3.64,
                    description: "有效聯邦基金利率（FRED DFF，%）" },
                  stance: { type: "string", enum: ["easing_bias","data_dependent","neutral"],
                    example: "data_dependent" },
                  inversion_depth_2s10s:  { type: "number", nullable: true, example: 0.50 },
                  front_back_spread_3m10y:{ type: "number", nullable: true, example: 0.55 },
                  note: { type: "string" }
                }
              }
            }
          },
          global_risk: {
            type: "object",
            properties: {
              level:                { type: "string", enum: ["low","moderate","elevated","high","extreme"] },
              tail_risk_score:      { type: "number" },
              geopolitical_stress:  { type: "number" },
              liquidity_stress:     { type: "number" },
              drivers:              { type: "array", items: { type: "string" } }
            }
          },
          narrative: {
            type: "object",
            properties: {
              headline:         { type: "string" },
              summary:          { type: "string" },
              key_observations: { type: "array", items: { type: "string" } },
              what_to_watch:    { type: "array", items: { type: "string" } },
              language:         { type: "string", example: "zh-Hant" }
            }
          },
          available_asset_classes: { type: "array" },
          limitations:             { type: "array", items: { type: "string" } }
        }
      },

      CryptoComment: {
        type: "object",
        description: "GET /api/comment/crypto 回傳的完整加密市場詮釋層",
        properties: {
          asset_class:     { type: "string", example: "crypto" },
          computed_at:     { type: "string", format: "date-time" },
          snapshot_id:     { type: "string" },
          comment_version: { type: "string" },
          engine:          { type: "string", enum: ["rule_based"] },
          session:         { type: "object", properties: { state: { type: "string", example: "24_7" } } },
          shared_macro_ref: {
            type: "object",
            description: "對共用宏觀 regime 的引用（從 /api/comment 衍生）",
            properties: {
              macro_regime: { type: "string", example: "neutral" },
              global_risk_level: { type: "string", example: "moderate" },
              snapshot_id: { type: "string" }
            }
          },
          regime: {
            type: "object",
            properties: {
              label:        { type: "string", enum: ["risk_on","risk_on_transition","neutral_drift","risk_off_transition","risk_off","leverage_flush"] },
              confidence:   { type: "number", minimum: 0, maximum: 1 },
              stability_24h:{ type: "number", nullable: true },
              trigger:      { type: "string", nullable: true },
              regime_hint:  { type: "string", nullable: true, description: "Pattern 提示（如 wall_of_worry、bull_trap）" }
            }
          },
          scores: {
            type: "object",
            description: "四時間框方向分數（-1 偏空 ～ +1 偏多）",
            properties: {
              intraday:   { type: "object", properties: { direction: { type: "number" }, label: { type: "string" }, confidence: { type: "number" } } },
              short_term: { type: "object", properties: { direction: { type: "number" }, label: { type: "string" }, confidence: { type: "number" } } },
              mid_term:   { type: "object", properties: { direction: { type: "number" }, label: { type: "string" }, confidence: { type: "number" } } },
              long_term:  { type: "object", properties: { direction: { type: "number" }, label: { type: "string" }, confidence: { type: "number" } } }
            }
          },
          news_sentiment: {
            type: "object",
            description: "Jin10 24h 新聞情緒分析（direction_en 分類器）",
            properties: {
              regime:           { type: "string", enum: ["panic","fear","cautious","calm","euphoria"], example: "cautious" },
              total_24h:        { type: "integer", example: 242 },
              bearish_count_24h:{ type: "integer" },
              bullish_count_24h:{ type: "integer" },
              bearish_ratio_24h:{ type: "number", example: 0.405 },
              bullish_ratio_24h:{ type: "number" },
              shift_vs_48h:     { type: "number", description: "vs 48h 前的 bearish_ratio 變化" },
              contrarian_signal:{ type: "boolean", description: "bearish_ratio 極端 → 可能為逆向看多訊號" },
              classifier:       { type: "string", example: "direction_en_v2.4_inline" }
            }
          },
          regime_context: {
            type: "object",
            properties: {
              active_patterns:      { type: "array", description: "當前命中的歷史 pattern（wall_of_worry / bull_trap 等）" },
              similar_transitions:  { type: "array", description: "從 Memory 系統匹配的類似歷史 regime 切換案例" }
            }
          },
          narrative: {
            type: "object",
            properties: {
              headline:         { type: "string" },
              key_observations: { type: "array", items: { type: "string" } },
              what_to_watch:    { type: "array", items: { type: "string" } },
              language:         { type: "string", example: "zh-Hant" }
            }
          },
          limitations: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
};

router.get("/openapi.json", (_req, res) => {
  res.json(SPEC);
});

export default router;
