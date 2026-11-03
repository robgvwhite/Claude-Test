'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('../server/index');

const SAMPLE = fs.readFileSync(path.join(__dirname, '..', 'public', 'samples', 'sample-clients.csv'));

async function withServer(fn) {
  const ctx = build({ HMRC_MODE: 'simulation', DB_PATH: ':memory:', HMRC_REQUESTER_VRN: '999999973' });
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, opts = {}) => {
    const res = await fetch(base + p, { ...opts, headers: { 'x-user-name': 'Test%20User', ...(opts.headers || {}) } });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
  try { await fn(call, ctx); } finally { server.close(); }
}

test('end-to-end bulk check in simulation mode', async () => {
  await withServer(async (call, ctx) => {
    const up = await call('/api/uploads', { method: 'POST', body: SAMPLE, headers: { 'x-filename': 'sample-clients.csv' } });
    assert.equal(up.status, 200);
    assert.equal(up.body.rowCount, 20);
    assert.deepEqual(up.body.mapping, { vrn: 2, clientName: 1, clientRef: 0 });

    const b = await call('/api/batches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: up.body.uploadId, mapping: up.body.mapping, name: 'Test batch' }) });
    assert.equal(b.status, 201);
    await ctx.service.idle;

    const detail = await call(`/api/batches/${b.body.id}`);
    const d = detail.body;
    assert.equal(d.status, 'completed');
    assert.equal(d.pending, 0);
    const byRef = Object.fromEntries(d.checks.map((c) => [c.client_ref, c]));
    assert.equal(byRef.C1001.status, 'registered');
    assert.equal(byRef.C1001.name_level, 'match');
    assert.ok(byRef.C1001.consultation_number);
    assert.equal(byRef.C1006.status, 'not_registered');
    assert.equal(byRef.C1008.name_level, 'mismatch');
    assert.equal(byRef.C1014.status, 'error');
    assert.equal(byRef.C1017.duplicate_of_row, 3);
    assert.equal(byRef.C1017.status, 'registered');
    assert.equal(byRef.C1018.status, 'invalid_format');
    assert.ok(d.results_sha256);

    // Review an exception and confirm it is attributed.
    const rv = await call(`/api/checks/${byRef.C1008.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'query', note: 'Asked client' }) });
    assert.equal(rv.body.reviewed_by, 'Test User');

    const csv = await call(`/api/batches/${d.id}/export.csv`);
    assert.match(csv.body, /HMRC consultation number/);

    const v = await call('/api/audit/verify');
    assert.equal(v.body.ok, true);
    const events = await call('/api/audit?limit=500');
    const actions = events.body.map((e) => e.action);
    for (const a of ['file.uploaded', 'batch.created', 'hmrc.registered', 'hmrc.not_registered', 'batch.completed', 'review.query', 'export.csv']) {
      assert.ok(actions.includes(a), `missing ${a}`);
    }
    const ins = await call('/api/insights');
    assert.equal(ins.body.totals.checks, 20);
  });
});

test('evidence pack downloads as xlsx', async () => {
  await withServer(async (call, ctx) => {
    const up = await call('/api/uploads', { method: 'POST', body: SAMPLE, headers: { 'x-filename': 'sample.csv' } });
    const b = await call('/api/batches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: up.body.uploadId, mapping: up.body.mapping }) });
    await ctx.service.idle;
    const res = await call(`/api/batches/${b.body.id}/evidence.xlsx`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml/);
  });
});

test('quick check and user attribution', async () => {
  await withServer(async (call) => {
    const r = await call('/api/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vrn: 'GB 553 557 881', clientName: 'Credite Sberger Donal Inc' }) });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'registered');
    assert.equal(r.body.checked_by, 'Test User');
    const bad = await call('/api/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vrn: '12AB' }) });
    assert.equal(bad.body.status, 'invalid_format');
  });
});

test('mutating endpoints require a user name', async () => {
  await withServer(async (call) => {
    const r = await call('/api/check', { method: 'POST', headers: { 'x-user-name': '', 'content-type': 'application/json' }, body: JSON.stringify({ vrn: '553557881' }) });
    assert.equal(r.status, 401);
  });
});
