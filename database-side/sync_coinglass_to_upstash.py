from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = Path(__file__).resolve().parent

INTERVAL_MS_MAP = {
    "1m": 60 * 1000,
    "3m": 3 * 60 * 1000,
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "8h": 8 * 60 * 60 * 1000,
    "12h": 12 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000,
    "1w": 7 * 24 * 60 * 60 * 1000,
}

DEFAULT_UPSTASH_KEY = "cryptopulse:database:coinglass:derivatives"
DEFAULT_LAST_UPDATED_KEY = "cryptopulse:database:coinglass:last_updated"
DEFAULT_SERIES_LIMIT = 400
DEFAULT_FETCH_LIMIT = 200
DEFAULT_LOOP_MINUTES = 30
DEFAULT_COINGLASS_BASE = "https://open-api-v4.coinglass.com"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_env_file(file_path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not file_path.exists():
        return values

    for raw_line in file_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


def load_env() -> None:
    candidates = [
        REPO_ROOT / ".env",
        REPO_ROOT / ".env.local",
        SCRIPT_DIR / ".env",
        SCRIPT_DIR / ".env.local",
    ]
    for candidate in candidates:
        for key, value in parse_env_file(candidate).items():
            os.environ.setdefault(key, value)


def env_int(name: str, default: int) -> int:
    value = os.getenv(name, "").strip()
    if not value:
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"環境變數 {name} 必須是整數，目前是: {value}") from exc


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"缺少必要環境變數：{name}")
    return value


def http_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: Any | None = None,
    timeout: int = 30,
) -> Any:
    encoded_body = None
    request_headers = {"User-Agent": "CryptoPulse-DatabaseSide/1.0"}
    if headers:
        request_headers.update(headers)

    if body is not None:
        encoded_body = json.dumps(body).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json")

    request = Request(url, data=encoded_body, headers=request_headers, method=method)

    try:
        with urlopen(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
        raise RuntimeError(f"HTTP {exc.code} {url}: {detail[:300]}") from exc
    except URLError as exc:
        raise RuntimeError(f"無法連線 {url}: {exc}") from exc

    try:
        return json.loads(payload)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"回應不是合法 JSON：{url} -> {payload[:300]}") from exc


def upstash_get_json(base_url: str, token: str, key: str) -> Any:
    url = f"{base_url.rstrip('/')}/get/{quote(key, safe='')}"
    response = http_json(url, headers={"Authorization": f"Bearer {token}"})
    result = response.get("result")
    if isinstance(result, str):
        try:
            return json.loads(result)
        except json.JSONDecodeError:
            return result
    return result


def upstash_set_json(base_url: str, token: str, key: str, value: Any) -> Any:
    url = f"{base_url.rstrip('/')}/set/{quote(key, safe='')}"
    return http_json(
        url,
        method="POST",
        headers={"Authorization": f"Bearer {token}"},
        body=value,
    )


def coinglass_get(base_url: str, api_key: str, path: str, query: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    query = query or {}
    cleaned_query = {k: v for k, v in query.items() if v is not None and v != ""}
    url = f"{base_url.rstrip('/')}{path}"
    if cleaned_query:
        url = f"{url}?{urlencode(cleaned_query)}"

    response = http_json(
        url,
        headers={
            "accept": "application/json",
            "CG-API-KEY": api_key,
        },
    )

    if str(response.get("code")) != "0":
        raise RuntimeError(f"Coinglass 回傳錯誤 {path}: {json.dumps(response, ensure_ascii=False)[:300]}")

    data = response.get("data")
    if not isinstance(data, list):
        raise RuntimeError(f"Coinglass 資料格式異常 {path}")
    return data


def get_record_timestamp(record: dict[str, Any]) -> int:
    for key in ("time", "timestamp"):
        value = record.get(key)
        if isinstance(value, (int, float)):
            return int(value)
    return 0


def get_record_identity(record: dict[str, Any]) -> str:
    sync_id = record.get("syncId")
    if sync_id is not None:
        return str(sync_id)
    timestamp = get_record_timestamp(record)
    if timestamp > 0:
        return str(timestamp)
    return json.dumps(record, sort_keys=True, ensure_ascii=False)


def merge_series(existing_items: list[dict[str, Any]], incoming_items: list[dict[str, Any]], max_items: int) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    merged: dict[str, dict[str, Any]] = {}

    for item in existing_items:
        merged[get_record_identity(item)] = item

    for item in incoming_items:
        merged[get_record_identity(item)] = item

    items = sorted(merged.values(), key=get_record_timestamp)
    if len(items) > max_items:
        items = items[-max_items:]

    latest = items[-1] if items else None
    return items, latest


def normalize_open_interest(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "time": int(item["time"]),
        "openUsd": float(item["open"]),
        "highUsd": float(item["high"]),
        "lowUsd": float(item["low"]),
        "closeUsd": float(item["close"]),
    }


def normalize_open_interest_ohlc(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "time": int(item["time"]),
        "open": float(item["open"]),
        "high": float(item["high"]),
        "low": float(item["low"]),
        "close": float(item["close"]),
    }


def normalize_liquidation(item: dict[str, Any]) -> dict[str, Any]:
    long_usd = float(item["aggregated_long_liquidation_usd"])
    short_usd = float(item["aggregated_short_liquidation_usd"])
    return {
        "time": int(item["time"]),
        "longLiquidationUsd": long_usd,
        "shortLiquidationUsd": short_usd,
        "totalLiquidationUsd": long_usd + short_usd,
    }


def normalize_funding(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "time": int(item["time"]),
        "open": float(item["open"]),
        "high": float(item["high"]),
        "low": float(item["low"]),
        "close": float(item["close"]),
    }


def normalize_long_short_ratio(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "time": int(item["time"]),
        "longPercent": float(item["global_account_long_percent"]),
        "shortPercent": float(item["global_account_short_percent"]),
        "longShortRatio": float(item["global_account_long_short_ratio"]),
    }


def normalize_top_account_ratio(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "time": int(item["time"]),
        "longPercent": float(item["top_account_long_percent"]),
        "shortPercent": float(item["top_account_short_percent"]),
        "longShortRatio": float(item["top_account_long_short_ratio"]),
    }


def normalize_top_position_ratio(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "time": int(item["time"]),
        "longPercent": float(item["top_position_long_percent"]),
        "shortPercent": float(item["top_position_short_percent"]),
        "longShortRatio": float(item["top_position_long_short_ratio"]),
    }


def normalize_aggregated_taker_volume(item: dict[str, Any]) -> dict[str, Any]:
    buy_usd = float(item["aggregated_buy_volume_usd"])
    sell_usd = float(item["aggregated_sell_volume_usd"])
    return {
        "time": int(item["time"]),
        "takerBuyVolumeUsd": buy_usd,
        "takerSellVolumeUsd": sell_usd,
        "netTakerVolumeUsd": buy_usd - sell_usd,
    }


def normalize_aggregated_cvd(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "time": int(item["time"]),
        "takerBuyVolumeUsd": float(item["agg_taker_buy_vol"]),
        "takerSellVolumeUsd": float(item["agg_taker_sell_vol"]),
        "cumulativeVolumeDeltaUsd": float(item["cum_vol_delta"]),
    }


def normalize_futures_basis(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "time": int(item["time"]),
        "openBasis": float(item["open_basis"]),
        "closeBasis": float(item["close_basis"]),
        "openChange": float(item["open_change"]),
        "closeChange": float(item["close_change"]),
    }


def normalize_etf_flow(item: dict[str, Any]) -> dict[str, Any]:
    flows = []
    for flow in item.get("etf_flows", []) or []:
        ticker = str(flow.get("etf_ticker", "")).strip()
        if not ticker:
            continue
        flows.append({
            "ticker": ticker,
            "flowUsd": float(flow.get("flow_usd", 0) or 0),
        })
    return {
        "timestamp": int(item["timestamp"]),
        "flowUsd": float(item.get("flow_usd", 0) or 0),
        "etfFlows": flows,
    }


def normalize_bitcoin_etf_net_assets(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "timestamp": int(item["timestamp"]),
        "netAssetsUsd": float(item.get("net_assets_usd", 0) or 0),
        "changeUsd": float(item.get("change_usd", 0) or 0),
    }


def normalize_hyperliquid_whale_alert(item: dict[str, Any]) -> dict[str, Any]:
    create_time = int(item.get("create_time") or 0)
    position_size = float(item.get("position_size") or 0)
    position_action = int(item.get("position_action") or 0)
    return {
        "time": create_time,
        "syncId": f"{item.get('user', '')}:{item.get('symbol', '')}:{position_action}:{create_time}:{position_size}",
        "user": str(item.get("user", "") or ""),
        "symbol": str(item.get("symbol", "") or ""),
        "positionSize": position_size,
        "entryPrice": float(item.get("entry_price") or 0),
        "liquidationPrice": float(item.get("liq_price") or 0),
        "positionValueUsd": float(item.get("position_value_usd") or 0),
        "positionAction": position_action,
    }


def normalize_hyperliquid_whale_position(item: dict[str, Any]) -> dict[str, Any]:
    create_time = int(item.get("create_time") or 0)
    update_time = int(item.get("update_time") or create_time)
    position_size = float(item.get("position_size") or 0)
    return {
        "time": update_time,
        "syncId": f"{item.get('user', '')}:{item.get('symbol', '')}:{update_time}",
        "user": str(item.get("user", "") or ""),
        "symbol": str(item.get("symbol", "") or ""),
        "positionSize": position_size,
        "entryPrice": float(item.get("entry_price") or 0),
        "markPrice": float(item.get("mark_price") or 0),
        "liquidationPrice": float(item.get("liq_price") or 0),
        "leverage": float(item.get("leverage") or 0),
        "marginBalanceUsd": float(item.get("margin_balance") or 0),
        "positionValueUsd": float(item.get("position_value_usd") or 0),
        "unrealizedPnlUsd": float(item.get("unrealized_pnl") or 0),
        "fundingFeeUsd": float(item.get("funding_fee") or 0),
        "marginMode": str(item.get("margin_mode", "") or ""),
        "createTime": create_time,
        "updateTime": update_time,
    }


def normalize_hyperliquid_wallet_position_distribution(item: dict[str, Any]) -> dict[str, Any]:
    sync_time = int(datetime.now(timezone.utc).timestamp() * 1000)
    group_name = str(item.get("group_name", "") or "")
    minimum_amount = float(item.get("minimum_amount") or 0)
    maximum_amount = float(item.get("maximum_amount") or 0)
    return {
        "time": sync_time,
        "syncId": f"{group_name}:{minimum_amount}:{maximum_amount}",
        "groupName": group_name,
        "allAddressCount": int(item.get("all_address_count") or 0),
        "positionAddressCount": int(item.get("position_address_count") or 0),
        "positionAddressPercent": float(item.get("position_address_percent") or 0),
        "biasScore": float(item.get("bias_score") or 0),
        "biasRemark": str(item.get("bias_remark", "") or ""),
        "minimumAmount": minimum_amount,
        "maximumAmount": maximum_amount,
        "longPositionUsd": float(item.get("long_position_usd") or 0),
        "shortPositionUsd": float(item.get("short_position_usd") or 0),
        "longPositionUsdPercent": float(item.get("long_position_usd_percent") or 0),
        "shortPositionUsdPercent": float(item.get("short_position_usd_percent") or 0),
        "positionUsd": float(item.get("position_usd") or 0),
        "profitAddressCount": int(item.get("profit_address_count") or 0),
        "lossAddressCount": int(item.get("loss_address_count") or 0),
        "profitAddressPercent": float(item.get("profit_address_percent") or 0),
        "lossAddressPercent": float(item.get("loss_address_percent") or 0),
    }


def build_store(existing_store: Any) -> dict[str, Any]:
    now = now_iso()
    if not isinstance(existing_store, dict):
        existing_store = {}
    return {
        "schemaVersion": 1,
        "source": "coinglass",
        "domain": "database-side",
        "createdAt": existing_store.get("createdAt", now),
        "updatedAt": now,
        "streams": existing_store.get("streams", {}),
        "snapshots": existing_store.get("snapshots", {}),
        "syncState": existing_store.get("syncState", {}),
        "meta": {
            **(existing_store.get("meta", {}) if isinstance(existing_store.get("meta"), dict) else {}),
            "lastRunAt": now,
            "runner": "python",
        },
    }


def endpoint_configs(fetch_limit: int) -> list[dict[str, Any]]:
    return [
        {
            "streamKey": "openInterestAggregated",
            "path": "/api/futures/open-interest/aggregated-history",
            "interval": "4h",
            "supportsStartTime": True,
            "limit": fetch_limit,
            "meta": {"label": "Aggregated Open Interest", "unit": "usd"},
            "series": [
                {
                    "seriesKey": "BTC",
                    "query": {"symbol": "BTC", "interval": "4h", "unit": "usd"},
                    "normalize": normalize_open_interest,
                },
                {
                    "seriesKey": "ETH",
                    "query": {"symbol": "ETH", "interval": "4h", "unit": "usd"},
                    "normalize": normalize_open_interest,
                },
            ],
        },
        {
            "streamKey": "openInterestAggregatedStablecoinMargin",
            "path": "/api/futures/open-interest/aggregated-stablecoin-history",
            "interval": "4h",
            "supportsStartTime": True,
            "limit": fetch_limit,
            "meta": {
                "label": "Aggregated Stablecoin Margin Open Interest",
                "valueType": "ohlc",
                "marginType": "stablecoin",
                "exchanges": ["Binance", "Bybit", "Gate", "Hyperliquid"],
            },
            "series": [
                {
                    "seriesKey": "BTC",
                    "query": {"symbol": "BTC", "interval": "4h", "exchange_list": "Binance,Bybit,Gate,Hyperliquid"},
                    "normalize": normalize_open_interest_ohlc,
                },
                {
                    "seriesKey": "ETH",
                    "query": {"symbol": "ETH", "interval": "4h", "exchange_list": "Binance,Bybit,Gate,Hyperliquid"},
                    "normalize": normalize_open_interest_ohlc,
                },
            ],
        },
        {
            "streamKey": "openInterestAggregatedCoinMargin",
            "path": "/api/futures/open-interest/aggregated-coin-margin-history",
            "interval": "4h",
            "supportsStartTime": True,
            "limit": fetch_limit,
            "meta": {
                "label": "Aggregated Coin Margin Open Interest",
                "valueType": "ohlc",
                "marginType": "coin",
                "exchanges": ["Binance", "Bybit", "Gate", "Hyperliquid"],
            },
            "series": [
                {
                    "seriesKey": "BTC",
                    "query": {"symbol": "BTC", "interval": "4h", "exchange_list": "Binance,Bybit,Gate,Hyperliquid"},
                    "normalize": normalize_open_interest_ohlc,
                },
                {
                    "seriesKey": "ETH",
                    "query": {"symbol": "ETH", "interval": "4h", "exchange_list": "Binance,Bybit,Gate,Hyperliquid"},
                    "normalize": normalize_open_interest_ohlc,
                },
            ],
        },
        {
            "streamKey": "aggregatedLiquidation",
            "path": "/api/futures/liquidation/aggregated-history",
            "interval": "4h",
            "supportsStartTime": True,
            "limit": fetch_limit,
            "meta": {"label": "Aggregated Liquidation", "exchanges": ["Binance", "Bybit", "Gate", "Hyperliquid"]},
            "series": [
                {
                    "seriesKey": "BTC",
                    "query": {"symbol": "BTC", "interval": "4h", "exchange_list": "Binance,Bybit,Gate,Hyperliquid"},
                    "normalize": normalize_liquidation,
                },
                {
                    "seriesKey": "ETH",
                    "query": {"symbol": "ETH", "interval": "4h", "exchange_list": "Binance,Bybit,Gate,Hyperliquid"},
                    "normalize": normalize_liquidation,
                },
            ],
        },
        {
            "streamKey": "fundingRate",
            "path": "/api/futures/funding-rate/history",
            "interval": "8h",
            "supportsStartTime": True,
            "limit": fetch_limit,
            "meta": {"label": "Funding Rate", "exchange": "Binance"},
            "series": [
                {
                    "seriesKey": "Binance:BTCUSDT",
                    "query": {"exchange": "Binance", "symbol": "BTCUSDT", "interval": "8h"},
                    "normalize": normalize_funding,
                },
                {
                    "seriesKey": "Binance:ETHUSDT",
                    "query": {"exchange": "Binance", "symbol": "ETHUSDT", "interval": "8h"},
                    "normalize": normalize_funding,
                },
            ],
        },
        {
            "streamKey": "topLongShortAccountRatio",
            "path": "/api/futures/top-long-short-account-ratio/history",
            "interval": "4h",
            "supportsStartTime": True,
            "limit": fetch_limit,
            "meta": {"label": "Top Long/Short Account Ratio", "exchange": "Binance"},
            "series": [
                {
                    "seriesKey": "Binance:BTCUSDT",
                    "query": {"exchange": "Binance", "symbol": "BTCUSDT", "interval": "4h"},
                    "normalize": normalize_top_account_ratio,
                },
                {
                    "seriesKey": "Binance:ETHUSDT",
                    "query": {"exchange": "Binance", "symbol": "ETHUSDT", "interval": "4h"},
                    "normalize": normalize_top_account_ratio,
                },
            ],
        },
        {
            "streamKey": "topLongShortPositionRatio",
            "path": "/api/futures/top-long-short-position-ratio/history",
            "interval": "4h",
            "supportsStartTime": True,
            "limit": fetch_limit,
            "meta": {"label": "Top Long/Short Position Ratio", "exchange": "Binance"},
            "series": [
                {
                    "seriesKey": "Binance:BTCUSDT",
                    "query": {"exchange": "Binance", "symbol": "BTCUSDT", "interval": "4h"},
                    "normalize": normalize_top_position_ratio,
                },
                {
                    "seriesKey": "Binance:ETHUSDT",
                    "query": {"exchange": "Binance", "symbol": "ETHUSDT", "interval": "4h"},
                    "normalize": normalize_top_position_ratio,
                },
            ],
        },
        {
            "streamKey": "globalLongShortAccountRatio",
            "path": "/api/futures/global-long-short-account-ratio/history",
            "interval": "4h",
            "supportsStartTime": True,
            "limit": fetch_limit,
            "meta": {"label": "Global Long/Short Account Ratio", "exchange": "Binance"},
            "series": [
                {
                    "seriesKey": "Binance:BTCUSDT",
                    "query": {"exchange": "Binance", "symbol": "BTCUSDT", "interval": "4h"},
                    "normalize": normalize_long_short_ratio,
                },
                {
                    "seriesKey": "Binance:ETHUSDT",
                    "query": {"exchange": "Binance", "symbol": "ETHUSDT", "interval": "4h"},
                    "normalize": normalize_long_short_ratio,
                },
            ],
        },
        {
            "streamKey": "aggregatedTakerBuySellVolume",
            "path": "/api/futures/aggregated-taker-buy-sell-volume/history",
            "interval": "4h",
            "supportsStartTime": True,
            "limit": fetch_limit,
            "meta": {
                "label": "Aggregated Taker Buy/Sell Volume",
                "exchanges": ["Binance", "Bybit", "Gate", "Hyperliquid"],
            },
            "series": [
                {
                    "seriesKey": "BTC",
                    "query": {"symbol": "BTC", "interval": "4h", "exchange_list": "Binance,Bybit,Gate,Hyperliquid"},
                    "normalize": normalize_aggregated_taker_volume,
                },
                {
                    "seriesKey": "ETH",
                    "query": {"symbol": "ETH", "interval": "4h", "exchange_list": "Binance,Bybit,Gate,Hyperliquid"},
                    "normalize": normalize_aggregated_taker_volume,
                },
            ],
        },
        {
            "streamKey": "aggregatedCvd",
            "path": "/api/futures/aggregated-cvd/history",
            "interval": "4h",
            "supportsStartTime": True,
            "limit": fetch_limit,
            "meta": {
                "label": "Aggregated Cumulative Volume Delta",
                "exchanges": ["Binance", "Bybit", "Gate", "Hyperliquid"],
            },
            "series": [
                {
                    "seriesKey": "BTC",
                    "query": {"symbol": "BTC", "interval": "4h", "exchange_list": "Binance,Bybit,Gate,Hyperliquid"},
                    "normalize": normalize_aggregated_cvd,
                },
                {
                    "seriesKey": "ETH",
                    "query": {"symbol": "ETH", "interval": "4h", "exchange_list": "Binance,Bybit,Gate,Hyperliquid"},
                    "normalize": normalize_aggregated_cvd,
                },
            ],
        },
        {
            "streamKey": "futuresBasis",
            "path": "/api/futures/basis/history",
            "interval": "4h",
            "supportsStartTime": True,
            "limit": fetch_limit,
            "meta": {"label": "Futures Basis", "exchange": "Binance"},
            "series": [
                {
                    "seriesKey": "Binance:BTCUSDT",
                    "query": {"exchange": "Binance", "symbol": "BTCUSDT", "interval": "4h"},
                    "normalize": normalize_futures_basis,
                },
                {
                    "seriesKey": "Binance:ETHUSDT",
                    "query": {"exchange": "Binance", "symbol": "ETHUSDT", "interval": "4h"},
                    "normalize": normalize_futures_basis,
                },
            ],
        },
        {
            "streamKey": "etfFlowHistory",
            "path": "/api/etf/bitcoin/flow-history",
            "interval": "1d",
            "supportsStartTime": False,
            "limit": fetch_limit,
            "meta": {"label": "ETF Flow History"},
            "series": [
                {
                    "seriesKey": "bitcoin",
                    "query": {},
                    "pathOverride": "/api/etf/bitcoin/flow-history",
                    "normalize": normalize_etf_flow,
                },
                {
                    "seriesKey": "ethereum",
                    "query": {},
                    "pathOverride": "/api/etf/ethereum/flow-history",
                    "normalize": normalize_etf_flow,
                },
            ],
        },
        {
            "streamKey": "bitcoinEtfNetAssets",
            "path": "/api/etf/bitcoin/net-assets/history",
            "interval": "1d",
            "supportsStartTime": False,
            "limit": fetch_limit,
            "meta": {"label": "Bitcoin ETF Net Assets"},
            "series": [
                {
                    "seriesKey": "bitcoin",
                    "query": {},
                    "normalize": normalize_bitcoin_etf_net_assets,
                }
            ],
        },
        {
            "streamKey": "hyperliquidWhaleAlert",
            "path": "/api/hyperliquid/whale-alert",
            "interval": "1m",
            "supportsStartTime": False,
            "replaceSeries": True,
            "limit": None,
            "meta": {
                "label": "Hyperliquid Whale Alert",
                "exchange": "Hyperliquid",
                "description": "最新巨鯨開倉/平倉警報（名義價值超過 100 萬美元）。",
            },
            "series": [
                {
                    "seriesKey": "latest",
                    "query": {},
                    "normalize": normalize_hyperliquid_whale_alert,
                    "maxItems": 200,
                }
            ],
        },
        {
            "streamKey": "hyperliquidWhalePosition",
            "path": "/api/hyperliquid/whale-position",
            "interval": "1m",
            "supportsStartTime": False,
            "replaceSeries": True,
            "limit": None,
            "meta": {
                "label": "Hyperliquid Whale Position",
                "exchange": "Hyperliquid",
                "description": "當前名義價值超過 100 萬美元的大戶倉位列表。",
            },
            "series": [
                {
                    "seriesKey": "latest",
                    "query": {},
                    "normalize": normalize_hyperliquid_whale_position,
                    "maxItems": 200,
                }
            ],
        },
        {
            "streamKey": "hyperliquidWalletPositionDistribution",
            "path": "/api/hyperliquid/wallet/position-distribution",
            "interval": "1m",
            "supportsStartTime": False,
            "replaceSeries": True,
            "limit": None,
            "meta": {
                "label": "Hyperliquid Wallet Position Distribution",
                "exchange": "Hyperliquid",
                "description": "依倉位層級統計地址數、多空偏向與盈虧分布。",
            },
            "series": [
                {
                    "seriesKey": "latest",
                    "query": {},
                    "normalize": normalize_hyperliquid_wallet_position_distribution,
                    "maxItems": 16,
                }
            ],
        },
    ]


def sync_once(*, dry_run: bool, series_limit: int, fetch_limit: int) -> dict[str, Any]:
    load_env()

    coinglass_api_key = required_env("COINGLASS_API_KEY")
    upstash_base_url = required_env("UPSTASH_REDIS_REST_URL")
    upstash_write_token = required_env("UPSTASH_REDIS_REST_TOKEN_WRITE")
    upstash_read_token = os.getenv("UPSTASH_REDIS_REST_TOKEN_READ", "").strip() or upstash_write_token
    coinglass_base_url = os.getenv("COINGLASS_API_BASE", DEFAULT_COINGLASS_BASE).strip() or DEFAULT_COINGLASS_BASE
    upstash_key = os.getenv("DATABASE_SIDE_UPSTASH_KEY", DEFAULT_UPSTASH_KEY).strip() or DEFAULT_UPSTASH_KEY
    upstash_last_updated_key = os.getenv("DATABASE_SIDE_UPSTASH_LAST_UPDATED_KEY", DEFAULT_LAST_UPDATED_KEY).strip() or DEFAULT_LAST_UPDATED_KEY

    existing_store = upstash_get_json(upstash_base_url, upstash_read_token, upstash_key)
    store = build_store(existing_store)

    summary = {
        "dryRun": dry_run,
        "targetKey": upstash_key,
        "totalNewPoints": 0,
        "streamSummary": [],
    }

    for config in endpoint_configs(fetch_limit):
        stream_key = config["streamKey"]
        store["streams"].setdefault(stream_key, {
            "kind": config.get("kind", "history"),
            "interval": config["interval"],
            "meta": config["meta"],
            "series": {},
        })
        store["snapshots"].setdefault(stream_key, {})
        store["syncState"].setdefault(stream_key, {})

        for series in config["series"]:
            series_key = series["seriesKey"]
            existing_items = store["streams"][stream_key]["series"].get(series_key, [])
            if not isinstance(existing_items, list):
                existing_items = []

            last_timestamp = get_record_timestamp(existing_items[-1]) if existing_items else 0
            existing_identities = {get_record_identity(item) for item in existing_items}
            query = dict(series.get("query", {}))
            if config.get("limit"):
                query["limit"] = config["limit"]

            if config.get("supportsStartTime") and last_timestamp:
                interval_ms = INTERVAL_MS_MAP.get(config["interval"], 0)
                if interval_ms:
                    query["start_time"] = max(0, last_timestamp - interval_ms)

            raw_data = coinglass_get(
                coinglass_base_url,
                coinglass_api_key,
                series.get("pathOverride") or config["path"],
                query,
            )
            normalized_items = [series["normalize"](item) for item in raw_data]
            normalized_items = [item for item in normalized_items if get_record_timestamp(item) > 0]
            max_items = int(series.get("maxItems") or config.get("maxItems") or series_limit)

            if config.get("replaceSeries"):
                deduped: dict[str, dict[str, Any]] = {}
                for item in normalized_items:
                    deduped[get_record_identity(item)] = item
                merged_items = sorted(deduped.values(), key=get_record_timestamp)
                if len(merged_items) > max_items:
                    merged_items = merged_items[-max_items:]
                incremental_added = sum(1 for item in merged_items if get_record_identity(item) not in existing_identities)
                latest_item = merged_items[-1] if merged_items else None
            else:
                incremental_added = sum(1 for item in normalized_items if get_record_timestamp(item) > last_timestamp)
                merged_items, latest_item = merge_series(existing_items, normalized_items, max_items)

            store["streams"][stream_key]["series"][series_key] = merged_items
            store["snapshots"][stream_key][series_key] = latest_item
            store["syncState"][stream_key][series_key] = {
                "lastTimestamp": get_record_timestamp(latest_item) if latest_item else 0,
                "lastSyncedAt": now_iso(),
                "records": len(merged_items),
            }

            summary["streamSummary"].append({
                "stream": stream_key,
                "series": series_key,
                "added": incremental_added,
                "total": len(merged_items),
                "latestTimestamp": get_record_timestamp(latest_item) if latest_item else 0,
            })
            summary["totalNewPoints"] += incremental_added

    store["updatedAt"] = now_iso()
    store["meta"]["totalSeries"] = len(summary["streamSummary"])
    store["meta"]["totalNewPoints"] = summary["totalNewPoints"]
    store["meta"]["lastMode"] = "dry-run" if dry_run else "write"

    if not dry_run:
        upstash_set_json(upstash_base_url, upstash_write_token, upstash_key, store)
        upstash_set_json(
            upstash_base_url,
            upstash_write_token,
            upstash_last_updated_key,
            {
                "updatedAt": store["updatedAt"],
                "totalNewPoints": summary["totalNewPoints"],
                "streamCount": len(summary["streamSummary"]),
            },
        )

    return summary


def run_loop(every_minutes: int, *, dry_run: bool, series_limit: int, fetch_limit: int) -> None:
    while True:
        started_at = now_iso()
        try:
            summary = sync_once(dry_run=dry_run, series_limit=series_limit, fetch_limit=fetch_limit)
            print(json.dumps({"startedAt": started_at, **summary}, ensure_ascii=False, indent=2))
        except Exception as exc:
            print(f"[{started_at}] 同步失敗：{exc}", file=sys.stderr)
        time.sleep(max(1, every_minutes) * 60)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="定時把 Coinglass 結構化資料遞增同步到 Upstash")
    parser.add_argument("--dry-run", action="store_true", help="只抓資料並輸出摘要，不寫入 Upstash")
    parser.add_argument("--loop", action="store_true", help="持續迴圈執行，適合常駐程序")
    parser.add_argument("--every-minutes", type=int, default=env_int("DATABASE_SIDE_LOOP_MINUTES", DEFAULT_LOOP_MINUTES), help="loop 模式的執行間隔（分鐘）")
    parser.add_argument("--series-limit", type=int, default=env_int("DATABASE_SIDE_SERIES_LIMIT", DEFAULT_SERIES_LIMIT), help="每個 series 在 Upstash 內最多保留幾筆")
    parser.add_argument("--fetch-limit", type=int, default=env_int("DATABASE_SIDE_FETCH_LIMIT", DEFAULT_FETCH_LIMIT), help="每個 Coinglass 端點每次最多抓幾筆")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.loop:
        run_loop(args.every_minutes, dry_run=args.dry_run, series_limit=args.series_limit, fetch_limit=args.fetch_limit)
        return 0

    summary = sync_once(dry_run=args.dry_run, series_limit=args.series_limit, fetch_limit=args.fetch_limit)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
