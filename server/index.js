'use strict';

const config = require('./config');
const db = require('./db');
const { AuditLog } = require('./audit');
const { createClient } = require('./hmrcClient');
const { VatService } = require('./service');
const { createApp } = require('./app');

function build(env) {
  const cfg = config.load(env);
  const database = db.open(cfg.dbPath);
  const audit = new AuditLog(database);
  const client = createClient(cfg);
  const service = new VatService({ db: database, audit, client, cfg, log: console.error });
  const app = createApp({ service, audit, cfg });
  return { cfg, db: database, audit, service, app };
}

if (require.main === module) {
  const { cfg, app, service, audit } = build();
  db.tx(service.db, () => audit.record('system', 'app.started', 'app', null, { mode: cfg.mode, requester_vrn: cfg.requesterVrn }));
  const resumed = service.resumeIncomplete();
  app.listen(cfg.port, cfg.host, () => {
    console.log(`VAT Registration Checker running at http://localhost:${cfg.port}`);
    console.log(`HMRC mode: ${cfg.modeLabel}${cfg.mode === 'simulation' ? ' (no real HMRC calls — set HMRC_MODE in .env)' : ''}`);
    if (resumed) console.log(`Resuming ${resumed} unfinished batch(es)`);
  });
}

module.exports = { build };
