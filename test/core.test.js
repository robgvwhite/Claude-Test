'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseVrn, checksumValid, makeVrn } = require('../server/vrn');
const { compareNames } = require('../server/nameMatch');
const { parseCsv, guessMapping } = require('../server/fileParser');
const db = require('../server/db');
const { AuditLog } = require('../server/audit');
const { HmrcClient, RateLimiter } = require('../server/hmrcClient');

test('normaliseVrn handles common formats', () => {
  const v = makeVrn('1234567');
  assert.equal(normaliseVrn(`GB ${v.slice(0, 3)} ${v.slice(3, 7)} ${v.slice(7)}`).vrn, v);
  assert.equal(normaliseVrn(`gb${v}`).vrn, v);
  assert.equal(normaliseVrn(`${v}.0`).vrn, v);
  assert.equal(normaliseVrn(`XI${v}`).prefix, 'XI');
  const branch = normaliseVrn(`${v}001`);
  assert.equal(branch.vrn, v);
  assert.equal(branch.branch, '001');
  assert.equal(normaliseVrn(v).checksumOk, true);
});

test('normaliseVrn rejects bad input but only warns on check digits', () => {
  assert.equal(normaliseVrn('').valid, false);
  assert.equal(normaliseVrn('12345678').valid, false);
  assert.equal(normaliseVrn('ABC123456').valid, false);
  assert.equal(normaliseVrn('GD123').valid, false);
  const r = normaliseVrn('123456789');
  assert.equal(r.valid, true);
  assert.equal(r.checksumOk, false);
  assert.match(r.warning, /check-digit/);
});

test('checksum supports both mod-97 schemes', () => {
  assert.equal(checksumValid(makeVrn('7654321')), true);
  // 9755 scheme example: weighted sum + 55 + check ≡ 0 (mod 97)
  const stem = '1000000';
  let sum = 8;
  const check = (97 - ((sum + 55) % 97)) % 97;
  assert.equal(checksumValid(stem + String(check).padStart(2, '0')), true);
});

test('compareNames scores legal/trading name variants sensibly', () => {
  assert.equal(compareNames('Acme Widgets Ltd', 'ACME WIDGETS LIMITED').level, 'match');
  assert.equal(compareNames('Bramble & Finch Interiors', 'Bramble and Finch Interiors Limited').level, 'match');
  assert.notEqual(compareNames('Silverbirch Software Ltd', 'Silverbirch Software (UK) Ltd').level, 'mismatch');
  assert.equal(compareNames('Sterling Accountancy Services Ltd', 'Sterling Vending Machines Ltd').level, 'mismatch');
  assert.equal(compareNames('', 'Anything').level, 'not_provided');
});

test('parseCsv handles quotes, BOM and semicolons', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","q""z"\n'), [['a', 'b'], ['x, y', 'q"z']]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
});

test('guessMapping finds VAT, name and reference columns', () => {
  const m = guessMapping(['Client Ref', 'Client Name', 'VAT Registration Number'], [['C1', 'X', '123456782']]);
  assert.deepEqual(m, { vrn: 2, clientName: 1, clientRef: 0 });
  const m2 = guessMapping(['Customer', 'Number'], [['X', 'GB123456782']]);
  assert.equal(m2.vrn, 1);
});

test('audit log is hash-chained, append-only and detects tampering', () => {
  const d = db.open(':memory:');
  const a = new AuditLog(d);
  a.record('alice', 'one', 'x', 1, { a: 1 });
  a.record('bob', 'two', 'x', 2, { b: 2 });
  a.record('carol', 'three', 'x', 3, null);
  assert.equal(a.verify().ok, true);
  assert.throws(() => d.exec(`UPDATE audit_events SET actor='mallory' WHERE seq=2`), /append-only/);
  assert.throws(() => d.exec('DELETE FROM audit_events WHERE seq=2'), /append-only/);
  // Bypass the trigger (as an attacker with DB access might) and confirm detection.
  d.exec('DROP TRIGGER audit_no_update');
  d.exec(`UPDATE audit_events SET details='{"b":3}' WHERE seq=2`);
  const v = a.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
});

test('rate limiter spaces requests', async () => {
  let t = 0;
  const waits = [];
  const rl = new RateLimiter(4, () => t, async (ms) => { waits.push(ms); t += ms; });
  for (let i = 0; i < 4; i++) await rl.take();
  assert.deepEqual(waits, [250, 250, 250]);
});

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const h = handlers.shift();
    const { status, body, headers = {} } = typeof h === 'function' ? h(url, opts) : h;
    return { status, ok: status < 300, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] } };
  };
  fn.calls = calls;
  return fn;
}
const cfg = { mode: 'sandbox', hmrcBaseUrl: 'https://hmrc.test', clientId: 'id', clientSecret: 'sec', requesterVrn: '999999973', maxRps: 1000, maxRetries: 2 };

test('HmrcClient obtains a token and parses a registered response', async () => {
  const f = fakeFetch([
    { status: 200, body: { access_token: 'tok', expires_in: 14400 } },
    { status: 200, body: { target: { name: 'Acme Ltd', vatNumber: '553557881', address: { line1: '1 Road', postcode: 'AB1 2CD', countryCode: 'GB' } }, processingDate: '2026-11-03T10:00:00Z', requester: '999999973', consultationNumber: 'ABC-DEF-GHI' } },
  ]);
  const c = new HmrcClient(cfg, { fetchImpl: f, sleep: async () => {} });
  const out = await c.lookup('553557881');
  assert.equal(out.status, 'registered');
  assert.equal(out.consultationNumber, 'ABC-DEF-GHI');
  assert.equal(f.calls[0].url, 'https://hmrc.test/oauth/token');
  assert.match(f.calls[0].opts.body, /grant_type=client_credentials/);
  assert.equal(f.calls[1].url, 'https://hmrc.test/organisations/vat/check-vat-number/lookup/553557881/999999973');
  assert.equal(f.calls[1].opts.headers.Accept, 'application/vnd.hmrc.2.0+json');
  assert.equal(f.calls[1].opts.headers.Authorization, 'Bearer tok');
});

test('HmrcClient maps 404 to not_registered and retries 429/5xx', async () => {
  const f = fakeFetch([
    { status: 200, body: { access_token: 'tok', expires_in: 14400 } },
    { status: 404, body: { code: 'NOT_FOUND', message: 'targetVrn does not match a registered company' } },
    { status: 429, body: { code: 'MESSAGE_THROTTLED_OUT' }, headers: { 'retry-after': '1' } },
    { status: 503, body: { code: 'SERVER_ERROR' } },
    { status: 200, body: { target: { name: 'B Ltd', vatNumber: '123456782' }, processingDate: 'x' } },
  ]);
  const sleeps = [];
  const c = new HmrcClient(cfg, { fetchImpl: f, sleep: async (ms) => sleeps.push(ms) });
  assert.equal((await c.lookup('553557881')).status, 'not_registered');
  const out = await c.lookup('123456782');
  assert.equal(out.status, 'registered');
  assert.equal(out.attempts, 3);
  assert.ok(sleeps.includes(1000));
});

test('HmrcClient gives up after max retries', async () => {
  const f = fakeFetch([{ status: 200, body: { access_token: 'tok' } }, { status: 500, body: {} }, { status: 500, body: {} }, { status: 500, body: {} }]);
  const c = new HmrcClient(cfg, { fetchImpl: f, sleep: async () => {} });
  const out = await c.lookup('123456782');
  assert.equal(out.status, 'error');
  assert.equal(out.attempts, 3);
});
