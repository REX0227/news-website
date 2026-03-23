/**
 * rssCollector.mjs — Fetch and parse RSS/Atom/XML feeds (also handles ICS as raw text)
 */

const TIMEOUT_MS = 15000;
const MAX_ITEMS = 3;

/**
 * Extract text content between two XML tags (first occurrence).
 */
function extractTag(xml, tag) {
  // Try CDATA first
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : null;
}

/**
 * Extract all occurrences of a block between <tag> ... </tag>.
 */
function extractAllTags(xml, tag) {
  const results = [];
  const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[0]);
  }
  return results;
}

/**
 * Strip HTML/XML tags from a string.
 */
function stripTags(str) {
  return String(str || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Parse RSS/Atom items from XML text.
 */
function parseItems(xml) {
  const items = [];

  // RSS 2.0 style: <item>
  const rssItems = extractAllTags(xml, 'item');
  for (const block of rssItems) {
    if (items.length >= MAX_ITEMS) break;
    const title = stripTags(extractTag(block, 'title') || '');
    const link = stripTags(extractTag(block, 'link') || extractTag(block, 'guid') || '');
    const pubDate = stripTags(extractTag(block, 'pubDate') || extractTag(block, 'dc:date') || extractTag(block, 'date') || '');
    const description = stripTags(extractTag(block, 'description') || extractTag(block, 'summary') || '').slice(0, 300);
    if (title || link) {
      items.push({ title, link, pubDate, description });
    }
  }

  // Atom style: <entry> (if no RSS items found)
  if (items.length === 0) {
    const atomEntries = extractAllTags(xml, 'entry');
    for (const block of atomEntries) {
      if (items.length >= MAX_ITEMS) break;
      const title = stripTags(extractTag(block, 'title') || '');

      // Atom link is an attribute: <link href="..."/>
      let link = '';
      const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
      if (linkMatch) link = linkMatch[1];
      if (!link) link = stripTags(extractTag(block, 'link') || '');

      const pubDate = stripTags(extractTag(block, 'published') || extractTag(block, 'updated') || '');
      const description = stripTags(extractTag(block, 'summary') || extractTag(block, 'content') || '').slice(0, 300);
      if (title || link) {
        items.push({ title, link, pubDate, description });
      }
    }
  }

  return items;
}

/**
 * Fetch an RSS/Atom feed URL and return the first MAX_ITEMS items.
 * For ICS format, return raw text excerpt.
 * @param {string} url
 * @param {string} format - 'rss', 'atom', 'xml', 'ics'
 */
export async function collectRss(url, format = 'rss') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let text;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'CryptoPulse-V4/1.0 (RSS reader bot)',
        'Accept': 'application/rss+xml,application/atom+xml,application/xml,text/xml,text/calendar,*/*'
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }

  // ICS: just return a raw excerpt with event count
  if (format === 'ics') {
    const eventCount = (text.match(/BEGIN:VEVENT/g) || []).length;
    const excerpt = text.slice(0, 500);
    return {
      type: 'ics',
      event_count: eventCount,
      excerpt
    };
  }

  // XML/RSS/Atom: parse items
  const items = parseItems(text);
  if (items.length === 0) {
    // Return raw excerpt as fallback
    return {
      type: 'xml_raw',
      excerpt: text.slice(0, 500),
      items: []
    };
  }

  return {
    type: format,
    items
  };
}
