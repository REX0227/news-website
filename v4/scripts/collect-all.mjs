/**
 * collect-all.mjs — Main orchestrator for CryptoPulse V4 data collection
 *
 * Reads PASS sources from v2/data/sources.json + fetch-report.json,
 * runs appropriate collectors concurrently (max 5 at a time),
 * saves results to SQLite, and exports latest.json for the frontend.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';

// Load dotenv from project root
import dotenv from 'dotenv';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(projectRoot, '.env') });

import { initDb, saveSnapshot, getLatestSnapshots, logCollection } from '../database.mjs';
import { collectCsv } from '../src/collectors/csvCollector.mjs';
import { collectRss } from '../src/collectors/rssCollector.mjs';
import { collectJson } from '../src/collectors/jsonCollector.mjs';
import { collectHtml } from '../src/collectors/htmlCollector.mjs';

const CONCURRENCY = 5;
const V2_DATA_DIR = path.resolve(__dirname, '../../v2/data');
const DOCS_DATA_DIR = path.resolve(__dirname, '../docs/data');

/**
 * Detect collector type from source format field.
 */
function getCollectorType(format) {
  switch ((format || '').toLowerCase()) {
    case 'csv':
      return 'csv';
    case 'json':
      return 'json';
    case 'rss':
    case 'atom':
      return 'rss';
    case 'xml':
      return 'rss'; // treat as feed/xml
    case 'ics':
      return 'ics';
    case 'html':
      return 'html';
    case 'xlsx':
      return 'skip';
    default:
      return 'skip';
  }
}

/**
 * Run the appropriate collector for a source.
 */
async function runCollector(source) {
  const collectorType = getCollectorType(source.format);

  if (collectorType === 'skip') {
    return { status: 'skip', data: null, error: null };
  }

  const url = source.url || source.urlTemplate;
  if (!url || url.includes('${')) {
    return { status: 'skip', data: null, error: 'URL requires template substitution' };
  }

  try {
    let data;
    switch (collectorType) {
      case 'csv':
        data = await collectCsv(url);
        break;
      case 'rss':
        data = await collectRss(url, source.format);
        break;
      case 'ics':
        data = await collectRss(url, 'ics');
        break;
      case 'json':
        data = await collectJson(url);
        break;
      case 'html':
        data = await collectHtml(url);
        break;
      default:
        return { status: 'skip', data: null, error: `Unknown collector type: ${collectorType}` };
    }
    return { status: 'ok', data, error: null };
  } catch (err) {
    return { status: 'error', data: null, error: err.message };
  }
}

/**
 * Run tasks with limited concurrency.
 */
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log('[collect-all] Starting CryptoPulse V4 data collection...');
  const startTime = Date.now();

  // Initialize database
  initDb();

  // Load sources
  const sourcesPath = path.join(V2_DATA_DIR, 'sources.json');
  const reportPath = path.join(V2_DATA_DIR, 'fetch-report.json');

  const sourcesRaw = JSON.parse(await readFile(sourcesPath, 'utf-8'));
  const reportRaw = JSON.parse(await readFile(reportPath, 'utf-8'));

  // Build a map of source_id -> status from fetch-report
  const reportMap = {};
  for (const result of reportRaw.results || []) {
    reportMap[result.id] = result.status;
  }

  // Filter sources to only PASS status
  const allSources = sourcesRaw.sources || [];
  const passSources = allSources.filter(src => {
    const reportStatus = reportMap[src.id];
    // A source is PASS if it appears as PASS in the report
    return reportStatus === 'PASS';
  });

  console.log(`[collect-all] Found ${passSources.length} PASS sources out of ${allSources.length} total`);

  // Build tasks
  const tasks = passSources.map(source => async () => {
    const collectorType = getCollectorType(source.format);
    console.log(`[collect] ${source.id} (${source.format} -> ${collectorType})`);

    const { status, data, error } = await runCollector(source);

    if (status === 'error') {
      console.warn(`[collect] ERROR ${source.id}: ${error}`);
    } else if (status === 'skip') {
      console.log(`[collect] SKIP ${source.id}: ${error || 'xlsx or unsupported'}`);
    } else {
      console.log(`[collect] OK   ${source.id}`);
    }

    saveSnapshot(source.id, source.category, source.name, status, data, error);

    return { source, status, data, error };
  });

  // Run with concurrency limit
  const results = await runWithConcurrency(tasks, CONCURRENCY);

  // Tally results
  let success = 0, failed = 0, skipped = 0;
  for (const r of results) {
    if (r.status === 'ok') success++;
    else if (r.status === 'error') failed++;
    else skipped++;
  }

  const total = results.length;
  console.log(`\n[collect-all] Done: ${total} total, ${success} OK, ${failed} ERROR, ${skipped} SKIP`);
  console.log(`[collect-all] Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // Log collection run
  logCollection(total, success, failed, skipped);

  // Export latest.json for the frontend
  const latestSnapshots = getLatestSnapshots();
  fs.mkdirSync(DOCS_DATA_DIR, { recursive: true });

  const latestJson = {
    generatedAt: new Date().toISOString(),
    totals: { total, success, failed, skipped },
    snapshots: latestSnapshots.map(row => ({
      source_id: row.source_id,
      category: row.category,
      source_name: row.source_name,
      fetched_at: row.fetched_at,
      status: row.status,
      data: row.data_json ? JSON.parse(row.data_json) : null,
      error_message: row.error_message
    }))
  };

  const outputPath = path.join(DOCS_DATA_DIR, 'latest.json');
  fs.writeFileSync(outputPath, JSON.stringify(latestJson, null, 2), 'utf-8');
  console.log(`[collect-all] Exported latest.json to ${outputPath}`);

  // Exit with error code if too many failures
  if (failed > total * 0.5 && total > 0) {
    console.error('[collect-all] WARNING: More than 50% of sources failed!');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[collect-all] Fatal error:', err);
  process.exit(1);
});
