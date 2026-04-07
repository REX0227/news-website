/**
 * utils.js — 純工具函式與顯示常數
 * 無 DOM 副作用，無狀態，可在任何模組 import
 */

export const fmt = new Intl.DateTimeFormat("zh-Hant", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

export const IMPORTANCE_TEXT = { high: "高", medium: "中", low: "低" };
export const STATUS_TEXT = { upcoming: "未來", recent: "近期 / 已公布" };
export const COUNTRY_TEXT = { US: "美國", JP: "日本" };
export const SIGNAL_CATEGORY_TEXT = { flow: "資金流", regulation: "監管", risk: "風險", macro: "宏觀", market: "市場" };
export const SIGNAL_IMPACT_TEXT = { high: "高", medium: "中", low: "低" };

export function badgeClass(level = "low") {
  if (level === "high") return "badge high";
  if (level === "medium") return "badge medium";
  return "badge low";
}

export function statusClass(status = "recent") {
  return status === "upcoming" ? "upcoming" : "recent";
}

export function stripHtml(text = "") {
  return String(text).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

export function toTimestamp(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : -1;
}

export function biasClass(text = "") {
  const t = String(text);
  if (/待確認|待公布|待判讀|判讀中/i.test(t)) return "bias-muted";
  if (/偏漲|偏多|上漲|多頭|\bup\b/i.test(t)) return "bias-up";
  if (/偏跌|偏空|下跌|空頭|\bdown\b/i.test(t)) return "bias-down";
  return "bias-side";
}

export function biasSpan(text = "") {
  return `<span class="${biasClass(text)}">${text || "震盪"}</span>`;
}

export function colorizeBiasWords(text = "") {
  return stripHtml(text)
    .replace(/待公布後判讀|待公布|待確認|待判讀|判讀中/g, '<span class="bias-muted">$&</span>')
    .replace(/偏漲|偏多|上漲|多頭/g, '<span class="bias-up">$&</span>')
    .replace(/偏跌|偏空|下跌|空頭/g, '<span class="bias-down">$&</span>')
    .replace(/震盪/g, '<span class="bias-side">$&</span>');
}

export function colorizeBiasWordsKeepHtml(text = "") {
  return String(text)
    .replace(/待公布後判讀|待公布|待確認|待判讀|判讀中/g, '<span class="bias-muted">$&</span>')
    .replace(/偏漲|偏多|上漲|多頭/g, '<span class="bias-up">$&</span>')
    .replace(/偏跌|偏空|下跌|空頭/g, '<span class="bias-down">$&</span>')
    .replace(/震盪/g, '<span class="bias-side">$&</span>');
}

export function toNumber(value) {
  const num = Number(String(value ?? "").replace(/[^\d.+-]/g, ""));
  return Number.isFinite(num) ? num : null;
}

export function probabilitySpan(probability) {
  const cls = probability >= 60 ? "bias-up" : probability <= 40 ? "bias-down" : "bias-side";
  return `<span class="${cls}">${probability}%</span>`;
}

export function signedSpan(value, { digits = 2, unit = "", reverse = false, prefix = "" } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const cls = n > 0 ? (reverse ? "bias-down" : "bias-up") : n < 0 ? (reverse ? "bias-up" : "bias-down") : "bias-side";
  const sign = n > 0 ? "+" : "";
  const text = `${prefix}${sign}${n.toFixed(digits)}${unit}`;
  return `<span class="${cls}">${text}</span>`;
}

export function translateFngClassification(value = "") {
  const v = String(value || "").toLowerCase();
  if (v.includes("extreme fear")) return "極度恐懼";
  if (v.includes("fear")) return "恐懼";
  if (v.includes("neutral")) return "中性";
  if (v.includes("extreme greed")) return "極度貪婪";
  if (v.includes("greed")) return "貪婪";
  return String(value || "");
}

export function translatePolicyTitle(text = "") {
  let t = stripHtml(text);
  const replacements = [
    [/Federal Reserve Board/gi, "聯準會理事會"],
    [/Federal Reserve/gi, "聯準會"],
    [/White House/gi, "白宮"],
    [/U\.S\. Treasury/gi, "美國財政部"],
    [/Treasury/gi, "財政部"],
    [/SEC\b/gi, "SEC"],
    [/CFTC\b/gi, "CFTC"],
    [/announces?/gi, "宣布"],
    [/announced/gi, "宣布"],
    [/approval of application/gi, "批准申請"],
    [/approves?/gi, "批准"],
    [/application/gi, "申請"],
    [/final rule/gi, "最終規則"],
    [/press release/gi, "新聞稿"],
    [/statement/gi, "聲明"],
    [/charges?/gi, "指控"],
    [/lawsuit/gi, "訴訟"],
    [/settlement/gi, "和解"],
    [/penalt(y|ies)/gi, "罰款"],
    [/sanctions?/gi, "制裁"],
    [/tariffs?/gi, "關稅"],
    [/crypto/gi, "加密"],
    [/\s{2,}/g, " "]
  ];
  for (const [re, rep] of replacements) {
    t = t.replace(re, rep);
  }
  const out = t.replace(/\s+/g, " ").trim();
  return out || stripHtml(text);
}

export function translatePolicySourceName(text = "") {
  const t = String(text || "").toLowerCase();
  if (t.includes("whitehouse")) return "白宮";
  if (t.includes("treasury")) return "美國財政部";
  if (t.includes("federal reserve")) return "聯準會";
  if (t === "sec") return "SEC";
  if (t === "cftc") return "CFTC";
  return stripHtml(text) || "官方來源";
}

export function translateRiskText(text = "") {
  const clean = stripHtml(text)
    .replace(/\s+-\s+[^-]+$/g, "")
    .trim();

  if (/Supreme Court.*reversal.*Trump.*tariff.*clarity/i.test(clean)) {
    return "美國最高法院推翻川普關稅措施，可能讓政策方向更明確";
  }

  let translated = clean;
  const replacements = [
    [/Supreme Court/gi, "美國最高法院"],
    [/Trump(?:'s)?/gi, "川普"],
    [/tariffs?/gi, "關稅"],
    [/reversal/gi, "推翻"],
    [/could bring/gi, "可能帶來"],
    [/clarity/gi, "更明確方向"],
    [/policy/gi, "政策"],
    [/trade/gi, "貿易"],
    [/war/gi, "戰爭"],
    [/sanctions?/gi, "制裁"],
    [/interest rates?/gi, "利率"],
    [/Fed/gi, "聯準會"],
    [/FOMC/gi, "FOMC"],
    [/BOJ/gi, "日本央行"],
    [/crypto/gi, "加密市場"]
  ];
  for (const [pattern, replacement] of replacements) {
    translated = translated.replace(pattern, replacement);
  }
  return translated;
}
