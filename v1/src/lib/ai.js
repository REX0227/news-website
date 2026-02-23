import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVAL_FILE = path.resolve(__dirname, "../../data/copilot-evaluation.json");

export async function buildTraderOutlookFromPayload(payload) {
  if (!fs.existsSync(EVAL_FILE)) {
    throw new Error("STOP: 請 Copilot 讀取 tmp/raw-data-for-copilot.json 並生成 v1/data/copilot-evaluation.json 後再執行。");
  }
  const evalData = JSON.parse(fs.readFileSync(EVAL_FILE, "utf-8"));
  return evalData.trendOutlook;
}

export async function buildAiSummary(macroEvents, cryptoSignals, globalRiskSignals, trendOutlook) {
  if (!fs.existsSync(EVAL_FILE)) {
    throw new Error("STOP: 請 Copilot 讀取 tmp/raw-data-for-copilot.json 並生成 v1/data/copilot-evaluation.json 後再執行。");
  }
  const evalData = JSON.parse(fs.readFileSync(EVAL_FILE, "utf-8"));
  return {
    ...evalData.aiSummary,
    aiMeta: { mode: "copilot_trader", logicVersion: "v3_copilot" }
  };
}
