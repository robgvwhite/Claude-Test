'use strict';

const crypto = require('node:crypto');
const ExcelJS = require('exceljs');

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLine) if (ch in counts) counts[ch]++;
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ',';

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ('result' in v) return cellText(v.result);
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('hyperlink' in v) return String(v.hyperlink);
    return '';
  }
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v);
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets.find((ws) => ws.actualRowCount > 0) || wb.worksheets[0];
  if (!sheet) return { rows: [], sheetName: null };
  const rows = [];
  const width = sheet.actualColumnCount || sheet.columnCount;
  sheet.eachRow({ includeEmpty: false }, (r) => {
    const out = [];
    for (let c = 1; c <= width; c++) out.push(cellText(r.getCell(c).value).trim());
    rows.push(out);
  });
  return { rows, sheetName: sheet.name };
}

/** Returns { headers, rows, sha256, sheetName } with blank rows removed. */
async function parseUpload(buffer, filename) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const lower = String(filename || '').toLowerCase();
  let rows;
  let sheetName = null;
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    ({ rows, sheetName } = await parseXlsx(buffer));
  } else if (lower.endsWith('.csv') || lower.endsWith('.txt') || lower.endsWith('.tsv')) {
    rows = parseCsv(buffer.toString('utf8'));
  } else if (lower.endsWith('.xls')) {
    throw new Error('Legacy .xls files are not supported — please save as .xlsx or .csv');
  } else {
    throw new Error('Unsupported file type — upload a .xlsx or .csv file');
  }
  rows = rows.map((r) => r.map((c) => String(c ?? '').trim())).filter((r) => r.some((c) => c !== ''));
  if (!rows.length) throw new Error('The file appears to be empty');
  const width = Math.max(...rows.map((r) => r.length));
  const headers = rows[0].map((h, i) => h || `Column ${i + 1}`);
  while (headers.length < width) headers.push(`Column ${headers.length + 1}`);
  return { headers, rows: rows.slice(1).map((r) => headers.map((_, i) => r[i] ?? '')), sha256, sheetName };
}

/** Guess which columns hold the client reference, name and VAT number. */
function guessMapping(headers, rows) {
  const h = headers.map((x) => x.toLowerCase());
  const find = (...pats) => {
    const i = h.findIndex((x) => pats.some((p) => p.test(x)));
    return i >= 0 ? i : null;
  };
  let vrn = find(/\bvat\b.*(no|num|reg|id)/, /\bvrn\b/, /^vat$/, /vat/);
  if (vrn == null) {
    // Fall back to the column where most values look like VRNs.
    let best = -1;
    headers.forEach((_, i) => {
      const hits = rows.slice(0, 50).filter((r) => /^(GB|XI)?\s?\d{3}\s?\d{4}\s?\d{2}(\d{3})?$/i.test(r[i] || '')).length;
      if (hits > best) { best = hits; vrn = hits > 0 ? i : vrn; }
    });
  }
  const ref = find(/client.*(ref|code|id|no)/, /^ref/, /reference/, /account/, /^code$/, /^id$/);
  const name = find(/client.*name/, /company.*name/, /business.*name/, /entity/, /legal.*name/, /^name$/, /name/);
  return { vrn, clientRef: ref === vrn ? null : ref, clientName: name === vrn ? null : name };
}

module.exports = { parseUpload, parseCsv, guessMapping };
