import dayjs from "dayjs";

const BINANCE_FORCE_ORDERS_URL = "https://fapi.binance.com/fapi/v1/allForceOrders?symbol=BTCUSDT&limit=5";
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "cryptopulse-bot/1.0"
      }
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, body, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "cryptopulse-bot/1.0"
      },
      body: JSON.stringify(body || {})
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function collectMajorNoKeyLiquidationMetrics() {
  const [binanceProbe, hyperliquidProbe] = await Promise.all([
    fetchJson(BINANCE_FORCE_ORDERS_URL),
    postJson(HYPERLIQUID_INFO_URL, { type: "meta" })
  ]);

  return {
    available: false,
    source: "major_exchanges_no_key_probe",
    mode: "no_api_key",
    liquidationTotalUsdRecent: null,
    liquidationCountRecent: 0,
    asOf: dayjs().toISOString(),
    oldestPoint: null,
    latestPoint: null,
    windowHours: 0,
    reason: "no_stable_no_key_liquidation_total_from_major_exchanges",
    exchangeBreakdown: [
      {
        exchange: "binance",
        market: "BTCUSDT",
        available: false,
        status: binanceProbe.status,
        eventCount: 0,
        liquidationTotalUsd: null,
        oldest: null,
        newest: null,
        error: binanceProbe.error || (typeof binanceProbe.data === "string" ? binanceProbe.data : "endpoint_unavailable_or_maintenance"),
        note: "Binance 公開 allForceOrders 端點目前不可穩定用於 no-key 7D 清算彙總。"
      },
      {
        exchange: "hyperliquid",
        market: "all",
        available: false,
        status: hyperliquidProbe.status,
        eventCount: 0,
        liquidationTotalUsd: null,
        oldest: null,
        newest: null,
        error: hyperliquidProbe.error || null,
        note: "Hyperliquid 公開 info 端點可用，但目前無可直接彙總 7D 清算額的 no-key 歷史端點。"
      }
    ]
  };
}
