// VAT Registration Checker — front end (no build step, plain ES modules).

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const main = $('#main');
const MANUAL_MINUTES_PER_CHECK = 3; // used for the "time saved" estimate on Insights

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = (n) => (n == null ? '–' : Number(n).toLocaleString('en-GB'));
const hrs = (checks) => { const h = Math.round(((checks || 0) * MANUAL_MINUTES_PER_CHECK) / 60); return `${fmtN(h)} hr${h === 1 ? '' : 's'}`; };
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
const fmtVrn = (v) => (v && v.length === 9 ? `GB ${v.slice(0, 3)} ${v.slice(3, 7)} ${v.slice(7)}` : v || '–');
const initials = (n) => String(n || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

let config = {};
let user = (() => { try { return localStorage.getItem('vat.user') || ''; } catch { return ''; } })();

// ---------------------------------------------------------------- api
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (user) headers['x-user-name'] = encodeURIComponent(user);
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
  const res = await fetch(path, { ...opts, headers });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !config.ssoUser) askUser(true);
    throw new Error((body && body.error) || `Request failed (${res.status})`);
  }
  return body;
}
const dl = (path) => `${path}${path.includes('?') ? '&' : '?'}user=${encodeURIComponent(user)}`;

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.className = 'toast'; }, 3800);
}

// ---------------------------------------------------------------- user
function renderUser() {
  const u = config.ssoUser || user;
  $('#userBtn').innerHTML = u ? `<span class="av">${esc(initials(u))}</span><span class="nm">${esc(u)}</span>` : '<span class="av">?</span><span class="nm">Sign in</span>';
}
function askUser(force) {
  if (config.ssoUser) return;
  const d = $('#userDialog');
  if (d.open) return;
  $('#userName').value = user;
  d.showModal();
  if (!force) $('#userName').select();
}
$('#userForm').addEventListener('submit', () => {
  user = $('#userName').value.trim();
  try { localStorage.setItem('vat.user', user); } catch { /* storage unavailable */ }
  renderUser();
});
$('#userDialog').addEventListener('cancel', (e) => { if (!user) e.preventDefault(); });
$('#userBtn').addEventListener('click', () => askUser());
$('#menuBtn').addEventListener('click', () => {
  const n = $('.nav');
  n.classList.toggle('open');
  $('#menuBtn').setAttribute('aria-expanded', n.classList.contains('open'));
});

// ---------------------------------------------------------------- outcome helpers
function outcome(c) {
  switch (c.status) {
    case 'registered':
      if (c.name_level === 'mismatch') return { cls: 'bad', icon: '!', label: 'Registered · name mismatch', short: 'Name mismatch' };
      if (c.name_level === 'partial') return { cls: 'warn', icon: '≈', label: 'Registered · name differs', short: 'Name differs' };
      return { cls: 'good', icon: '✓', label: 'Registered', short: 'Registered' };
    case 'not_registered': return { cls: 'bad', icon: '✕', label: 'Not registered', short: 'Not registered' };
    case 'invalid_format': return { cls: 'bad', icon: '✕', label: 'Invalid format', short: 'Invalid format' };
    case 'error': return { cls: 'neutral', icon: '↻', label: 'Check failed', short: 'Failed' };
    default: return { cls: 'info', icon: '…', label: 'Queued', short: 'Queued' };
  }
}
const pill = (c) => { const o = outcome(c); return `<span class="pill ${o.cls}"><span class="ic" aria-hidden="true">${o.icon}</span>${esc(o.label)}</span>`; };
const reviewPill = (c) => (c.review_status === 'accepted' ? '<span class="pill good">✓ Accepted</span>'
  : c.review_status === 'query' ? '<span class="pill warn">? Query raised</span>'
    : c.needs_attention ? '<span class="pill warn">● Needs review</span>' : '<span class="muted">—</span>');
const addr = (a) => (a ? [a.line1, a.line2, a.line3, a.line4, a.line5, a.postcode, a.countryCode].filter(Boolean).join(', ') : '');

// Light-weight structural VRN check for the mapping preview (server is authoritative).
function quickVrn(raw) {
  let s = String(raw || '').toUpperCase().replace(/[\s.\-_/]/g, '').replace(/^\d+\.0+$/, (m) => m.replace(/\.0+$/, ''));
  s = s.replace(/^(GB|XI)/, '');
  if (/^\d{12}$/.test(s)) s = s.slice(0, 9);
  return /^\d{9}$/.test(s) ? s : null;
}

// ---------------------------------------------------------------- router
const routes = [
  [/^\/?$/, viewHome, 'home'],
  [/^\/bulk$/, viewBulk, 'bulk'],
  [/^\/quick$/, viewQuick, 'quick'],
  [/^\/batches$/, viewBatches, 'batches'],
  [/^\/batch\/([\w-]+)$/, viewBatch, 'batches'],
  [/^\/insights$/, viewInsights, 'insights'],
  [/^\/audit$/, viewAudit, 'audit'],
  [/^\/help$/, viewHelp, 'help'],
];
let current = { name: null, cleanup: null };
async function route() {
  const path = location.hash.replace(/^#/, '') || '/';
  if (current.cleanup) current.cleanup();
  current = { name: null, cleanup: null };
  closeDrawer();
  $('.nav').classList.remove('open');
  for (const [re, fn, nav] of routes) {
    const m = path.match(re);
    if (m) {
      $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
      current.name = nav;
      main.innerHTML = '<div class="empty">Loading…</div>';
      try { await fn(...m.slice(1)); } catch (e) { main.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
      main.focus({ preventScroll: true });
      window.scrollTo(0, 0);
      return;
    }
  }
  main.innerHTML = '<div class="card empty">Page not found. <a href="#/">Go to overview</a></div>';
}
window.addEventListener('hashchange', route);

// Live updates from the batch processor.
const sseHandlers = new Set();
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => { const e = JSON.parse(m.data); sseHandlers.forEach((h) => h(e)); };
}

// ---------------------------------------------------------------- charts
function stackBar(parts, total) {
  const segs = parts.filter((p) => p.n > 0);
  if (!total) return '<div class="muted">No checks yet</div>';
  return `<div class="stack" role="img" aria-label="${esc(segs.map((p) => `${p.label}: ${p.n}`).join(', '))}">
    ${segs.map((p) => `<div style="flex:${p.n};background:${p.color}" data-tip="${esc(`${p.label}: ${fmtN(p.n)} (${pct(p.n, total)}%)`)}"></div>`).join('')}
  </div>
  <div class="legend">${parts.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.label)} <strong>${fmtN(p.n)}</strong></span>`).join('')}</div>`;
}

function columnChart(days) {
  // 30-day volume, one series. Bars anchored to baseline with rounded tops.
  const list = [];
  const byDay = Object.fromEntries(days.map((d) => [d.day, d]));
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    list.push({ day: d, n: byDay[d] ? byDay[d].n : 0 });
  }
  const max = Math.max(4, ...list.map((d) => d.n));
  const W = 600; const H = 180; const pad = { l: 34, b: 22, t: 8 };
  const bw = (W - pad.l) / list.length;
  const y = (v) => H - pad.b - ((H - pad.b - pad.t) * v) / max;
  const ticks = [0, Math.round(max / 2), max];
  return `<div class="bars"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Checks per day over the last 30 days">
    ${ticks.map((t) => `<line class="grid-line" x1="${pad.l}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('')}
    ${list.map((d, i) => {
    const h = H - pad.b - y(d.n);
    const x = pad.l + i * bw + 2;
    const w = Math.max(2, bw - 4);
    const r = Math.min(4, w / 2, h);
    const top = y(d.n);
    const path = h > 0 ? `M${x},${H - pad.b} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${H - pad.b} Z` : '';
    const label = new Date(d.day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `<g data-tip="${esc(`${label}: ${fmtN(d.n)} checks`)}"><rect x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${H - pad.b - pad.t}" fill="transparent"/>${path ? `<path d="${path}" fill="var(--fm-blue)"/>` : ''}</g>
      ${(i % 7 === 0 && i < 26) || i === 29 ? `<text class="axis" x="${pad.l + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${label}</text>` : ''}`;
  }).join('')}
  </svg></div>`;
}

function hbars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return rows.map((r) => `<div class="hbar" data-tip="${esc(`${r.label}: ${fmtN(r.n)}`)}"><span>${esc(r.label)}</span><div class="track"><div class="fill" style="width:${(100 * r.n) / max}%"></div></div><span class="v">${fmtN(r.n)}</span></div>`).join('') || '<div class="muted">No activity yet</div>';
}

// Shared hover tooltip for any element with data-tip.
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  const tip = $('#tip');
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.dataset.tip;
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${e.clientY + 14}px`;
});

const outcomeParts = (t) => [
  { label: 'Registered', n: (t.registered || 0) - (t.name_mismatch || 0) - (t.name_partial || 0), color: 'var(--chart-good)' },
  { label: 'Name differs', n: t.name_partial || 0, color: 'var(--chart-warn)' },
  { label: 'Name mismatch', n: t.name_mismatch || 0, color: 'var(--chart-serious)' },
  { label: 'Not registered / invalid', n: (t.not_registered || 0) + (t.invalid_format || 0), color: 'var(--chart-bad)' },
  { label: 'Failed / queued', n: (t.errors || 0) + (t.pending || 0), color: 'var(--chart-neutral)' },
];

// ---------------------------------------------------------------- views: home
async function viewHome() {
  const ins = await api('/api/insights');
  const t = ins.totals;
  main.innerHTML = `
  <section class="hero">
    <div class="eyebrow">Tax compliance · VAT</div>
    <h1>Verify hundreds of client VAT numbers with HMRC in minutes.</h1>
    <p>Upload a client list, and every VAT number is checked against HMRC's live register, compared with the client name you hold, and recorded in a tamper-evident audit trail.</p>
    <div class="hero-actions">
      <a class="btn light" href="#/bulk">⬆ Start a bulk check</a>
      <a class="btn ghost-light" href="#/quick">Check a single number</a>
    </div>
  </section>
  <div class="grid kpis">
    ${kpi('Checks completed', fmtN(t.checks - (t.pending || 0)), `${fmtN(ins.batches.n)} batches`)}
    ${kpi('Registered', `${pct(t.registered, t.checks)}%`, `${fmtN(t.registered)} confirmed by HMRC`, 'good')}
    ${kpi('Needs review', fmtN(t.attention), 'Not registered, mismatched or failed', t.attention ? 'warn' : '')}
    ${kpi('Time saved (est.)', hrs(t.checks), `vs ~${MANUAL_MINUTES_PER_CHECK} min per manual check`)}
  </div>
  <div class="grid two">
    <section class="card">
      <div class="card-head"><h2>Needs your attention</h2><a href="#/insights">See insights →</a></div>
      ${ins.attentionList.length ? ins.attentionList.map(attentionItem).join('') : '<div class="empty">🎉 Nothing outstanding — every exception has been reviewed.</div>'}
    </section>
    <section class="card">
      <div class="card-head"><h2>Recent batches</h2><a href="#/batches">All batches →</a></div>
      ${ins.recentBatches.length ? ins.recentBatches.map(batchMini).join('') : `<div class="empty">No batches yet.<br><br><a class="btn primary" href="#/bulk">Upload your first file</a></div>`}
    </section>
  </div>`;
  bindAttention();
}
const kpi = (label, value, sub, cls = '') => `<div class="card kpi ${cls}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`;
const attentionItem = (c) => `<div class="attention-item" data-check="${c.id}" tabindex="0" role="button">
  <div><strong>${esc(c.client_name || c.client_ref || fmtVrn(c.vrn))}</strong><span class="cell-sub">${esc(fmtVrn(c.vrn || c.input_vrn))} · ${esc(c.batch_name || 'Quick check')}</span></div>${pill(c)}</div>`;
function bindAttention(root = main, onChange) {
  $$('[data-check]', root).forEach((el) => {
    const open = () => openCheck(Number(el.dataset.check), onChange);
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
}
function batchMini(b) {
  const done = b.total - (b.pending || 0);
  return `<a class="attention-item" href="#/batch/${esc(b.id)}" style="text-decoration:none;color:inherit">
    <div style="min-width:0;flex:1"><strong>${esc(b.name)}</strong><span class="cell-sub">${fmtN(b.total)} rows · ${esc(b.created_by)} · ${fmtDate(b.created_at)}</span>
    <div class="progress" style="margin-top:8px;height:8px">${progressSegs(b)}</div></div>
    <div style="text-align:right">${b.status === 'completed' ? (b.attention ? `<span class="pill warn">● ${fmtN(b.attention)} to review</span>` : '<span class="pill good">✓ Complete</span>') : `<span class="pill info">${pct(done, b.total)}%</span>`}</div></a>`;
}
function progressSegs(b) {
  const t = b.total || 1;
  const good = (b.registered || 0) - (b.name_mismatch || 0);
  return `<span class="p-good" style="width:${(100 * good) / t}%"></span><span class="p-warn" style="width:${(100 * (b.name_mismatch || 0)) / t}%"></span><span class="p-bad" style="width:${(100 * ((b.not_registered || 0) + (b.invalid_format || 0))) / t}%"></span><span class="p-neutral" style="width:${(100 * (b.errors || 0)) / t}%"></span>${b.pending ? `<span class="p-run" style="width:${(100 * b.pending) / t}%"></span>` : ''}`;
}

// ---------------------------------------------------------------- views: bulk upload
let upload = null;
async function viewBulk() {
  if (!upload) return renderUploadStep();
  return renderMappingStep();
}
function stepper(n) {
  const labels = ['Upload client list', 'Confirm columns', 'Run checks with HMRC', 'Review & evidence'];
  return `<ol class="stepper">${labels.map((l, i) => `<li class="${i < n ? 'done' : i === n ? 'current' : ''}"><span>${l}</span></li>`).join('')}</ol>`;
}
function renderUploadStep() {
  main.innerHTML = `
  <div class="page-head"><div><h1>Bulk VAT check</h1><p>Upload a spreadsheet of clients. We'll find the VAT number column for you.</p></div>
    <a class="btn" href="/api/template.xlsx">⬇ Download template</a></div>
  ${stepper(0)}
  <label class="dropzone" id="drop" tabindex="0">
    <div class="icon" aria-hidden="true">⬆</div>
    <h2>Drop your client list here</h2>
    <p class="muted">or click to choose a file · up to ${fmtN(config.maxBatchRows)} rows</p>
    <div class="formats"><span class="pill info">.xlsx</span><span class="pill info">.csv</span></div>
    <input type="file" id="file" accept=".xlsx,.xlsm,.csv,.txt,.tsv" hidden>
  </label>
  <div class="grid halves" style="margin-top:22px">
    <div class="card"><h3>What to include</h3>
      <p class="muted">One row per client. Only the VAT number is required, but including the client name lets us flag numbers that belong to a different business.</p>
      <div class="table-wrap"><table><thead><tr><th>Client ref</th><th>Client name</th><th>VAT number</th></tr></thead>
      <tbody><tr><td>C1001</td><td>Northgate Engineering Ltd</td><td>GB 123 4567 82</td></tr><tr><td>C1002</td><td>Harbourline Logistics Ltd</td><td>234567847</td></tr></tbody></table></div>
    </div>
    <div class="card"><h3>What you'll get</h3>
      <ul style="margin:0;padding-left:18px;line-height:1.9">
        <li>HMRC-confirmed registered name and address for each number</li>
        <li>Automatic name-match scoring against your records</li>
        <li>An exceptions list to review, accept or query</li>
        <li>A downloadable evidence pack with file fingerprints and the audit trail</li>
      </ul>
      <p style="margin-top:12px"><a href="/samples/sample-clients.csv" download>Try it with a sample file</a></p>
    </div>
  </div>`;
  const drop = $('#drop');
  const input = $('#file');
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0]));
  input.addEventListener('change', () => input.files[0] && handleFile(input.files[0]));
}
async function handleFile(file) {
  if (!user && !config.ssoUser) { askUser(true); return; }
  $('#drop').innerHTML = `<div class="icon">⏳</div><h2>Reading ${esc(file.name)}…</h2>`;
  try {
    upload = await api('/api/uploads', { method: 'POST', body: file, headers: { 'x-filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' } });
    upload.batchName = file.name.replace(/\.[^.]+$/, '');
    renderMappingStep();
  } catch (e) {
    toast(e.message, true);
    renderUploadStep();
  }
}
function renderMappingStep() {
  const u = upload;
  const opt = (sel, allowNone) => `${allowNone ? '<option value="">— Not in file —</option>' : ''}${u.headers.map((h, i) => `<option value="${i}" ${String(sel) === String(i) ? 'selected' : ''}>${esc(h)}</option>`).join('')}`;
  main.innerHTML = `
  <div class="page-head"><div><h1>Confirm your columns</h1><p>${esc(u.filename)}${u.sheetName ? ` · sheet “${esc(u.sheetName)}”` : ''} · ${fmtN(u.rowCount)} rows</p></div>
    <button class="btn" id="restart">← Choose a different file</button></div>
  ${stepper(1)}
  <div class="grid two">
    <div class="card">
      <div class="grid halves">
        <label class="field"><span>VAT number column *</span><select id="mVrn">${opt(u.mapping.vrn, false)}</select></label>
        <label class="field"><span>Client name column <em class="muted">(recommended)</em></span><select id="mName">${opt(u.mapping.clientName ?? '', true)}</select></label>
        <label class="field"><span>Client reference column</span><select id="mRef">${opt(u.mapping.clientRef ?? '', true)}</select></label>
        <label class="field"><span>Batch name</span><input id="bName" value="${esc(u.batchName)}" maxlength="120"></label>
      </div>
      <h3 style="margin-top:22px">Preview</h3>
      <div class="table-wrap" style="max-height:360px" id="preview"></div>
    </div>
    <div class="card" id="summary"></div>
  </div>`;
  $('#restart').onclick = () => { upload = null; renderUploadStep(); };
  ['mVrn', 'mName', 'mRef'].forEach((id) => $(`#${id}`).addEventListener('change', updateMapping));
  updateMapping();
}
function updateMapping() {
  const u = upload;
  const m = { vrn: $('#mVrn').value, clientName: $('#mName').value, clientRef: $('#mRef').value };
  const cols = { [m.vrn]: 'vat', [m.clientName]: 'name', [m.clientRef]: 'ref' };
  $('#preview').innerHTML = `<table><thead><tr>${u.headers.map((h, i) => `<th class="${cols[i] ? 'mapped' : ''}">${esc(h)}${cols[i] ? ` <span class="pill info">${cols[i]}</span>` : ''}</th>`).join('')}</tr></thead>
    <tbody>${u.preview.slice(0, 12).map((r) => `<tr>${r.map((c, i) => `<td class="${cols[i] ? 'mapped' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const seen = new Set();
  let ok = 0; let bad = 0; let dup = 0;
  u.preview.forEach((r) => {
    const v = quickVrn(r[m.vrn]);
    if (!v) bad++; else if (seen.has(v)) dup++; else { seen.add(v); ok++; }
  });
  const sampled = u.preview.length < u.rowCount;
  const calls = Math.round((ok / Math.max(1, u.preview.length)) * u.rowCount);
  const secs = Math.ceil(calls / (config.mode === 'simulation' ? 8 : config.maxRps));
  $('#summary').innerHTML = `
    <h2>Ready to check</h2>
    <p class="muted">${sampled ? `Based on the first ${fmtN(u.preview.length)} rows.` : 'Pre-flight check of your file.'}</p>
    <div class="hbar"><span><span class="pill good">✓</span> Valid format</span><div class="track"><div class="fill" style="width:${pct(ok, u.preview.length)}%;background:var(--chart-good)"></div></div><span class="v">${fmtN(ok)}</span></div>
    <div class="hbar"><span><span class="pill bad">✕</span> Invalid format</span><div class="track"><div class="fill" style="width:${pct(bad, u.preview.length)}%;background:var(--chart-bad)"></div></div><span class="v">${fmtN(bad)}</span></div>
    <div class="hbar"><span><span class="pill neutral">=</span> Duplicates</span><div class="track"><div class="fill" style="width:${pct(dup, u.preview.length)}%;background:var(--chart-neutral)"></div></div><span class="v">${fmtN(dup)}</span></div>
    <p class="muted" style="margin-top:14px;font-size:.86rem">Invalid numbers are flagged without being sent to HMRC. Duplicates are checked once and the result is reused.</p>
    ${!m.clientName ? '<p class="pill warn" style="white-space:normal">Without a client name column we can\'t detect numbers that belong to a different business.</p>' : ''}
    <dl class="kv" style="grid-template-columns:140px 1fr">
      <dt>Sent to</dt><dd>${esc(config.modeLabel)}${config.mode === 'simulation' ? ' <span class="pill warn">not real data</span>' : ''}</dd>
      <dt>Estimated time</dt><dd>${secs < 60 ? `~${secs} seconds` : `~${Math.ceil(secs / 60)} minutes`}</dd>
      <dt>File fingerprint</dt><dd class="hash">${esc(u.sha256)}</dd>
    </dl>
    <button class="btn primary" id="run" style="width:100%;margin-top:18px;padding:14px">Run ${fmtN(u.rowCount)} checks →</button>`;
  $('#run').onclick = async () => {
    $('#run').disabled = true;
    try {
      const b = await api('/api/batches', { method: 'POST', json: { uploadId: u.uploadId, name: $('#bName').value, mapping: { vrn: Number(m.vrn), clientName: m.clientName === '' ? null : Number(m.clientName), clientRef: m.clientRef === '' ? null : Number(m.clientRef) } } });
      upload = null;
      location.hash = `#/batch/${b.id}`;
    } catch (e) { toast(e.message, true); $('#run').disabled = false; }
  };
}

// ---------------------------------------------------------------- views: batch detail
async function viewBatch(id) {
  let filter = 'all';
  let q = '';
  let data;
  const load = async () => { data = await api(`/api/batches/${encodeURIComponent(id)}`); };
  await load();

  const counts = (cs) => ({
    all: cs.length,
    attention: cs.filter((c) => c.needs_attention).length,
    registered: cs.filter((c) => c.status === 'registered' && !['mismatch', 'partial'].includes(c.name_level)).length,
    name: cs.filter((c) => ['mismatch', 'partial'].includes(c.name_level)).length,
    not_registered: cs.filter((c) => c.status === 'not_registered').length,
    invalid: cs.filter((c) => c.status === 'invalid_format').length,
    error: cs.filter((c) => c.status === 'error').length,
    reviewed: cs.filter((c) => c.review_status).length,
  });
  const match = (c) => {
    if (q) {
      const hay = `${c.client_ref} ${c.client_name} ${c.vrn} ${c.input_vrn} ${c.hmrc_name} ${c.consultation_number}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    switch (filter) {
      case 'attention': return c.needs_attention;
      case 'registered': return c.status === 'registered' && !['mismatch', 'partial'].includes(c.name_level);
      case 'name': return ['mismatch', 'partial'].includes(c.name_level);
      case 'not_registered': return c.status === 'not_registered';
      case 'invalid': return c.status === 'invalid_format';
      case 'error': return c.status === 'error';
      case 'reviewed': return !!c.review_status;
      default: return true;
    }
  };

  function render() {
    const b = data;
    const done = b.total - (b.pending || 0);
    const running = b.status !== 'completed';
    const n = counts(b.checks);
    const C = 2 * Math.PI * 50;
    const chips = [['all', 'All'], ['attention', 'Needs review'], ['registered', 'Registered'], ['name', 'Name differs'], ['not_registered', 'Not registered'], ['invalid', 'Invalid format'], ['error', 'Failed'], ['reviewed', 'Reviewed']];
    const rows = b.checks.filter(match);
    main.innerHTML = `
    <div class="page-head"><div><h1>${esc(b.name)}</h1><p>${esc(b.id)} · uploaded by ${esc(b.created_by)} · ${fmtDate(b.created_at)}</p></div>
      <div class="toolbar no-print" style="margin:0">
        ${b.errors ? '<button class="btn warn" id="retry">↻ Retry failed</button>' : ''}
        <a class="btn" href="${dl(`/api/batches/${b.id}/export.csv`)}">⬇ CSV</a>
        <a class="btn primary" href="${dl(`/api/batches/${b.id}/evidence.xlsx`)}">⬇ Evidence pack</a>
        <button class="btn" id="printBtn">🖨 Print</button>
      </div></div>
    ${stepper(running ? 2 : 3)}
    <div class="grid two" style="margin-bottom:18px">
      <div class="card run-panel">
        <svg class="ring" viewBox="0 0 120 120" role="img" aria-label="${pct(done, b.total)}% complete"><circle class="track" cx="60" cy="60" r="50"/><circle class="bar" cx="60" cy="60" r="50" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - done / (b.total || 1))}" ${running ? '' : 'style="stroke:var(--good)"'}/><text x="60" y="68" text-anchor="middle">${pct(done, b.total)}%</text></svg>
        <div style="min-width:0">
          <h2 style="margin-bottom:4px">${running ? `Checking with ${esc(config.modeLabel)}…` : 'All checks complete'}</h2>
          <p class="muted" style="margin-bottom:12px">${fmtN(done)} of ${fmtN(b.total)} rows processed${running ? ' — you can leave this page; checks continue in the background.' : ` · finished ${fmtDate(b.completed_at)}`}</p>
          ${stackBar(outcomeParts({ registered: b.registered, name_mismatch: b.name_mismatch, name_partial: b.checks.filter((c) => c.name_level === 'partial').length, not_registered: b.not_registered, invalid_format: b.invalid_format, errors: b.errors, pending: b.pending }), b.total)}
        </div>
      </div>
      <div class="card">
        <h3>Evidence</h3>
        <dl class="kv" style="grid-template-columns:150px 1fr;margin-top:6px;font-size:.84rem">
          <dt>Source file</dt><dd>${esc(b.source_filename)}</dd>
          <dt>File SHA-256</dt><dd class="hash">${esc(b.file_sha256)}</dd>
          <dt>Checked against</dt><dd>${b.mode === 'simulation' ? '<span class="pill warn">Simulation – not HMRC</span>' : `HMRC API v2.0 (${esc(b.mode)})`}</dd>
          <dt>Consultation nos.</dt><dd>${b.requester_vrn ? `Requested as GB${esc(b.requester_vrn)}` : '<span class="muted">Not configured</span>'}</dd>
          <dt>Results SHA-256</dt><dd class="hash">${esc(b.results_sha256 || 'Available when complete')}</dd>
          <dt>Review progress</dt><dd>${n.attention ? `<span class="pill warn">● ${fmtN(n.attention)} awaiting review</span>` : '<span class="pill good">✓ All exceptions reviewed</span>'}</dd>
        </dl>
      </div>
    </div>
    <div class="card">
      <div class="toolbar">
        <div class="chips" role="group" aria-label="Filter results">${chips.map(([k, l]) => `<button class="chip ${filter === k ? 'on' : ''}" data-f="${k}" aria-pressed="${filter === k}">${l}<span class="n">${fmtN(n[k])}</span></button>`).join('')}</div>
        <span class="spacer"></span>
        <input class="search" id="q" type="search" placeholder="Search name, VAT no, ref…" value="${esc(q)}" aria-label="Search results">
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th class="num">Row</th><th>Client</th><th>VAT number</th><th>Outcome</th><th>HMRC registered name</th><th class="num">Name score</th><th>Review</th></tr></thead>
        <tbody>${rows.slice(0, 1000).map((c) => `<tr class="clickable" data-check="${c.id}" tabindex="0">
          <td class="num">${c.row_number}</td>
          <td><strong>${esc(c.client_name || '—')}</strong><span class="cell-sub">${esc(c.client_ref || '')}</span></td>
          <td class="mono">${esc(c.vrn ? fmtVrn(c.vrn) : c.input_vrn || '—')}${c.duplicate_of_row ? `<span class="cell-sub">Duplicate of row ${c.duplicate_of_row}</span>` : ''}</td>
          <td>${pill(c)}${c.format_reason ? `<span class="cell-sub">${esc(c.format_reason)}</span>` : ''}${c.status === 'error' && c.message ? `<span class="cell-sub">${esc(c.message)}</span>` : ''}</td>
          <td>${esc(c.hmrc_name || '')}${c.hmrc_address ? `<span class="cell-sub">${esc(c.hmrc_address.postcode || '')}</span>` : ''}</td>
          <td class="num">${c.name_score ?? '—'}</td>
          <td>${reviewPill(c)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No rows match this filter.</td></tr>'}</tbody>
      </table></div>
      ${rows.length > 1000 ? `<p class="muted" style="margin-top:10px">Showing first 1,000 of ${fmtN(rows.length)} — use search or the CSV export for the rest.</p>` : ''}
    </div>`;
    $$('[data-f]').forEach((el) => el.addEventListener('click', () => { filter = el.dataset.f; render(); }));
    const qi = $('#q');
    qi.addEventListener('input', () => { q = qi.value; const pos = qi.selectionStart; render(); const n2 = $('#q'); n2.focus(); n2.setSelectionRange(pos, pos); });
    $('#printBtn').onclick = () => window.print();
    if ($('#retry')) $('#retry').onclick = async () => { const r = await api(`/api/batches/${b.id}/retry`, { method: 'POST' }); toast(`Retrying ${r.retried} failed check(s)`); await load(); render(); };
    bindAttention(main, async () => { await load(); render(); });
  }
  render();

  let pendingRefresh = null;
  const handler = (e) => {
    if (e.id !== id || pendingRefresh) return;
    pendingRefresh = setTimeout(async () => {
      pendingRefresh = null;
      if (!$('#drawer').hidden || document.activeElement?.id === 'q') return; // don't disrupt the user
      await load(); render();
    }, 700);
  };
  sseHandlers.add(handler);
  current.cleanup = () => { sseHandlers.delete(handler); clearTimeout(pendingRefresh); };
}

// ---------------------------------------------------------------- check drawer
async function openCheck(id, onChange) {
  const c = await api(`/api/checks/${id}`);
  const o = outcome(c);
  $('#drawerBody').innerHTML = `
    <p class="muted" style="margin:0 0 4px">${c.batch_id ? `Row ${c.row_number} · ${esc(c.batch_id)}` : 'Quick check'}</p>
    <h2 id="drawerTitle">${esc(c.client_name || fmtVrn(c.vrn) || c.input_vrn)}</h2>
    <div class="result ${o.cls === 'neutral' || o.cls === 'info' ? '' : o.cls}" style="margin:14px 0">
      <div class="big"><span class="seal" aria-hidden="true">${o.icon}</span>${esc(o.label)}</div>
      ${guidance(c)}
    </div>
    <dl class="kv" style="grid-template-columns:170px 1fr">
      <dt>VAT number supplied</dt><dd class="mono">${esc(c.input_vrn || '—')}</dd>
      <dt>Checked as</dt><dd class="mono">${esc(c.vrn ? fmtVrn(c.vrn) : '—')}</dd>
      <dt>Client name (ours)</dt><dd>${esc(c.client_name || '—')}</dd>
      <dt>HMRC registered name</dt><dd><strong>${esc(c.hmrc_name || '—')}</strong></dd>
      <dt>Name match</dt><dd>${c.name_score != null ? `${c.name_score}/100 (${esc(c.name_level)})` : esc(c.name_level === 'not_provided' ? 'No client name supplied' : '—')}</dd>
      <dt>HMRC address</dt><dd>${esc(addr(c.hmrc_address) || '—')}</dd>
      <dt>Consultation number</dt><dd class="mono">${esc(c.consultation_number || '—')}</dd>
      <dt>HMRC processing date</dt><dd>${fmtDate(c.processing_date)}</dd>
      <dt>Checked</dt><dd>${fmtDate(c.checked_at)} by ${esc(c.checked_by || '—')} · ${esc(c.source || '')}${c.attempts > 1 ? ` · ${c.attempts} attempts` : ''}</dd>
      ${c.format_reason || c.message ? `<dt>Notes</dt><dd>${esc(c.format_reason || c.message)}</dd>` : ''}
    </dl>
    <section class="card" style="margin-top:20px;box-shadow:none;background:var(--surface-2)">
      <h3>Specialist review</h3>
      ${c.review_status ? `<p>${c.review_status === 'accepted' ? '✓ Accepted' : '? Query raised'} by <strong>${esc(c.reviewed_by)}</strong> on ${fmtDate(c.reviewed_at)}${c.review_note ? `<br><em>“${esc(c.review_note)}”</em>` : ''}</p>` : '<p class="muted">Record your conclusion — this is written to the audit log.</p>'}
      <label class="field"><span>Note</span><textarea id="rvNote" rows="2" placeholder="e.g. Trading name confirmed with client; matches Companies House">${esc(c.review_note || '')}</textarea></label>
      <div class="toolbar" style="margin:12px 0 0">
        <button class="btn good small" data-rv="accepted">✓ Accept</button>
        <button class="btn warn small" data-rv="query">? Query with client</button>
        ${c.review_status ? '<button class="btn small" data-rv="">Clear review</button>' : ''}
      </div>
    </section>
    <h3 style="margin-top:22px">History</h3>
    <ul class="timeline">${(c.history || []).map((h) => `<li><strong>${esc(h.action)}</strong> · ${esc(h.actor)}<span class="cell-sub">${fmtDate(h.ts)} · audit #${h.seq}</span></li>`).join('') || '<li class="muted">No events</li>'}</ul>
    ${c.raw_response ? `<details style="margin-top:12px"><summary>Raw HMRC response</summary><pre class="json">${esc(JSON.stringify(c.raw_response, null, 2))}</pre></details>` : ''}`;
  $$('[data-rv]', $('#drawerBody')).forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/checks/${id}/review`, { method: 'POST', json: { status: b.dataset.rv || null, note: $('#rvNote').value } });
      toast(b.dataset.rv ? 'Review recorded in the audit log' : 'Review cleared');
      closeDrawer();
      if (onChange) onChange(); else route();
    } catch (e) { toast(e.message, true); }
  }));
  const d = $('#drawer');
  d.hidden = false;
  d.setAttribute('aria-hidden', 'false');
  $('.drawer-close').focus();
}
function guidance(c) {
  const g = {
    registered: c.name_level === 'mismatch' ? 'HMRC holds this number for a <strong>different business name</strong>. Confirm the correct VAT number with the client before relying on it.'
      : c.name_level === 'partial' ? 'The number is registered, but the HMRC name differs from ours — often a trading name vs legal name. Review and accept if appropriate.'
        : 'HMRC confirms this VAT number is registered.',
    not_registered: 'HMRC does not hold a current registration for this number. It may be mistyped, deregistered, or never issued.',
    invalid_format: 'This is not a valid UK VAT number format, so it was not sent to HMRC. Check the source data.',
    error: 'The check could not be completed (HMRC unavailable or rate-limited). Use “Retry failed” on the batch.',
  }[c.status];
  return g ? `<p style="margin:10px 0 0;color:var(--text-2)">${g}</p>` : '';
}
function closeDrawer() { const d = $('#drawer'); d.hidden = true; d.setAttribute('aria-hidden', 'true'); }
$('#drawer').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ---------------------------------------------------------------- views: quick check
async function viewQuick() {
  const recent = await api('/api/checks/recent');
  main.innerHTML = `
  <div class="page-head"><div><h1>Quick check</h1><p>Check a single VAT number with HMRC.</p></div></div>
  <div class="grid two">
    <div>
      <form class="card" id="qform">
        <label class="field"><span>VAT registration number</span><input id="qVrn" class="input-xl" required placeholder="GB 123 4567 82" autocomplete="off" inputmode="text"></label>
        <p id="qHint" class="muted" style="font-size:.85rem;min-height:1.4em;margin:6px 0 12px"></p>
        <div class="grid halves">
          <label class="field"><span>Client name <em class="muted">(to compare)</em></span><input id="qName" placeholder="Optional"></label>
          <label class="field"><span>Client reference</span><input id="qRef" placeholder="Optional"></label>
        </div>
        <button class="btn primary" style="margin-top:18px;padding:12px 24px">Check with ${esc(config.modeLabel)} →</button>
      </form>
      <div id="qResult" style="margin-top:18px"></div>
    </div>
    <div class="card"><div class="card-head"><h3>Your recent quick checks</h3></div>
      ${recent.length ? recent.map(attentionItem).join('') : '<div class="empty">No quick checks yet</div>'}</div>
  </div>`;
  bindAttention();
  const vi = $('#qVrn');
  vi.addEventListener('input', () => {
    const v = quickVrn(vi.value);
    $('#qHint').innerHTML = !vi.value ? '' : v ? `<span class="pill good">✓</span> Will check ${esc(fmtVrn(v))}` : '<span class="pill neutral">…</span> UK VAT numbers have 9 digits (optionally prefixed GB)';
  });
  vi.focus();
  $('#qform').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!user && !config.ssoUser) { askUser(true); return; }
    $('#qResult').innerHTML = '<div class="card empty">Checking with HMRC…</div>';
    try {
      const c = await api('/api/check', { method: 'POST', json: { vrn: vi.value, clientName: $('#qName').value, clientRef: $('#qRef').value } });
      const o = outcome(c);
      $('#qResult').innerHTML = `<div class="result ${['good', 'bad', 'warn'].includes(o.cls) ? o.cls : ''}">
        <div class="big"><span class="seal" aria-hidden="true">${o.icon}</span>${esc(o.label)}</div>${guidance(c)}
        <dl class="kv">
          <dt>VAT number</dt><dd class="mono">${esc(c.vrn ? fmtVrn(c.vrn) : c.input_vrn)}</dd>
          ${c.hmrc_name ? `<dt>Registered name</dt><dd><strong>${esc(c.hmrc_name)}</strong></dd><dt>Address</dt><dd>${esc(addr(c.hmrc_address))}</dd>` : ''}
          ${c.name_score != null ? `<dt>Name match</dt><dd>${c.name_score}/100</dd>` : ''}
          ${c.consultation_number ? `<dt>Consultation no.</dt><dd class="mono">${esc(c.consultation_number)}</dd>` : ''}
          ${c.format_reason ? `<dt>Note</dt><dd>${esc(c.format_reason)}</dd>` : ''}
          <dt>Checked</dt><dd>${fmtDate(c.checked_at)} · ${esc(c.source || '')}</dd>
        </dl>
        <div class="toolbar" style="margin:16px 0 0"><button class="btn small" data-open="${c.id}">Review / details</button></div></div>`;
      $('[data-open]').onclick = () => openCheck(c.id, () => viewQuick());
    } catch (err) { $('#qResult').innerHTML = `<div class="card empty">${esc(err.message)}</div>`; }
  });
}

// ---------------------------------------------------------------- views: batches
async function viewBatches() {
  const list = await api('/api/batches');
  main.innerHTML = `
  <div class="page-head"><div><h1>Batches</h1><p>Every bulk upload, with its results and evidence.</p></div><a class="btn primary" href="#/bulk">⬆ New bulk check</a></div>
  <div class="card">
  <div class="table-wrap"><table>
    <thead><tr><th>Batch</th><th>Uploaded</th><th class="num">Rows</th><th>Outcome</th><th class="num">Registered</th><th class="num">Exceptions</th><th>Status</th></tr></thead>
    <tbody>${list.map((b) => `<tr class="clickable" data-href="#/batch/${esc(b.id)}" tabindex="0">
      <td><strong>${esc(b.name)}</strong><span class="cell-sub">${esc(b.id)}${b.mode === 'simulation' ? ' · simulation' : ''}</span></td>
      <td>${fmtDate(b.created_at)}<span class="cell-sub">${esc(b.created_by)}</span></td>
      <td class="num">${fmtN(b.total)}</td>
      <td style="min-width:160px"><div class="progress">${progressSegs(b)}</div></td>
      <td class="num">${pct(b.registered, b.total)}%</td>
      <td class="num">${fmtN(b.total - b.registered + b.name_mismatch)}</td>
      <td>${b.status === 'completed' ? (b.attention ? `<span class="pill warn">● ${fmtN(b.attention)} to review</span>` : '<span class="pill good">✓ Reviewed</span>') : `<span class="pill info">Running ${pct(b.total - b.pending, b.total)}%</span>`}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No batches yet</td></tr>'}</tbody>
  </table></div></div>`;
  $$('[data-href]').forEach((r) => {
    r.addEventListener('click', () => { location.hash = r.dataset.href; });
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = r.dataset.href; });
  });
}

// ---------------------------------------------------------------- views: insights
async function viewInsights() {
  const ins = await api('/api/insights');
  const t = ins.totals;
  const exceptions = (t.not_registered || 0) + (t.invalid_format || 0) + (t.name_mismatch || 0) + (t.name_partial || 0) + (t.errors || 0);
  const reviewed = (t.accepted || 0) + (t.queried || 0);
  main.innerHTML = `
  <div class="page-head"><div><h1>Insights</h1><p>How our client VAT data is holding up, and where the team's attention is needed.</p></div></div>
  <div class="grid kpis">
    ${kpi('Total checks', fmtN(t.checks), `${fmtN(t.unique_vrns)} unique VAT numbers`)}
    ${kpi('Registration rate', `${pct(t.registered, t.checks)}%`, `${fmtN(t.registered)} registered with HMRC`, 'good')}
    ${kpi('Data quality issues', fmtN(exceptions), `${pct(exceptions, t.checks)}% of checks`, exceptions ? 'bad' : '')}
    ${kpi('Exceptions reviewed', `${pct(reviewed, reviewed + (t.attention || 0))}%`, `${fmtN(t.attention)} still open`, t.attention ? 'warn' : 'good')}
    ${kpi('HMRC consultation nos.', fmtN(t.with_consultation), config.requesterVrn ? 'Evidence references held' : 'Set requester VRN to enable')}
    ${kpi('Time saved (est.)', hrs(t.checks), `${ins.secsPerRow ? `${ins.secsPerRow.toFixed(1)}s` : '–'} per automated check`)}
  </div>
  <div class="grid two">
    <section class="card"><div class="card-head"><h2>Checks per day</h2><span class="muted">Last 30 days</span></div>${columnChart(ins.daily)}</section>
    <section class="card"><div class="card-head"><h2>Outcomes</h2><span class="muted">All checks</span></div>${stackBar(outcomeParts(t), t.checks)}
      <h3 style="margin-top:22px">Name matching</h3>
      ${hbars([{ label: 'Exact / strong match', n: t.name_match || 0 }, { label: 'Partial match', n: t.name_partial || 0 }, { label: 'Mismatch', n: t.name_mismatch || 0 }])}
    </section>
    <section class="card"><div class="card-head"><h2>Open exceptions</h2><span class="muted">Most recent</span></div>
      ${ins.attentionList.length ? ins.attentionList.map(attentionItem).join('') : '<div class="empty">Nothing outstanding</div>'}</section>
    <section class="card"><div class="card-head"><h2>Team activity</h2><span class="muted">Audit events by user</span></div>
      ${hbars(ins.users.map((u) => ({ label: u.actor, n: u.n })))}
      <h3 style="margin-top:22px">Review outcomes</h3>
      ${hbars([{ label: 'Accepted', n: t.accepted || 0 }, { label: 'Queried with client', n: t.queried || 0 }, { label: 'Awaiting review', n: t.attention || 0 }])}
    </section>
  </div>`;
  bindAttention(main, () => viewInsights());
}

// ---------------------------------------------------------------- views: audit
async function viewAudit() {
  let events = [];
  let filters = { q: '', action: '' };
  main.innerHTML = `
  <div class="page-head"><div><h1>Audit log</h1><p>Every upload, HMRC check, review and export — append-only and cryptographically chained.</p></div>
    <a class="btn" id="exp" href="#">⬇ Export CSV</a></div>
  <div class="integrity" id="integ"><div class="seal">🔒</div><div style="flex:1"><strong>Integrity not yet verified this session</strong><div class="muted" style="font-size:.86rem">Re-computes the hash chain over every event to prove nothing has been altered or removed.</div></div><button class="btn primary" id="verify">Verify integrity</button></div>
  <div class="card">
    <div class="toolbar">
      <input type="search" class="search" id="aq" placeholder="Search VAT no, batch, user…" aria-label="Search audit log">
      <select id="aa" style="max-width:220px" aria-label="Filter by action">
        <option value="">All actions</option><option value="hmrc.">HMRC checks</option><option value="batch.">Batches</option><option value="file.">File uploads</option>
        <option value="review.">Reviews</option><option value="export.">Exports</option><option value="audit.">Integrity checks</option><option value="check.">Format failures</option>
      </select>
      <span class="spacer"></span><span class="muted" id="acount"></span>
    </div>
    <div class="table-wrap"><table><thead><tr><th class="num">#</th><th>When (UTC)</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th><th>Hash</th></tr></thead><tbody id="arows"></tbody></table></div>
    <div style="text-align:center;margin-top:14px"><button class="btn" id="more" hidden>Load older events</button></div>
  </div>`;
  const summary = (e) => {
    const d = e.details || {};
    if (e.action.startsWith('hmrc.')) return `VRN ${esc(d.vrn)} → HTTP ${esc(d.http_status)}${d.hmrc_name ? ` · ${esc(d.hmrc_name)}` : ''}${d.consultation_number ? ` · <span class="mono">${esc(d.consultation_number)}</span>` : ''}${d.batch_id ? ` · row ${esc(d.row)}` : ''}`;
    if (e.action === 'batch.created') return `${esc(d.name)} · ${fmtN(d.rows)} rows · file <span class="hash">${esc(String(d.file_sha256).slice(0, 16))}…</span>`;
    if (e.action === 'batch.completed') return `${fmtN(d.registered)} registered · ${fmtN(d.not_registered)} not registered · ${fmtN(d.errors)} failed`;
    if (e.action === 'file.uploaded') return `${esc(d.filename)} · ${fmtN(d.rows)} rows`;
    if (e.action.startsWith('review.')) return `VRN ${esc(d.vrn)}${d.note ? ` · “${esc(d.note)}”` : ''}`;
    return esc(Object.entries(d).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => `${k}: ${v}`).join(' · '));
  };
  const paint = () => {
    $('#arows').innerHTML = events.map((e) => `<tr><td class="num">${e.seq}</td><td style="white-space:nowrap">${esc(e.ts.replace('T', ' ').slice(0, 19))}</td><td>${esc(e.actor)}</td>
      <td><span class="action-tag">${esc(e.action)}</span></td><td>${e.entity_type === 'batch' ? `<a href="#/batch/${esc(e.entity_id)}">${esc(e.entity_id)}</a>` : e.entity_type === 'check' ? `<a href="#" data-check="${esc(e.entity_id)}">check ${esc(e.entity_id)}</a>` : esc(e.entity_type || '')}</td>
      <td style="max-width:420px">${summary(e)}</td><td class="hash" title="${esc(e.hash)}">${esc(e.hash.slice(0, 12))}…</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No events</td></tr>';
    $('#acount').textContent = `${fmtN(events.length)} events shown`;
    $$('a[data-check]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); openCheck(Number(a.dataset.check)); }));
  };
  const qs = (extra = {}) => new URLSearchParams(Object.fromEntries(Object.entries({ ...filters, ...extra }).filter(([, v]) => v))).toString();
  const load = async (append) => {
    const page = await api(`/api/audit?${qs({ limit: 200, before: append && events.length ? events[events.length - 1].seq : '' })}`);
    events = append ? events.concat(page) : page;
    $('#more').hidden = page.length < 200;
    paint();
    $('#exp').href = dl(`/api/audit/export.csv?${qs()}`);
  };
  let deb;
  $('#aq').addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => { filters.q = $('#aq').value; load(); }, 250); });
  $('#aa').addEventListener('change', () => { filters.action = $('#aa').value; load(); });
  $('#more').onclick = () => load(true);
  $('#verify').onclick = async () => {
    const v = await api('/api/audit/verify');
    const el = $('#integ');
    el.className = `integrity ${v.ok ? 'ok' : 'fail'}`;
    el.innerHTML = v.ok
      ? `<div class="seal">✓</div><div style="flex:1"><strong>Audit trail verified intact</strong><div style="font-size:.86rem">${fmtN(v.count)} events checked at ${fmtDate(v.verifiedAt)}. Chain head: <span class="hash">${esc(v.headHash)}</span></div></div>`
      : `<div class="seal">!</div><div style="flex:1"><strong>Integrity check failed</strong><div style="font-size:.86rem">${esc(v.reason)} — escalate to IT/Risk immediately.</div></div>`;
    load();
  };
  await load();
}

// ---------------------------------------------------------------- views: help
async function viewHelp() {
  main.innerHTML = `
  <div class="page-head"><div><h1>Help &amp; setup</h1><p>How the checker works and how it connects to HMRC.</p></div></div>
  <div class="grid halves">
    <section class="card"><h2>Connection</h2>
      <dl class="kv" style="grid-template-columns:170px 1fr">
        <dt>Mode</dt><dd><span class="mode-badge ${modeClass()}" style="color:inherit">${esc(config.modeLabel)}</span></dd>
        <dt>Requester VRN</dt><dd>${config.requesterVrn ? `GB${esc(config.requesterVrn)} — consultation numbers are requested` : 'Not set — add HMRC_REQUESTER_VRN to receive consultation numbers'}</dd>
        <dt>Rate limit</dt><dd>${esc(config.maxRps)} requests / second</dd>
      </dl>
      <h3 style="margin-top:20px">Connecting to HMRC</h3>
      <ol class="steps-help">
        <li>Register on the <a href="https://developer.service.hmrc.gov.uk/" target="_blank" rel="noopener">HMRC Developer Hub</a> and create a sandbox application.</li>
        <li>Subscribe the application to <strong>Check a UK VAT number</strong> (v2.0).</li>
        <li>Put the client ID and secret in the server's <code>.env</code> with <code>HMRC_MODE=sandbox</code>, and restart.</li>
        <li>When testing is signed off, request production credentials and switch to <code>HMRC_MODE=production</code>.</li>
      </ol>
    </section>
    <section class="card"><h2>Reading the results</h2>
      <p>${pill({ status: 'registered' })} HMRC confirms the number is registered and the name agrees with ours.</p>
      <p>${pill({ status: 'registered', name_level: 'partial' })} Registered, but the name differs — often a trading name. Review and accept.</p>
      <p>${pill({ status: 'registered', name_level: 'mismatch' })} Registered to a different business. Confirm with the client.</p>
      <p>${pill({ status: 'not_registered' })} HMRC holds no current registration for this number.</p>
      <p>${pill({ status: 'invalid_format' })} Not a valid UK VAT number format — not sent to HMRC.</p>
      <p>${pill({ status: 'error' })} HMRC was unavailable. Use “Retry failed”.</p>
      <h3>Evidence</h3>
      <p class="muted">Each batch records the uploaded file's SHA-256 fingerprint, every HMRC response (with consultation number where configured), each reviewer's conclusion, and a fingerprint of the final results. The evidence pack bundles these with the batch's audit trail.</p>
    </section>
  </div>`;
}
const modeClass = () => (config.mode === 'simulation' ? 'sim' : config.mode);

// ---------------------------------------------------------------- boot
(async function boot() {
  try { config = await api('/api/config'); } catch { config = { mode: 'simulation', modeLabel: 'Simulation' }; }
  const mb = $('#modeBadge');
  mb.textContent = config.modeLabel;
  mb.className = `mode-badge ${modeClass()}`;
  $('#simBanner').hidden = config.mode !== 'simulation';
  renderUser();
  if (!user && !config.ssoUser) askUser(true);
  connectEvents();
  route();
}());
