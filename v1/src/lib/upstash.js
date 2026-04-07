export async function upstashSetJson({ baseUrl, token, key, value }) {
  const url = `${baseUrl}/set/${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(value)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upstash set failed (${response.status}): ${text}`);
  }

  return response.json();
}

// ── Redis List helpers（用於 composite_score 歷史走勢）──────────────
// LPUSH + LTRIM：最新資料在 list 頭部，保留最近 N 筆
export async function upstashListPrepend({ baseUrl, token, key, value }) {
  const encoded = encodeURIComponent(key);
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const url = `${baseUrl}/lpush/${encoded}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upstash lpush failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function upstashListTrim({ baseUrl, token, key, keepLast }) {
  const encoded = encodeURIComponent(key);
  // LTRIM 0 (keepLast-1) 保留最新的 keepLast 筆
  const url = `${baseUrl}/ltrim/${encoded}/0/${keepLast - 1}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upstash ltrim failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function upstashListRange({ baseUrl, token, key, start = 0, stop = -1 }) {
  const encoded = encodeURIComponent(key);
  const url = `${baseUrl}/lrange/${encoded}/${start}/${stop}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upstash lrange failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  if (!Array.isArray(data?.result)) return [];
  return data.result.map(item => {
    try { return JSON.parse(item); } catch { return item; }
  });
}

export async function upstashGetJson({ baseUrl, token, key }) {
  const url = `${baseUrl}/get/${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upstash get failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  if (typeof data?.result !== "string") return data?.result ?? null;

  try {
    return JSON.parse(data.result);
  } catch {
    return data.result;
  }
}
