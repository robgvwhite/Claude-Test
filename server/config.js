'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const MODES = {
  simulation: { label: 'Simulation', baseUrl: null },
  sandbox: { label: 'HMRC Sandbox', baseUrl: 'https://test-api.service.hmrc.gov.uk' },
  production: { label: 'HMRC Live', baseUrl: 'https://api.service.hmrc.gov.uk' },
};

function load(env = process.env) {
  const mode = (env.HMRC_MODE || 'simulation').toLowerCase();
  if (!MODES[mode]) throw new Error(`HMRC_MODE must be one of: ${Object.keys(MODES).join(', ')}`);
  const cfg = {
    root: ROOT,
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    dbPath: env.DB_PATH || path.join(ROOT, 'data', 'vat-checker.db'),
    mode,
    modeLabel: MODES[mode].label,
    hmrcBaseUrl: env.HMRC_BASE_URL || MODES[mode].baseUrl,
    clientId: env.HMRC_CLIENT_ID || '',
    clientSecret: env.HMRC_CLIENT_SECRET || '',
    // Our firm's own VRN. When supplied, HMRC returns a consultation number per
    // check — the strongest evidence that a check was made.
    requesterVrn: (env.HMRC_REQUESTER_VRN || '').replace(/\D/g, '') || null,
    // HMRC's default rate limit is 3 requests / second per application.
    maxRps: Math.max(0.2, Number(env.HMRC_MAX_RPS || 3)),
    maxRetries: Number(env.HMRC_MAX_RETRIES || 3),
    // In production put the app behind SSO (e.g. Entra ID / Azure App Service
    // Easy Auth) and name the header that carries the signed-in user.
    trustedUserHeader: (env.TRUSTED_USER_HEADER || '').toLowerCase() || null,
    maxBatchRows: Number(env.MAX_BATCH_ROWS || 5000),
    firmName: env.FIRM_NAME || 'Forvis Mazars',
  };
  if (mode !== 'simulation' && (!cfg.clientId || !cfg.clientSecret)) {
    throw new Error(`HMRC_MODE=${mode} requires HMRC_CLIENT_ID and HMRC_CLIENT_SECRET (see docs/HMRC_SETUP.md)`);
  }
  return cfg;
}

module.exports = { load, MODES };
