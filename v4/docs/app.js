/**
 * app.js — CryptoPulse V4 Frontend
 * Fetches ./data/latest.json and renders grouped source snapshots.
 */

'use strict';

// ── Password protection ──────────────────────────────────────────────────────
const PASSWORD = 'TRAXXAS';
const SESSION_KEY = 'cp_auth';

const overlay = document.getElementById('pw-overlay');
const pwInput = document.getElementById('pw-input');
const pwBtn = document.getElementById('pw-btn');
const pwError = document.getElementById('pw-error');

function checkAuth() {
  return localStorage.getItem(SESSION_KEY) === '1';
}

function unlock() {
  if (pwInput.value.trim().toUpperCase() === PASSWORD) {
    localStorage.setItem(SESSION_KEY, '1');
    overlay.style.display = 'none';
    loadData();
    setInterval(loadData, 5 * 60 * 1000);
  } else {
    pwError.textContent = '密碼錯誤，請重新輸入。';
    pwInput.value = '';
    pwInput.focus();
  }
}

pwBtn.addEventListener('click', unlock);
pwInput.addEventListener('keydown', e => { if (e.key === 'Enter') unlock(); });

if (checkAuth()) {
  overlay.style.display = 'none';
  loadData();
  setInterval(loadData, 5 * 60 * 1000);
}

// ── Category labels ──────────────────────────────────────────────────────────
const CATEGORY_LABELS = {
  crypto_market_structure:    '加密市場結構',
  macro_calendar_us:          '美國關鍵事件/行事曆',
  macro_calendar_jp:          '日本關鍵事件/行事曆',
  policy_us:                  '美國政策/監管',
  policy_global:              '全球政策/監管',
  policy_jp:                  '日本政策',
  geopolitics_conflict:       '地緣政治/制裁',
  macro_data_us:              '美國宏觀數據',
  macro_data_jp:              '日本宏觀數據',
  rates_yields_us:            '利率/殖利率',
  liquidity_flows:            '流動性/資金流',
  security_incidents:         '安全事件',
  news_crypto:                '加密新聞',
  news_macro:                 '宏觀新聞',
  news_geopolitics:           '地緣政治新聞',
  exchanges_announcements:    '交易所公告',
  tradfi_equities_risk:       '傳統金融/風險指標',
  whale_institutional:        '鯨魚/機構操作',
  onchain_whales_institutions:'鯨魚/機構操作（鏈上）',
  crypto_derivatives:         '加密衍生品',
  social_kol:                 '社群/KOL 訊號',
  storage:                    '儲存/快取'
};

// Preferred category order
const CATEGORY_ORDER = [
  'crypto_market_structure',
  'macro_calendar_us',
  'macro_calendar_jp',
  'macro_data_us',
  'macro_data_jp',
  'rates_yields_us',
  'policy_us',
  'policy_global',
  'policy_jp',
  'geopolitics_conflict',
  'liquidity_flows',
  'security_incidents',
  'news_crypto',
  'news_macro',
  'news_geopolitics',
  'exchanges_announcements',
  'tradfi_equities_risk',
  'whale_institutional',
  'onchain_whales_institutions',
  'crypto_derivatives',
  'social_kol',
  'storage'
];

// ── Formatting helpers ───────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(isoStr) {
  if (!isoStr) return '—';
  try {
    return new Intl.DateTimeFormat('zh-Hant', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
    }).format(new Date(isoStr));
  } catch {
    return isoStr;
  }
}

function fmtNum(n) {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6)  return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3)  return n.toLocaleString();
  return String(n);
}

function statusBadge(status) {
  const map = { ok: 'badge-ok', error: 'badge-error', skip: 'badge-skip' };
  const label = { ok: 'OK', error: 'ERROR', skip: 'SKIP' };
  const cls = map[status] || 'badge-skip';
  return `<span class="badge ${cls}">${label[status] || status}</span>`;
}

// ── Data preview renderers ────────────────────────────────────────────────────

function renderCsvPreview(data) {
  if (!data) return '<span class="data-preview">無資料</span>';
  const { latest_date, latest_value, previous_value, change, change_pct } = data;
  let changeHtml = '';
  if (change != null) {
    const cls = change > 0 ? 'data-change-up' : change < 0 ? 'data-change-down' : 'data-change-flat';
    const sign = change > 0 ? '+' : '';
    const pctStr = change_pct != null ? ` (${sign}${change_pct.toFixed(2)}%)` : '';
    changeHtml = `<span class="${cls}">${sign}${fmtNum(change)}${pctStr}</span>`;
  }
  return `
    <div class="data-preview">
      <span class="data-value">${fmtNum(latest_value)}</span>
      ${changeHtml ? ' ' + changeHtml : ''}
      <div style="margin-top:3px;font-size:11px;color:var(--text-muted)">
        最新日期：${escHtml(latest_date || '—')}
      </div>
    </div>`;
}

function renderRssPreview(data) {
  if (!data) return '<span class="data-preview">無資料</span>';

  // ICS format
  if (data.type === 'ics') {
    return `<div class="data-preview">
      <strong>ICS 日曆</strong> — ${data.event_count} 個事件
      <div class="rss-date" style="margin-top:4px;white-space:pre-wrap;font-family:monospace;font-size:10px;">${escHtml((data.excerpt || '').slice(0, 200))}</div>
    </div>`;
  }

  // XML raw fallback
  if (data.type === 'xml_raw') {
    return `<div class="data-preview">
      <span class="excerpt-text">${escHtml((data.excerpt || '').slice(0, 200))}</span>
    </div>`;
  }

  // Normal RSS/Atom items
  const items = data.items || [];
  if (items.length === 0) return '<span class="data-preview">無文章</span>';

  const first = items[0];
  const linkHtml = first.link
    ? `<a href="${escHtml(first.link)}" target="_blank" rel="noopener">${escHtml(first.title || first.link)}</a>`
    : escHtml(first.title || '無標題');

  let html = `<div class="data-preview">
    <span class="rss-title">${linkHtml}</span>
    <div class="rss-date">${escHtml(first.pubDate || '')}</div>`;

  if (items.length > 1) {
    html += `<div class="rss-more">+${items.length - 1} 則更多</div>`;
  }
  html += '</div>';
  return html;
}

function renderJsonPreview(data) {
  if (!data) return '<span class="data-preview">無資料</span>';

  // Truncated large payload
  if (data._truncated) {
    return `<div class="data-preview">
      <strong>JSON ${data._original_type}</strong>
      ${data._original_length != null ? `（${data._original_length} 項）` : ''}
      <div class="excerpt-text" style="margin-top:4px;font-family:monospace;font-size:10px;">${escHtml((data.preview || '').slice(0, 300))}…</div>
    </div>`;
  }

  // Array of objects
  if (Array.isArray(data)) {
    const first = data[0];
    if (first && typeof first === 'object') {
      const keys = Object.keys(first).slice(0, 4);
      const summary = keys.map(k => `<strong>${escHtml(k)}</strong>: ${escHtml(String(first[k]).slice(0, 50))}`).join(' | ');
      return `<div class="data-preview">${summary}
        ${data.length > 1 ? `<div class="rss-more">+${data.length - 1} 項</div>` : ''}</div>`;
    }
    return `<div class="data-preview">[${data.map(v => escHtml(String(v))).join(', ')}]</div>`;
  }

  // Object: show key metrics
  if (typeof data === 'object') {
    const entries = Object.entries(data).slice(0, 5);
    const summary = entries.map(([k, v]) => {
      const val = typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60);
      return `<strong>${escHtml(k)}</strong>: ${escHtml(val)}`;
    }).join(' | ');
    return `<div class="data-preview">${summary}</div>`;
  }

  return `<div class="data-preview">${escHtml(String(data).slice(0, 200))}</div>`;
}

function renderHtmlPreview(data) {
  if (!data) return '<span class="data-preview">無資料</span>';
  const { title, excerpt, links } = data;
  let html = `<div class="data-preview">`;
  if (title) html += `<strong>${escHtml(title.slice(0, 80))}</strong><br>`;
  if (excerpt) html += `<span class="excerpt-text">${escHtml(excerpt.slice(0, 250))}</span>`;
  if (links && links.length > 0) {
    const l = links[0];
    html += `<div style="margin-top:4px;font-size:11px;">
      <a href="${escHtml(l.href)}" target="_blank" rel="noopener" style="color:var(--accent)">${escHtml(l.text.slice(0, 60))}</a>
    </div>`;
  }
  html += '</div>';
  return html;
}

function renderDataPreview(snapshot) {
  const { status, data, error_message, source_id } = snapshot;

  if (status === 'error') {
    return `<span class="error-msg">${escHtml((error_message || 'Unknown error').slice(0, 200))}</span>`;
  }
  if (status === 'skip') {
    return `<span class="data-preview" style="color:var(--skip)">${escHtml(error_message || 'SKIP')}</span>`;
  }
  if (!data) return '<span class="data-preview">—</span>';

  // Determine type from data structure or source_id patterns
  if (data.latest_date !== undefined || data.latest_value !== undefined) {
    return renderCsvPreview(data);
  }
  if (data.items !== undefined || data.type === 'ics' || data.type === 'xml_raw') {
    return renderRssPreview(data);
  }
  if (data.title !== undefined && data.excerpt !== undefined) {
    return renderHtmlPreview(data);
  }
  // Fallback: generic JSON
  return renderJsonPreview(data);
}

// ── Main render ───────────────────────────────────────────────────────────────

function render(latestJson) {
  const { generatedAt, totals, snapshots } = latestJson;

  // Update header time
  document.getElementById('collection-time').textContent =
    '最後收集：' + formatDate(generatedAt);

  // Group by category
  const groups = {};
  for (const snap of snapshots) {
    const cat = snap.category || 'unknown';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(snap);
  }

  const root = document.getElementById('root');

  // Build HTML
  let html = '';

  // Summary bar
  html += `<div class="summary-bar">
    <div class="summary-item">
      <span class="summary-label">總計</span>
      <span class="summary-value total">${totals.total}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">成功</span>
      <span class="summary-value ok">${totals.success}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">失敗</span>
      <span class="summary-value error">${totals.failed}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">略過</span>
      <span class="summary-value skip">${totals.skipped}</span>
    </div>
    <div class="summary-time">
      <span class="summary-label">收集時間</span>
      <span style="font-size:12px;color:var(--text)">${formatDate(generatedAt)}</span>
    </div>
  </div>`;

  // Determine category order
  const allCats = Object.keys(groups);
  const ordered = [
    ...CATEGORY_ORDER.filter(c => allCats.includes(c)),
    ...allCats.filter(c => !CATEGORY_ORDER.includes(c))
  ];

  for (const cat of ordered) {
    const items = groups[cat];
    const label = CATEGORY_LABELS[cat] || cat;

    html += `<div class="category-section">
      <div class="category-header">
        <span class="category-label">${escHtml(label)}</span>
        <span class="category-count">${items.length} 個來源</span>
      </div>
      <table class="source-table">
        <thead>
          <tr>
            <th style="width:30%">來源名稱</th>
            <th style="width:8%">狀態</th>
            <th style="width:14%">收集時間</th>
            <th>資料預覽</th>
          </tr>
        </thead>
        <tbody>`;

    for (const snap of items) {
      const preview = renderDataPreview(snap);
      html += `<tr>
        <td>
          <div class="source-name">${escHtml(snap.source_name)}</div>
          <div class="source-meta">${escHtml(snap.source_id)}</div>
        </td>
        <td>${statusBadge(snap.status)}</td>
        <td><span class="fetched-at">${formatDate(snap.fetched_at)}</span></td>
        <td>${preview}</td>
      </tr>`;
    }

    html += `</tbody></table></div>`;
  }

  root.innerHTML = html;
}

// ── Load data ─────────────────────────────────────────────────────────────────

async function loadData() {
  const root = document.getElementById('root');
  try {
    const res = await fetch('./data/latest.json?' + Date.now());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    render(data);
  } catch (err) {
    root.innerHTML = `<div class="state-message">
      <h2>載入失敗</h2>
      <p>${escHtml(err.message)}</p>
      <p style="margin-top:8px;font-size:12px;">請先執行 <code>node v4/scripts/collect-all.mjs</code> 產生資料</p>
    </div>`;
  }
}
