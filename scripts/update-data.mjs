import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import dayjs from "dayjs";
import dotenv from "dotenv";
import { collectUsMacroEvents } from "../src/collectors/usMacroCollector.js";
import { collectJapanMacroEvents } from "../src/collectors/japanMacroCollector.js";
import { collectCryptoImpactSignals } from "../src/collectors/cryptoImpactCollector.js";
import { buildAiSummary } from "../src/lib/ai.js";
import { eventStatus } from "../src/lib/utils.js";
import { upstashSetJson } from "../src/lib/upstash.js";

dotenv.config();

const DATA_FILE = path.resolve("docs/data/latest.json");
const SHOULD_WRITE_LOCAL = process.argv.includes("--write-local") || process.env.WRITE_LOCAL_JSON === "true";

function buildKeyWindows(macroEvents) {
  const now = dayjs();
  return macroEvents
    .filter((event) => event.importance === "high")
    .filter((event) => dayjs(event.datetime).isAfter(now.subtract(1, "day")) && dayjs(event.datetime).isBefore(now.add(7, "day")))
    .sort((a, b) => dayjs(a.datetime).valueOf() - dayjs(b.datetime).valueOf())
    .slice(0, 8)
    .map((event) => ({
      eventId: event.id,
      title: event.title,
      datetime: event.datetime,
      country: event.country,
      why: event.impactHint
    }));
}

async function main() {
  const [usEvents, jpEvents, cryptoSignals] = await Promise.all([
    collectUsMacroEvents(),
    collectJapanMacroEvents(),
    collectCryptoImpactSignals()
  ]);

  const macroEvents = [...usEvents, ...jpEvents]
    .map((event) => ({
      ...event,
      status: eventStatus(event.datetime)
    }))
    .sort((a, b) => dayjs(a.datetime).valueOf() - dayjs(b.datetime).valueOf());

  const aiSummary = await buildAiSummary(macroEvents, cryptoSignals);

  const payload = {
    generatedAt: new Date().toISOString(),
    sources: {
      us: [
        "https://www.bls.gov/schedule/news_release/cpi.htm",
        "https://www.bls.gov/schedule/news_release/empsit.htm",
        "https://www.bls.gov/schedule/news_release/ppi.htm",
        "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
      ],
      jp: ["https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm"],
      cryptoNews: [
        "https://www.coindesk.com/arc/outboundfeeds/rss/",
        "https://cointelegraph.com/rss"
      ]
    },
    macroEvents,
    cryptoSignals,
    keyWindows: buildKeyWindows(macroEvents),
    aiSummary
  };

  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const writeToken = process.env.UPSTASH_REDIS_REST_TOKEN_WRITE;

  if (upstashUrl && writeToken) {
    await upstashSetJson({
      baseUrl: upstashUrl,
      token: writeToken,
      key: "crypto_dashboard:latest",
      value: payload
    });

    await upstashSetJson({
      baseUrl: upstashUrl,
      token: writeToken,
      key: "crypto_dashboard:last_updated",
      value: { at: payload.generatedAt }
    });
  }

  if (SHOULD_WRITE_LOCAL || true) {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(payload, null, 2), "utf8");
  }

  console.log(`Updated payload with ${payload.macroEvents.length} macro events and ${payload.cryptoSignals.length} crypto signals.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
