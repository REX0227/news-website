/**
 * csvCollector.mjs — Fetch and parse CSV data (primarily FRED CSV sources)
 */

const TIMEOUT_MS = 15000;

/**
 * Fetch a CSV URL and return the latest and previous data rows.
 * @param {string} url
 * @returns {{ latest_date, latest_value, previous_date, previous_value, change, change_pct }}
 */
export async function collectCsv(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let text;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'CryptoPulse-V4/1.0 (data collection bot)',
        'Accept': 'text/csv,text/plain,*/*'
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }

  // Split into lines and filter empty
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    throw new Error('CSV has fewer than 2 lines');
  }

  // Header is first line; data rows follow
  // Skip header row, then find last non-empty data rows
  const dataLines = lines.slice(1).filter(l => {
    const cols = l.split(',');
    // Must have at least 2 columns, and value must not be '.' (FRED uses '.' for missing)
    return cols.length >= 2 && cols[1].trim() !== '.' && cols[1].trim() !== '';
  });

  if (dataLines.length === 0) {
    throw new Error('No valid data rows found in CSV');
  }

  const parseRow = (line) => {
    const cols = line.split(',');
    const date = cols[0].trim();
    const value = parseFloat(cols[1].trim());
    return { date, value: isNaN(value) ? null : value };
  };

  const latest = parseRow(dataLines[dataLines.length - 1]);
  const previous = dataLines.length >= 2 ? parseRow(dataLines[dataLines.length - 2]) : null;

  let change = null;
  let change_pct = null;
  if (latest.value != null && previous?.value != null) {
    change = parseFloat((latest.value - previous.value).toFixed(4));
    change_pct = previous.value !== 0
      ? parseFloat(((change / previous.value) * 100).toFixed(4))
      : null;
  }

  return {
    latest_date: latest.date,
    latest_value: latest.value,
    previous_date: previous?.date ?? null,
    previous_value: previous?.value ?? null,
    change,
    change_pct
  };
}
