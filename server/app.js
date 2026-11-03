'use strict';

const path = require('node:path');
const express = require('express');
const { parseUpload, guessMapping } = require('./fileParser');
const { batchCsv, auditCsv, evidenceWorkbook, templateWorkbook } = require('./exports');
const { normaliseVrn } = require('./vrn');

function createApp({ service, audit, cfg }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'",
    });
    next();
  });

  // Identify the user. With SSO in front of the app, trust its header;
  // otherwise use the name the user enters in the UI.
  app.use('/api', (req, res, next) => {
    let user = cfg.trustedUserHeader ? req.get(cfg.trustedUserHeader) : null;
    if (!user) user = req.get('x-user-name') || (typeof req.query.user === 'string' ? req.query.user : null);
    user = user ? decodeURIComponent(String(user)).trim().slice(0, 120) : '';
    req.user = user || null;
    next();
  });
  const requireUser = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please enter your name before running checks so they can be attributed in the audit log' });
    next();
  };

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.get('/api/config', (req, res) => {
    res.json({
      mode: cfg.mode, modeLabel: cfg.modeLabel, requesterVrn: cfg.requesterVrn, maxRps: cfg.maxRps,
      ssoUser: cfg.trustedUserHeader ? req.get(cfg.trustedUserHeader) || null : null, maxBatchRows: cfg.maxBatchRows, firmName: cfg.firmName,
    });
  });

  app.get('/api/validate/:vrn', (req, res) => res.json(normaliseVrn(req.params.vrn)));

  app.post('/api/check', express.json(), requireUser, wrap(async (req, res) => {
    const { vrn, clientName, clientRef } = req.body || {};
    res.json(await service.quickCheck({ vrn, clientName, clientRef }, req.user));
  }));
  app.get('/api/checks/recent', (req, res) => res.json(service.recentQuickChecks()));
  app.get('/api/checks/search', (req, res) => res.json(service.searchChecks(req.query.q)));
  app.get('/api/checks/:id', (req, res) => {
    const c = service.getCheck(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(c);
  });
  app.post('/api/checks/:id/review', express.json(), requireUser, (req, res) => {
    res.json(service.review(Number(req.params.id), req.body || {}, req.user));
  });

  app.post('/api/uploads', requireUser, express.raw({ type: () => true, limit: '20mb' }), wrap(async (req, res) => {
    const filename = decodeURIComponent(req.get('x-filename') || 'upload.csv');
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'No file received' });
    let parsed;
    try {
      parsed = await parseUpload(req.body, filename);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const uploadId = service.stashUpload(parsed, filename, req.user);
    res.json({
      uploadId, filename, sha256: parsed.sha256, sheetName: parsed.sheetName, headers: parsed.headers,
      rowCount: parsed.rows.length, preview: parsed.rows.slice(0, 200), mapping: guessMapping(parsed.headers, parsed.rows),
    });
  }));

  app.post('/api/batches', express.json(), requireUser, (req, res) => {
    const { uploadId, mapping, name } = req.body || {};
    res.status(201).json(service.createBatch({ uploadId, mapping, name, actor: req.user }));
  });
  app.get('/api/batches', (req, res) => res.json(service.listBatches()));
  app.get('/api/batches/:id', (req, res) => {
    const b = service.getBatch(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    res.json({ ...b, checks: service.getBatchChecks(b.id) });
  });
  app.post('/api/batches/:id/retry', requireUser, (req, res) => res.json({ retried: service.retryFailed(req.params.id, req.user) }));

  app.get('/api/batches/:id/export.csv', (req, res) => {
    const b = service.getBatch(req.params.id);
    if (!b) return res.status(404).end();
    tx(service, () => audit.record(req.user || 'anonymous', 'export.csv', 'batch', b.id, { rows: b.total }));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${b.id}-results.csv"` });
    res.send(batchCsv(b, service.getBatchChecks(b.id)));
  });

  app.get('/api/batches/:id/evidence.xlsx', wrap(async (req, res) => {
    const b = service.getBatch(req.params.id);
    if (!b) return res.status(404).end();
    tx(service, () => audit.record(req.user || 'anonymous', 'export.evidence', 'batch', b.id, { rows: b.total }));
    const buf = await evidenceWorkbook({
      batch: b, checks: service.getBatchChecks(b.id), events: service.auditEvents({ entity: b.id, limit: 5000 }),
      verify: audit.verify(), cfg, generatedBy: req.user || 'anonymous',
    });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${b.id}-evidence.xlsx"`,
    });
    res.send(Buffer.from(buf));
  }));

  app.get('/api/template.xlsx', wrap(async (req, res) => {
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="vat-check-template.xlsx"' });
    res.send(Buffer.from(await templateWorkbook()));
  }));

  app.get('/api/insights', (req, res) => res.json(service.insights()));

  app.get('/api/audit', (req, res) => res.json(service.auditEvents(req.query)));
  app.get('/api/audit/verify', (req, res) => {
    const v = audit.verify();
    tx(service, () => audit.record(req.user || 'anonymous', 'audit.verified', 'audit', null, { ok: v.ok, count: v.count, reason: v.reason || null }));
    res.json(v);
  });
  app.get('/api/audit/export.csv', (req, res) => {
    const events = service.auditEvents({ ...req.query, limit: 5000 });
    tx(service, () => audit.record(req.user || 'anonymous', 'export.audit', 'audit', null, { events: events.length, filter: req.query }));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"` });
    res.send(auditCsv(events));
  });

  // Live progress via Server-Sent Events.
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const off = service.onProgress((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { off(); clearInterval(ping); });
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, mode: cfg.mode }));

  const staticDir = path.join(cfg.root, 'public');
  app.use(express.static(staticDir, { index: 'index.html', maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(staticDir, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong — please try again' : err.message });
  });

  return app;
}

function tx(service, fn) {
  const { tx: run } = require('./db');
  return run(service.db, fn);
}

module.exports = { createApp };
