import { load } from "cheerio";
import dayjs from "dayjs";
import { cleanText } from "./utils.js";

export async function fetchRssItems(url, limit = 20) {
  const response = await fetch(url, { headers: { "User-Agent": "crypto-macro-schedule-bot/1.0" } });
  if (!response.ok) {
    throw new Error(`RSS fetch failed (${response.status}): ${url}`);
  }

  const xml = await response.text();
  const $ = load(xml, { xmlMode: true });
  const items = [];

  $("item").each((_, node) => {
    if (items.length >= limit) return;
    const element = $(node);
    const title = cleanText(element.find("title").first().text());
    const link = cleanText(element.find("link").first().text());
    const description = cleanText(element.find("description").first().text());
    const pubDateRaw = cleanText(element.find("pubDate").first().text());
    const pubDate = dayjs(pubDateRaw).isValid() ? dayjs(pubDateRaw).toISOString() : null;

    if (title && link) {
      items.push({ title, link, description, pubDate });
    }
  });

  return items;
}
