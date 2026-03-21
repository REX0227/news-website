import process from "node:process";

// Deprecated / disabled.
// V1 不允許任何「手動回寫/覆寫評估」流程；更新一律由 `v1/scripts/update-data.mjs` 自動重算並覆蓋。
console.error("此腳本已停用：不支援手動回寫/覆寫評估。請改用 `node v1/scripts/update-data.mjs`。\n");
process.exit(1);
