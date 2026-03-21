import dayjs from "dayjs";

const COINALYZE_BASE_URL = "https://api.coinalyze.net/v1";
const DEFAULT_SYMBOLS = ["BTCUSDT_PERP.A", "ETHUSDT_PERP.A"];

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseSymbols(raw) {
  if (!raw) return DEFAULT_SYMBOLS;
  const symbols = String(raw)
    .split(",")
    .map((symbol) => symbol.trim())
    .filter(Boolean);
  return symbols.length ? symbols : DEFAULT_SYMBOLS;
}

async function fetchJson(url, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "crypto-macro-schedule-bot/1.0"
      }
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    return {
      ok: response.ok,
      status: response.status,
      data
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: String(error?.message || error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractPointTotalUsd(point) {
  if (!point || typeof point !== "object") return null;

  const directCandidates = [
    point.value,
    point.total,
    point.total_usd,
    point.totalUsd,
    point.v
  ];

  for (const candidate of directCandidates) {
    const number = toNumber(candidate);
    if (number !== null) return Math.abs(number);
  }

  const longCandidates = [
    point.long,
    point.longs,
    point.long_liq,
    point.longLiq,
    point.longLiquidation,
    point.l
  ];

  const shortCandidates = [
    point.short,
    point.shorts,
    point.short_liq,
    point.shortLiq,
    point.shortLiquidation,
    point.s
  ];

  const longValue = longCandidates.map(toNumber).find((value) => value !== null);
  const shortValue = shortCandidates.map(toNumber).find((value) => value !== null);

  if (longValue === null && shortValue === null) return null;
  return Math.abs(longValue || 0) + Math.abs(shortValue || 0);
}

function extractPointTimestampMs(point) {
  if (!point || typeof point !== "object") return null;
  const candidates = [point.t, point.time, point.timestamp, point.ts, point.date];

  for (const candidate of candidates) {
    const number = toNumber(candidate);
    if (number !== null) {
      if (number > 1e12) return number;
      if (number > 1e9) return number * 1000;
    }

    if (typeof candidate === "string") {
      const parsed = new Date(candidate).getTime();
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return null;
}

export async function collectCoinalyzeLiquidationMetrics() {
  const apiKey = process.env.COINALYZE_API_KEY;
  const symbols = parseSymbols(process.env.COINALYZE_LIQ_SYMBOLS);
  const now = dayjs();
  const from = now.subtract(7, "day").startOf("day").unix();
  const to = now.unix();

  if (!apiKey) {
    return {
      available: false,
      source: "coinalyze",
      reason: "missing_api_key",
      liquidationTotalUsd7d: null,
      samplesWithAmount: 0,
      symbols
    };
  }

  const endpoint = `${COINALYZE_BASE_URL}/liquidation-history?symbols=${encodeURIComponent(symbols.join(","))}&interval=daily&from=${from}&to=${to}&convert_to_usd=true&api_key=${encodeURIComponent(apiKey)}`;
  const response = await fetchJson(endpoint);

  if (!response.ok || !Array.isArray(response.data)) {
    return {
      available: false,
      source: "coinalyze",
      reason: "request_failed",
      status: response.status,
      error: response.error || (typeof response.data === "string" ? response.data : null),
      liquidationTotalUsd7d: null,
      samplesWithAmount: 0,
      symbols
    };
  }

  let liquidationTotalUsd7d = 0;
  let samplesWithAmount = 0;
  let latestPointMs = null;

  for (const series of response.data) {
    const history = Array.isArray(series?.history) ? series.history : [];
    for (const point of history) {
      const tsMs = extractPointTimestampMs(point);
      if (!Number.isFinite(tsMs)) continue;
      if (tsMs < from * 1000 || tsMs > to * 1000) continue;

      const totalUsd = extractPointTotalUsd(point);
      if (!Number.isFinite(totalUsd) || totalUsd <= 0) continue;

      liquidationTotalUsd7d += totalUsd;
      samplesWithAmount += 1;
      if (latestPointMs === null || tsMs > latestPointMs) latestPointMs = tsMs;
    }
  }

  return {
    available: samplesWithAmount > 0,
    source: "coinalyze",
    liquidationTotalUsd7d: Math.round(liquidationTotalUsd7d),
    samplesWithAmount,
    symbols,
    from: dayjs.unix(from).toISOString(),
    to: dayjs.unix(to).toISOString(),
    latestPoint: latestPointMs ? new Date(latestPointMs).toISOString() : null
  };
}
