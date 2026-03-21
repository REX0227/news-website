import process from "node:process";
import { spawnSync } from "node:child_process";

// Deprecated: 舊版入口已停用。
// 正式的 V1 更新流程在 `v1/scripts/update-data.mjs`，且只寫 Upstash（不輸出/不部署本地 JSON）。
const result = spawnSync(process.execPath, ["v1/scripts/update-data.mjs", ...process.argv.slice(2)], {
  stdio: "inherit"
});

process.exit(result.status ?? 1);
