function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildCategoryMap(defs) {
  const map = new Map();
  for (const d of Array.isArray(defs) ? defs : []) {
    if (!d?.id) continue;
    map.set(String(d.id), { label: d.label, description: d.description });
  }
  return map;
}

function categoryLabel(category, categoryMap) {
  const c = String(category || "other");
  return categoryMap?.get(c)?.label || c;
}

function regionLabel(region) {
  switch (String(region || "").toUpperCase()) {
    case "US":
      return "美國";
    case "JP":
      return "日本";
    case "GLOBAL":
      return "全球";
    default:
      return region ? String(region) : "—";
  }
}

function accessLabel(access) {
  switch (String(access || "").toLowerCase()) {
    case "public":
      return "公開";
    case "official_api":
      return "官方 API";
    case "third_party_api":
      return "第三方 API";
    case "html_scrape":
      return "HTML/爬取";
    default:
      return access ? String(access) : "—";
  }
}

function stabilityLabel(stability) {
  switch (String(stability || "").toLowerCase()) {
    case "high":
      return "高";
    case "medium":
      return "中";
    case "low":
      return "低";
    default:
      return stability ? String(stability) : "—";
  }
}

function fmtBool(value) {
  return value ? "必須" : "可選";
}

function fmtYesNo(value, yes = "是", no = "否") {
  return value ? yes : no;
}

function isLinkableUrl(url) {
  const u = String(url || "");
  if (!u) return false;
  if (/\$\{[A-Z0-9_]+\}/.test(u)) return false;
  return /^https?:\/\//i.test(u);
}

function renderUrlCell(url) {
  const u = String(url || "");
  if (!u) return "";
  if (isLinkableUrl(u)) {
    return `<a href="${escapeHtml(u)}" target="_blank" rel="noreferrer">${escapeHtml(u)}</a>`;
  }
  return `<span class="muted">${escapeHtml(u)}</span>`;
}

async function loadJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} 讀取失敗：${res.status}`);
  return res.json();
}

async function loadSources() {
  return loadJson("./data/sources.json");
}

async function loadFetchReport() {
  try {
    return await loadJson("./data/fetch-report.json");
  } catch {
    return null;
  }
}

async function loadKol() {
  return loadJson("./data/kol.json");
}

function groupByCategory(sources, categoryOrder = []) {
  const map = new Map();
  for (const item of sources) {
    const key = item.category || "other";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }

  for (const [, items] of map.entries()) {
    items.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), "zh-Hant"));
  }

  const idx = new Map(categoryOrder.map((id, i) => [String(id), i]));
  return [...map.entries()].sort((a, b) => {
    const ai = idx.has(String(a[0])) ? idx.get(String(a[0])) : Number.POSITIVE_INFINITY;
    const bi = idx.has(String(b[0])) ? idx.get(String(b[0])) : Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
    return String(a[0]).localeCompare(String(b[0]));
  });
}

function fmtStatus(status) {
  switch (String(status || "").toUpperCase()) {
    case "PASS":
      return '<span class="bias-up">PASS</span>';
    case "FAIL":
      return '<span class="bias-down">FAIL</span>';
    case "SKIP":
      return '<span class="bias-muted">SKIP</span>';
    default:
      return '<span class="muted">—</span>';
  }
}

function buildReportMap(report) {
  const map = new Map();
  const rows = Array.isArray(report?.results) ? report.results : [];
  for (const r of rows) {
    const id = r?.id ? String(r.id) : "";
    if (!id) continue;
    map.set(id, {
      status: r?.status ? String(r.status) : "",
      reason: r?.reason ? String(r.reason) : ""
    });
  }
  return map;
}

function renderSources({ title, notes, sources, categoryDefinitions }, fetchReport) {
  const root = document.getElementById("sources-root");
  if (!root) return;

  const src = Array.isArray(sources) ? sources : [];
  const categoryMap = buildCategoryMap(categoryDefinitions);
  const categoryOrder = (Array.isArray(categoryDefinitions) ? categoryDefinitions : []).map((d) => d?.id).filter(Boolean);
  const groups = groupByCategory(src, categoryOrder);

  const requiredCount = src.filter((s) => Boolean(s?.required)).length;
  const requiresApiCount = src.filter((s) => Boolean(s?.requiresApi)).length;

  const reportMap = buildReportMap(fetchReport);
  const reportAt = fetchReport?.generatedAt ? String(fetchReport.generatedAt) : "";
  const reportTotals = fetchReport?.totals || null;
  const reportSummary = reportTotals
    ? `最近測試：${escapeHtml(reportAt || "（未知時間）")}（PASS ${Number(reportTotals.pass) || 0} / SKIP ${Number(reportTotals.skip) || 0} / FAIL ${Number(reportTotals.failRequired) || 0}）`
    : "最近測試：尚未產生（可執行 node v2/scripts/test-sources.mjs --report）";

  root.innerHTML = `
    <h1>${escapeHtml(title || "資料抓取對象清單")}</h1>
    ${Array.isArray(notes) && notes.length ? `<ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : ""}
    <p style="margin-top: 10px;" class="muted">
      共 ${src.length} 個來源（必須：${requiredCount}；需要 API：${requiresApiCount}）
    </p>
    <p class="muted" style="margin-top: 6px;">${reportSummary}</p>
    ${groups
      .map(([category, items]) => {
        const rows = items
          .map((s) => {
            const url = s.url || s.urlTemplate || "";
            const tags = Array.isArray(s.tags) ? s.tags : [];
            const rep = s?.id ? reportMap.get(String(s.id)) : null;
            const titleAttr = rep?.reason ? ` title="${escapeHtml(rep.reason)}"` : "";
            const statusCell = rep?.status ? `<span${titleAttr}>${fmtStatus(rep.status)}</span>` : fmtStatus("");
            return `
              <tr>
                <td>${statusCell}</td>
                <td>${escapeHtml(s.name || s.id)}</td>
                <td>${renderUrlCell(url)}</td>
                <td>${escapeHtml(categoryLabel(category, categoryMap))}</td>
                <td>${escapeHtml(regionLabel(s.region))}</td>
                <td>${escapeHtml(accessLabel(s.access))}</td>
                <td>${escapeHtml(fmtBool(Boolean(s.required)))}</td>
                <td>${escapeHtml(fmtYesNo(Boolean(s.requiresApi), "需 API", "否"))}</td>
                <td>${escapeHtml(stabilityLabel(s.stability))}</td>
                <td class="muted">${escapeHtml(tags.join(", ") || "—")}</td>
              </tr>
            `;
          })
          .join("");

        return `
          <section style="margin-top: 18px;">
            <h2 style="margin: 0 0 8px;">${escapeHtml(categoryLabel(category, categoryMap))}</h2>
            <div style="overflow-x: auto;">
              <table class="table" style="min-width: 1120px;">
                <thead>
                  <tr>
                    <th>最近測試</th>
                    <th>名稱</th>
                    <th>URL</th>
                    <th>分類</th>
                    <th>地區</th>
                    <th>取得方式</th>
                    <th>必要性</th>
                    <th>API</th>
                    <th>穩定性</th>
                    <th>標籤</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows}
                </tbody>
              </table>
            </div>
          </section>
        `;
      })
      .join("")}
  `;
}

function renderKol(kolData) {
  const root = document.getElementById("sources-root");
  if (!root) return;

  const accounts = Array.isArray(kolData?.accounts) ? kolData.accounts : [];
  const verifiedCount = accounts.filter((a) => a && a.needsVerification === false).length;

  const rows = accounts
    .map((a) => {
      const tags = Array.isArray(a.tags) ? a.tags : [];
      const handle = a?.handle ? `@${a.handle}` : "—";
      const platform = String(a?.platform || "").toLowerCase() || "—";
      const verify = a?.needsVerification ? "待確認" : "已確認";
      return `
        <tr>
          <td>${escapeHtml(a.displayName || a.id || "")}</td>
          <td>${escapeHtml(platform)}</td>
          <td class="muted">${escapeHtml(handle)}</td>
          <td>${escapeHtml(a.type || "—")}</td>
          <td>${escapeHtml(regionLabel(a.region))}</td>
          <td>${escapeHtml(verify)}</td>
          <td class="muted">${escapeHtml(tags.join(", ") || "—")}</td>
        </tr>
      `;
    })
    .join("");

  root.insertAdjacentHTML(
    "beforeend",
    `
      <section style="margin-top: 22px;">
        <h2 style="margin: 0 0 8px;">社群監控名單（初稿）</h2>
        <p class="muted">共 ${accounts.length} 筆（已確認：${verifiedCount}）— 內容抓取需 API/授權，未開通前僅作名單管理。</p>
        ${Array.isArray(kolData?.notes) && kolData.notes.length ? `<ul>${kolData.notes.map((n) => `<li class=\"muted\">${escapeHtml(n)}</li>`).join("")}</ul>` : ""}
        <div style="overflow-x: auto;">
          <table class="table" style="min-width: 980px;">
            <thead>
              <tr>
                <th>名稱</th>
                <th>平台</th>
                <th>Handle</th>
                <th>類型</th>
                <th>地區</th>
                <th>狀態</th>
                <th>標籤</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
      </section>
    `
  );
}

function showError(error) {
  const root = document.getElementById("sources-root");
  if (!root) return;
  const isFileProtocol = typeof location !== "undefined" && location.protocol === "file:";
  const hint = isFileProtocol
    ? `
      <div class="muted" style="margin-top: 10px; line-height: 1.6;">
        你目前是用 <span class="bias-muted">file://</span> 直接開啟，瀏覽器通常會阻擋 <span class="bias-muted">fetch</span> 讀取本機 JSON。
        <br />
        請改用 GitHub Pages（或任何 http(s) 的靜態主機）開啟此頁。
      </div>
    `
    : "";
  root.innerHTML = `
    <h1>資料抓取對象清單</h1>
    <p>清單載入失敗：${escapeHtml(error?.message || String(error))}</p>
    <p class="muted">若你是在 GitHub Pages 預覽也遇到此錯誤，請確認同層有 data/sources.json 與 data/kol.json。</p>
    ${hint}
  `;
}

(async () => {
  try {
    const [data, report] = await Promise.all([loadSources(), loadFetchReport()]);
    renderSources(
      {
        title: data?.title,
        notes: data?.notes,
        sources: Array.isArray(data?.sources) ? data.sources : [],
        categoryDefinitions: Array.isArray(data?.categoryDefinitions) ? data.categoryDefinitions : []
      },
      report
    );

    try {
      const kol = await loadKol();
      renderKol(kol);
    } catch (e) {
      // kol.json 不存在或讀不到時，不阻擋來源清單顯示
    }
  } catch (e) {
    showError(e);
  }
})();
