import dayjs from "dayjs";

function toNumber(value) {
  const num = Number(String(value ?? "").trim());
  return Number.isFinite(num) ? num : null;
}

function parseCsvLine(line) {
  // Treasury CSV is simple comma-separated without escaped commas in fields.
  // Keep it minimal to avoid extra deps.
  return line.split(",").map((cell) => cell.trim());
}

async function fetchText(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "crypto-macro-schedule-bot/1.0" }
    });
    if (!res.ok) return { ok: false, status: res.status, text: "" };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

export async function collectRatesIntel() {
  const url = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/Datasets/yield.csv";
  const res = await fetchText(url);

  if (!res.ok || !res.text) {
    return {
      updatedAt: new Date().toISOString(),
      sources: { usTreasuryYieldCsv: false },
      latest: null
    };
  }

  const lines = res.text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 3) {
    return {
      updatedAt: new Date().toISOString(),
      sources: { usTreasuryYieldCsv: false },
      latest: null
    };
  }

  const header = parseCsvLine(lines[0]);
  const idx = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const iDate = idx("Date");
  const i3m = idx("3 Mo");
  const i2y = idx("2 Yr");
  const i10y = idx("10 Yr");

  if (iDate < 0 || i3m < 0 || i2y < 0 || i10y < 0) {
    return {
      updatedAt: new Date().toISOString(),
      sources: { usTreasuryYieldCsv: false },
      latest: null
    };
  }

  let row = null;
  for (let i = lines.length - 1; i >= 1; i -= 1) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length <= Math.max(iDate, i3m, i2y, i10y)) continue;
    if (!cols[iDate]) continue;
    row = cols;
    break;
  }

  if (!row) {
    return {
      updatedAt: new Date().toISOString(),
      sources: { usTreasuryYieldCsv: false },
      latest: null
    };
  }

  const date = dayjs(row[iDate]).isValid() ? dayjs(row[iDate]).format("YYYY-MM-DD") : null;
  const y3m = toNumber(row[i3m]);
  const y2y = toNumber(row[i2y]);
  const y10y = toNumber(row[i10y]);

  const spread10y2y = (y10y !== null && y2y !== null) ? Number((y10y - y2y).toFixed(3)) : null;
  const spread10y3m = (y10y !== null && y3m !== null) ? Number((y10y - y3m).toFixed(3)) : null;

  return {
    updatedAt: new Date().toISOString(),
    sources: { usTreasuryYieldCsv: true },
    latest: {
      date,
      y3m,
      y2y,
      y10y,
      spread10y2y,
      spread10y3m
    }
  };
}
