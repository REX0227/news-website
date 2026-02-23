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
