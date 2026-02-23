import dayjs from "dayjs";
import xlsx from "xlsx";

const RATE_CUT_SOURCE_URL = "https://www.atlantafed.org/-/media/Project/Atlanta/FRBA/Documents/cenfis/market-probability-tracker/mpt_histdata.xlsx";

function parseNum(value) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

function parseReferenceDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  const rawYear = Number(match[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;

  if (!month || !day || !year) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function fmtMonthZh(date) {
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月`;
}

export async function fetchRateCutData() {
  try {
    const response = await fetch(RATE_CUT_SOURCE_URL);
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    const workbook = xlsx.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets.DATA;
    if (!sheet) return null;

    const rows = xlsx.utils.sheet_to_json(sheet, { defval: null, raw: false });
    if (!rows.length) return null;

    const allDates = [...new Set(rows.map((row) => String(row.date || "").trim()).filter(Boolean))].sort();
    if (!allDates.length) return null;

    const latestDate = allDates[allDates.length - 1];
    const latestRows = rows.filter((row) => String(row.date || "").trim() === latestDate);

    const byReference = new Map();
    for (const row of latestRows) {
      const referenceStart = String(row.reference_start || "").trim();
      if (!referenceStart) continue;

      if (!byReference.has(referenceStart)) {
        byReference.set(referenceStart, {
          referenceStart,
          referenceDate: parseReferenceDate(referenceStart),
          cutProbability: null,
          hikeProbability: null
        });
      }

      const record = byReference.get(referenceStart);
      if (row.field === "Prob: cut") record.cutProbability = parseNum(row.value);
      if (row.field === "Prob: hike") record.hikeProbability = parseNum(row.value);
    }

    const series = [...byReference.values()]
      .filter((item) => item.referenceDate)
      .sort((a, b) => a.referenceDate - b.referenceDate);

    if (!series.length) return null;

    const now = new Date();
    const next = series.find((item) => item.referenceDate >= now) || series[0];
    const firstLikelyCut = series.find((item) => (item.cutProbability ?? 0) >= 50) || null;

    return {
      mode: "concrete",
      sourceName: "Atlanta Fed Market Probability Tracker（基於 CME 3M SOFR 期權）",
      sourceUrl: RATE_CUT_SOURCE_URL,
      observationDate: dayjs(latestDate).isValid() ? dayjs(latestDate).toISOString() : latestDate,
      nextMonthLabel: next.referenceDate ? fmtMonthZh(next.referenceDate) : "待定",
      nextCutProbability: next.cutProbability,
      nextHikeProbability: next.hikeProbability,
      firstLikelyCutMonth: firstLikelyCut?.referenceDate ? fmtMonthZh(firstLikelyCut.referenceDate) : null,
      firstLikelyCutProbability: firstLikelyCut?.cutProbability ?? null,
      series: series.slice(0, 10).map((item) => ({
        monthLabel: item.referenceDate ? fmtMonthZh(item.referenceDate) : item.referenceStart,
        cutProbability: item.cutProbability,
        hikeProbability: item.hikeProbability
      }))
    };
  } catch {
    return null;
  }
}
