/**
 * htmlCollector.mjs — Fetch HTML pages and extract key content using cheerio
 */

import * as cheerio from 'cheerio';

const TIMEOUT_MS = 15000;
const EXCERPT_MAX = 500;
const MAX_LINKS = 5;

/**
 * Fetch an HTML page and extract title, text excerpt, and links.
 * @param {string} url
 * @returns {{ title, excerpt, links }}
 */
export async function collectHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let html;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br'
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const $ = cheerio.load(html);

  // Remove script/style/nav/footer to clean up text
  $('script, style, nav, footer, header, noscript, iframe').remove();

  // Page title
  const title = $('title').first().text().trim() || $('h1').first().text().trim() || '';

  // Text excerpt: collect paragraphs and headings
  const textParts = [];
  $('p, h2, h3, h4, li').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t.length > 20) {
      textParts.push(t);
    }
  });

  const fullText = textParts.join(' ');
  const excerpt = fullText.slice(0, EXCERPT_MAX);

  // Collect visible links (with text and href)
  const links = [];
  $('a[href]').each((_, el) => {
    if (links.length >= MAX_LINKS) return false;
    const href = $(el).attr('href') || '';
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text && href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      // Resolve relative URLs
      let resolvedHref = href;
      if (href.startsWith('/')) {
        try {
          const base = new URL(url);
          resolvedHref = `${base.protocol}//${base.host}${href}`;
        } catch {
          resolvedHref = href;
        }
      }
      links.push({ text: text.slice(0, 100), href: resolvedHref });
    }
  });

  return { title, excerpt, links };
}
