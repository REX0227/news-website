function toNumber(value) {
  const num = Number(String(value ?? "").trim());
  return Number.isFinite(num) ? num : null;
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
  const nowIso = new Date().toISOString();

  // Public CSV download endpoints (no API key required)
  const urls = {
    y10y: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10",
    y2y: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2",
    y3m: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO"
  };

  const [res10, res2, res3m] = await Promise.all([
    fetchText(urls.y10y),
    fetchText(urls.y2y),
    fetchText(urls.y3m)
  ]);

  const parseFredLatest = (csvText) => {
    const lines = String(csvText || "")
      .split(/\r?\n/g)
      .map((l) => l.trim())
      .filter(Boolean);
    // header: DATE,VALUE
    for (let i = lines.length - 1; i >= 1; i -= 1) {
      const parts = lines[i].split(",");
      if (parts.length < 2) continue;
      const date = parts[0];
      const value = parts[1];
      if (!date || !value || value === ".") continue;
      const num = toNumber(value);
      if (num === null) continue;
      return { date, value: num };
    }
    return null;
  };

  const latest10 = res10.ok ? parseFredLatest(res10.text) : null;
  const latest2 = res2.ok ? parseFredLatest(res2.text) : null;
  const latest3m = res3m.ok ? parseFredLatest(res3m.text) : null;

  const date = latest10?.date || latest2?.date || latest3m?.date || null;
  const y10y = latest10?.value ?? null;
  const y2y = latest2?.value ?? null;
  const y3m = latest3m?.value ?? null;

  const spread10y2y = (y10y !== null && y2y !== null) ? Number((y10y - y2y).toFixed(3)) : null;
  const spread10y3m = (y10y !== null && y3m !== null) ? Number((y10y - y3m).toFixed(3)) : null;

  const okAny = Boolean(latest10 || latest2 || latest3m);
  return {
    updatedAt: nowIso,
    sources: {
      fredDgs10: Boolean(latest10),
      fredDgs2: Boolean(latest2),
      fredDgs3mo: Boolean(latest3m)
    },
    latest: okAny
      ? {
          date,
          y3m,
          y2y,
          y10y,
          spread10y2y,
          spread10y3m
        }
      : null
  };
}
