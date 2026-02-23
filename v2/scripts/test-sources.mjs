import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SOURCES_FILE = path.join(PROJECT_ROOT, "data", "sources.json");

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const out = { reportPath: null };

  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i] ?? "");
    if (a === "--report" || a === "--write-report") {
      const next = args[i + 1];
      if (next && !String(next).startsWith("--")) {
        out.reportPath = String(next);
        i += 1;
      } else {
        out.reportPath = path.join(PROJECT_ROOT, "data", "fetch-report.json");
      }
    }
  }

  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function interpolateEnv(template) {
  return String(template || "").replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => process.env[key] || "${" + key + "}");
}

function getByPath(obj, dottedPath) {
  const parts = String(dottedPath || "").split(".").filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    const idx = Number(part);
    if (Number.isInteger(idx) && String(idx) === part) {
      cur = cur?.[idx];
    } else {
      cur = cur?.[part];
    }
  }
  return cur;
}

function hasUnresolvedTemplate(url) {
  return /\$\{[A-Z0-9_]+\}/.test(String(url || ""));
}

function makeHeaders(source) {
  const headers = {
    "User-Agent": "CryptoPulse-v2-test/1.0",
    "Accept": "*/*"
  };

  if (source?.auth?.type === "bearer") {
    const envKey = String(source?.auth?.env || "");
    const token = envKey ? process.env[envKey] : "";
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function failOrSkip(source, reason) {
  return { status: source?.required ? "FAIL" : "SKIP", reason };
}

function shouldSkipBecauseRequiresApi(source, url) {
  if (!source?.requiresApi) return { skip: false };

  // 若標記為 requiresApi，但沒有提供任何可用的認證資訊，預設不打這個端點。
  // 這能避免「列入清單但尚未開通 API」導致大量噪音。
  const authType = String(source?.auth?.type || "").toLowerCase();
  if (!authType) return { skip: true, reason: "requiresApi: missing auth config" };

  if (authType === "bearer") {
    const envKey = String(source?.auth?.env || "");
    const token = envKey ? process.env[envKey] : "";
    if (!token) return { skip: true, reason: `requiresApi: missing env token (${envKey || "env not set"})` };
    return { skip: false };
  }

  // 預留：未來可能支援 query/header apiKey 等
  return { skip: true, reason: `requiresApi: unsupported auth type (${authType})` };
}

async function fetchWithTimeout(url, { timeoutMs = 20000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function okTextIncludes(text, includes = []) {
  const lower = String(text || "").toLowerCase();
  return includes.every((needle) => lower.includes(String(needle).toLowerCase()));
}

function validateSyndication(text) {
  const lower = String(text || "").toLowerCase();
  const hasRoot = lower.includes("<rss") || lower.includes("<feed");
  const hasItems = lower.includes("<item") || lower.includes("<entry");
  return hasRoot && hasItems;
}

function validateCsv(csvText) {
  const text = String(csvText || "");
  const lines = text.split(/\r?\n/g).map((l) => l.trim()).filter(Boolean);

  if (lines.length < 3) return { ok: false, reason: "too few lines" };

  const header = lines[0];
  if (!/^(date|observation_date)\s*,/i.test(header)) return { ok: false, reason: "missing date header" };
  if (header.split(",").length < 2) return { ok: false, reason: "csv header has <2 columns" };

  for (let i = lines.length - 1; i >= 1; i -= 1) {
    const [date, value] = lines[i].split(",");
    if (!date || !value || value === ".") continue;
    const n = Number(value);
    if (Number.isFinite(n)) return { ok: true };
  }

  return { ok: false, reason: "no numeric data rows" };
}

function validateJson(obj, expect) {
  const jsonPaths = Array.isArray(expect?.jsonPaths) ? expect.jsonPaths : [];
  for (const p of jsonPaths) {
    const v = getByPath(obj, p);
    if (v === undefined || v === null || v === "") {
      return { ok: false, reason: `missing json path: ${p}` };
    }
  }

  const arrayMinLength = Number(expect?.arrayMinLength);
  if (Number.isFinite(arrayMinLength) && arrayMinLength > 0) {
    if (!Array.isArray(obj)) return { ok: false, reason: `expected JSON array (min ${arrayMinLength})` };
    if (obj.length < arrayMinLength) return { ok: false, reason: `array too short: ${obj.length} < ${arrayMinLength}` };
  }

  return { ok: true };
}

async function validateOne(source) {
  const rawUrl = source.url || source.urlTemplate;
  const url = interpolateEnv(rawUrl);

  if (!url) return failOrSkip(source, "missing url");

  const apiSkip = shouldSkipBecauseRequiresApi(source, url);
  if (apiSkip.skip) return { status: "SKIP", reason: apiSkip.reason };

  if (hasUnresolvedTemplate(url)) {
    return failOrSkip(source, `unresolved template: ${url}`);
  }

  const headers = makeHeaders(source);

  let res;
  try {
    res = await fetchWithTimeout(url, { headers });
  } catch (e) {
    return failOrSkip(source, `fetch error: ${String(e?.message || e)}`);
  }

  if (!res.ok) {
    const retryAfter = res.headers.get("retry-after");
    const extra = retryAfter ? `; retry-after=${retryAfter}` : "";
    return failOrSkip(source, `http ${res.status}${extra}`);
  }

  const format = String(source.format || "").toLowerCase();
  const expect = source.expect || {};

  if (format === "xlsx") {
    const buf = Buffer.from(await res.arrayBuffer());
    const magic = buf.slice(0, 2).toString("utf8");
    if (String(expect.binaryMagic || "").toUpperCase() === "PK" && magic !== "PK") {
      return failOrSkip(source, "xlsx magic not PK");
    }
    return { status: "PASS" };
  }

  if (format === "json") {
    let obj;
    try {
      obj = await res.json();
    } catch (e) {
      return failOrSkip(source, `json parse error: ${String(e?.message || e)}`);
    }

    const v = validateJson(obj, expect);
    return v.ok ? { status: "PASS" } : failOrSkip(source, v.reason);
  }

  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();
  const snippet = String(text).replace(/\s+/g, " ").slice(0, 140);

  if (format === "csv") {
    const v = validateCsv(text);
    return v.ok ? { status: "PASS" } : failOrSkip(source, `${v.reason} (ct=${contentType}; sample=${snippet})`);
  }

  if (format === "ics") {
    const includes = Array.isArray(expect.textIncludes) ? expect.textIncludes : ["BEGIN:VCALENDAR"];
    return okTextIncludes(text, includes)
      ? { status: "PASS" }
      : failOrSkip(source, `ics content check failed (ct=${contentType}; sample=${snippet})`);
  }

  if (format === "rss") {
    if (Array.isArray(expect.textIncludes) && expect.textIncludes.length) {
      return okTextIncludes(text, expect.textIncludes)
        ? { status: "PASS" }
        : failOrSkip(source, `rss content check failed (ct=${contentType}; sample=${snippet})`);
    }
    return validateSyndication(text)
      ? { status: "PASS" }
      : failOrSkip(source, `rss content check failed (ct=${contentType}; sample=${snippet})`);
  }

  if (format === "xml") {
    if (Array.isArray(expect.textIncludes) && expect.textIncludes.length) {
      return okTextIncludes(text, expect.textIncludes)
        ? { status: "PASS" }
        : failOrSkip(source, `xml content check failed (ct=${contentType}; sample=${snippet})`);
    }
    return validateSyndication(text)
      ? { status: "PASS" }
      : failOrSkip(source, `xml content check failed (ct=${contentType}; sample=${snippet})`);
  }

  if (format === "html") {
    const includes = Array.isArray(expect.textIncludes) ? expect.textIncludes : ["<html"];
    return okTextIncludes(text, includes)
      ? { status: "PASS" }
      : failOrSkip(source, `html content check failed (ct=${contentType}; sample=${snippet})`);
  }

  // Unknown / default text check if provided
  if (Array.isArray(expect.textIncludes) && expect.textIncludes.length) {
    return okTextIncludes(text, expect.textIncludes)
      ? { status: "PASS" }
      : failOrSkip(source, `textIncludes check failed (ct=${contentType}; sample=${snippet})`);
  }

  return { status: "PASS" };
}

function padRight(s, n) {
  const str = String(s ?? "");
  if (str.length >= n) return str;
  return str + " ".repeat(n - str.length);
}

async function run() {
  if (typeof fetch !== "function") {
    console.error("This script requires Node.js 18+ (global fetch).");
    process.exit(2);
  }

  const { reportPath } = parseArgs(process.argv.slice(2));

  const raw = await fs.readFile(SOURCES_FILE, "utf8");
  const data = JSON.parse(raw);
  const sources = Array.isArray(data?.sources) ? data.sources : [];

  console.log(`[${nowIso()}] Testing ${sources.length} sources from ${SOURCES_FILE}`);

  const concurrency = Number(process.env.TEST_SOURCES_CONCURRENCY || 4);
  const queue = sources.map((s) => ({ ...s }));

  const results = [];

  async function worker() {
    while (queue.length) {
      const source = queue.shift();
      const url = interpolateEnv(source.url || source.urlTemplate);
      const label = source.id || source.name || url;
      const r = await validateOne(source);
      results.push({ source, url, label, ...r });

      const status = r.status;
      const req = source.required ? "REQ" : "OPT";
      const msg = `${padRight(status, 4)} ${req} ${padRight(label, 34)} ${url}`;
      if (status === "PASS") console.log(msg);
      else if (status === "SKIP") console.warn(msg + (r.reason ? `  (${r.reason})` : ""));
      else console.error(msg + (r.reason ? `  (${r.reason})` : ""));
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, 12)) }, () => worker());
  await Promise.all(workers);

  const requiredFails = results.filter((r) => r.status === "FAIL" && r.source?.required);
  const optionalFails = results.filter((r) => r.status === "FAIL" && !r.source?.required);

  console.log("\nSummary:");
  console.log(`- PASS: ${results.filter((r) => r.status === "PASS").length}`);
  console.log(`- SKIP: ${results.filter((r) => r.status === "SKIP").length}`);
  console.log(`- FAIL (required): ${requiredFails.length}`);
  console.log(`- FAIL (optional): ${optionalFails.length}`);

  if (reportPath) {
    const report = {
      schemaVersion: 1,
      generatedAt: nowIso(),
      sourcesFile: path.relative(PROJECT_ROOT, SOURCES_FILE).replace(/\\/g, "/"),
      totals: {
        total: results.length,
        pass: results.filter((r) => r.status === "PASS").length,
        skip: results.filter((r) => r.status === "SKIP").length,
        failRequired: requiredFails.length,
        failOptional: optionalFails.length
      },
      notes: [
        "本報告由 v2/scripts/test-sources.mjs 產生，供 V2 網頁顯示來源可用性。",
        "目前策略：requiresApi 缺 token → SKIP；optional 的抓取/解析失敗 → SKIP；required 才會 FAIL 並導致 exit code=1。"
      ],
      results: results.map((r) => {
        const s = r.source || {};
        return {
          id: s.id || null,
          name: s.name || null,
          category: s.category || null,
          url: r.url || null,
          format: s.format || null,
          required: Boolean(s.required),
          region: s.region || null,
          access: s.access || null,
          requiresApi: Boolean(s.requiresApi),
          stability: s.stability || null,
          tags: Array.isArray(s.tags) ? s.tags : [],
          status: r.status,
          reason: r.reason || null
        };
      })
    };

    const outPath = path.isAbsolute(reportPath) ? reportPath : path.resolve(process.cwd(), reportPath);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`\nReport written: ${outPath}`);
  }

  if (requiredFails.length) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
