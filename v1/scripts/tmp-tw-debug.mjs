// 臨時診斷腳本：確認 Upstash taiwan_dashboard:latest 的儲存格式
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../.env") });
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {}

const URL  = process.env.UPSTASH_REDIS_REST_URL;
const READ = process.env.UPSTASH_REDIS_REST_TOKEN_READ || process.env.UPSTASH_REDIS_REST_TOKEN_WRITE;

console.log("URL ok:", !!URL, URL?.slice(0, 40));

const res  = await fetch(`${URL}/get/taiwan_dashboard:latest`, {
  headers: { Authorization: `Bearer ${READ}` }
});
const json = await res.json();

console.log("HTTP status:", res.status);
console.log("result type:", typeof json.result);
console.log("result is null:", json.result === null);

if (json.result) {
  const raw = json.result;
  console.log("raw preview (first 400):", String(raw).slice(0, 400));

  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    console.log("\n--- parsed keys:", Object.keys(parsed));
    console.log("generatedAt:", parsed.generatedAt);
    console.log("composite.score:", parsed.composite?.score);
    console.log("institutional.available:", parsed.institutional?.available);
    console.log("taiex.available:", parsed.taiex?.available);
  } catch (e) {
    console.log("parse error:", e.message);
    try {
      const inner = JSON.parse(JSON.parse(raw));
      console.log("double-parse succeeded, keys:", Object.keys(inner));
    } catch {}
  }
}
