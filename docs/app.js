const fmt = new Intl.DateTimeFormat("zh-Hant", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

function badgeClass(level = "low") {
  if (level === "high") return "badge high";
  if (level === "medium") return "badge medium";
  return "badge low";
}

function statusClass(status = "recent") {
  return status === "upcoming" ? "upcoming" : "recent";
}

async function loadData() {
  const response = await fetch(`./data/latest.json?t=${Date.now()}`);
  if (!response.ok) {
    throw new Error("無法載入最新資料");
  }
  return response.json();
}

function renderMeta(data) {
  const el = document.getElementById("meta");
  el.textContent = `最後更新：${fmt.format(new Date(data.generatedAt))}（UTC 來源整合）`;
}

function renderAi(data) {
  const list = document.getElementById("ai-insights");
  list.innerHTML = "";
  (data?.aiSummary?.keyInsights || []).forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    list.appendChild(li);
  });
}

function renderWindows(data) {
  const root = document.getElementById("key-windows");
  root.innerHTML = "";

  (data.keyWindows || []).forEach((item) => {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3>${item.title}</h3>
      <div>${fmt.format(new Date(item.datetime))}</div>
      <div class="kv">${item.country} / ${item.why}</div>
    `;
    root.appendChild(card);
  });
}

function renderMacro(data) {
  const body = document.getElementById("macro-body");
  body.innerHTML = "";

  (data.macroEvents || []).forEach((event) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmt.format(new Date(event.datetime))}</td>
      <td>${event.country}</td>
      <td><a href="${event.source}" target="_blank" rel="noreferrer">${event.title}</a></td>
      <td><span class="${badgeClass(event.importance)}">${event.importance}</span></td>
      <td><span class="${statusClass(event.status)}">${event.status}</span></td>
    `;
    body.appendChild(tr);
  });
}

function renderSignals(data) {
  const root = document.getElementById("crypto-signals");
  root.innerHTML = "";

  (data.cryptoSignals || []).forEach((signal) => {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <h3><a href="${signal.source}" target="_blank" rel="noreferrer">${signal.title}</a></h3>
      <div>${fmt.format(new Date(signal.time))}</div>
      <div class="kv">分類：${signal.category} / 影響：${signal.impact}</div>
      <p>${signal.summary || ""}</p>
    `;
    root.appendChild(card);
  });
}

async function bootstrap() {
  try {
    const data = await loadData();
    renderMeta(data);
    renderAi(data);
    renderWindows(data);
    renderMacro(data);
    renderSignals(data);
  } catch (error) {
    document.body.innerHTML = `<main class="container"><h1>資料載入失敗</h1><p>${error.message}</p></main>`;
  }
}

bootstrap();
