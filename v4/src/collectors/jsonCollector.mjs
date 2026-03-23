/**
 * jsonCollector.mjs — Fetch and parse JSON API sources
 */

const TIMEOUT_MS = 15000;
const MAX_CHARS = 5000;

/**
 * Fetch a JSON URL and return parsed data.
 * If the result is an array, return only the first 3 items.
 * Limit response to MAX_CHARS characters.
 * @param {string} url
 */
export async function collectJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let data;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'CryptoPulse-V4/1.0 (data collection bot)',
        'Accept': 'application/json,*/*'
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    data = JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }

  // Truncate arrays to first 3 items
  let result = data;
  if (Array.isArray(data)) {
    result = data.slice(0, 3);
  }

  // Enforce character limit
  const serialized = JSON.stringify(result);
  if (serialized.length > MAX_CHARS) {
    // Return truncated string representation with a note
    return {
      _truncated: true,
      _original_type: Array.isArray(data) ? 'array' : 'object',
      _original_length: Array.isArray(data) ? data.length : null,
      preview: serialized.slice(0, MAX_CHARS)
    };
  }

  return result;
}
