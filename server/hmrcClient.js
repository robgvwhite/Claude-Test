'use strict';

/**
 * Client for HMRC "Check a UK VAT number" API v2.0
 * https://developer.service.hmrc.gov.uk/api-documentation/docs/api/service/vat-registered-companies-api/2.0
 *
 *   POST {base}/oauth/token                           (client_credentials grant)
 *   GET  {base}/organisations/vat/check-vat-number/lookup/{targetVrn}
 *   GET  {base}/organisations/vat/check-vat-number/lookup/{targetVrn}/{requesterVrn}
 *
 * Every call returns a normalised outcome object; it never throws for an
 * HMRC business response (404 etc.), only records it.
 */

const crypto = require('node:crypto');
const { makeVrn, checksumValid } = require('./vrn');

const ACCEPT = 'application/vnd.hmrc.2.0+json';

class RateLimiter {
  constructor(rps, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.interval = 1000 / rps;
    this.next = 0;
    this.now = now;
    this.sleep = sleep;
  }
  async take() {
    const t = this.now();
    const wait = Math.max(0, this.next - t);
    this.next = Math.max(t, this.next) + this.interval;
    if (wait > 0) await this.sleep(wait);
  }
  penalise(ms) {
    this.next = Math.max(this.next, this.now() + ms);
  }
}

function outcomeFromResponse(httpStatus, body, requesterVrn) {
  if (httpStatus === 200 && body && body.target) {
    return {
      status: 'registered',
      httpStatus,
      name: body.target.name || null,
      address: body.target.address || null,
      processingDate: body.processingDate || null,
      consultationNumber: body.consultationNumber || null,
      requesterVrn: body.requester || requesterVrn || null,
      raw: body,
    };
  }
  if (httpStatus === 404) {
    return { status: 'not_registered', httpStatus, raw: body, message: (body && body.message) || 'Not a registered VAT number' };
  }
  const retryable = httpStatus === 429 || httpStatus >= 500 || httpStatus === 0;
  let message = (body && (body.message || body.error_description)) || `HMRC returned HTTP ${httpStatus}`;
  if (httpStatus === 403 && requesterVrn) message = `HMRC rejected the request (requester VRN ${requesterVrn} may not be valid): ${message}`;
  if (httpStatus === 401) message = 'HMRC authentication failed — check client ID/secret and that the app is subscribed to the API';
  return { status: 'error', httpStatus, raw: body, message, retryable };
}

class HmrcClient {
  constructor(cfg, { fetchImpl = globalThis.fetch, limiter, sleep } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.limiter = limiter || new RateLimiter(cfg.maxRps, undefined, this.sleep);
    this.token = null;
    this.tokenExpires = 0;
  }

  async getToken(force = false) {
    if (!force && this.token && Date.now() < this.tokenExpires - 60_000) return this.token;
    const res = await this.fetch(`${this.cfg.hmrcBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        grant_type: 'client_credentials',
      }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      const err = new Error(`Could not obtain HMRC access token (HTTP ${res.status}): ${body.error_description || body.error || 'unknown error'}`);
      err.httpStatus = res.status;
      throw err;
    }
    this.token = body.access_token;
    this.tokenExpires = Date.now() + (Number(body.expires_in) || 14400) * 1000;
    return this.token;
  }

  async lookupOnce(vrn) {
    const requester = this.cfg.requesterVrn;
    const url = `${this.cfg.hmrcBaseUrl}/organisations/vat/check-vat-number/lookup/${vrn}${requester ? `/${requester}` : ''}`;
    let token;
    try {
      token = await this.getToken();
    } catch (e) {
      return { status: 'error', httpStatus: e.httpStatus || 0, message: e.message, retryable: !e.httpStatus || e.httpStatus >= 500 };
    }
    await this.limiter.take();
    let res;
    try {
      res = await this.fetch(url, { headers: { Accept: ACCEPT, Authorization: `Bearer ${token}` } });
    } catch (e) {
      return { status: 'error', httpStatus: 0, message: `Network error contacting HMRC: ${e.message}`, retryable: true };
    }
    if (res.status === 401) this.token = null; // force refresh next time
    const body = await res.json().catch(() => null);
    const out = outcomeFromResponse(res.status, body, requester);
    if (res.status === 429) {
      const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      out.retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000;
    }
    if (res.status === 401) out.retryable = true;
    return out;
  }

  /** Lookup with retries and exponential back-off. Returns outcome + attempts. */
  async lookup(vrn) {
    let attempt = 0;
    let out;
    for (;;) {
      attempt++;
      out = await this.lookupOnce(vrn);
      if (out.status !== 'error' || !out.retryable || attempt > this.cfg.maxRetries) break;
      const backoff = out.retryAfterMs || 500 * 2 ** (attempt - 1);
      this.limiter.penalise(backoff);
      await this.sleep(backoff);
    }
    out.attempts = attempt;
    out.source = this.cfg.mode;
    return out;
  }
}

/**
 * Offline simulator — mimics HMRC response shapes so the tool can be trialled
 * before HMRC credentials are issued. Results are deterministic per VRN and
 * clearly flagged as simulated everywhere they are shown or exported.
 */
const SIM_FIXTURES = {
  // HMRC sandbox's documented example organisation.
  '553557881': { name: 'Credite Sberger Donal Inc.', address: { line1: '131B Barton Hamlet', postcode: 'SW97 5CK', countryCode: 'GB' } },
};
const SIM_NAMES = ['Northgate Engineering Ltd', 'Harbourline Logistics Limited', 'Kestrel Analytics LLP', 'Bramble & Finch Interiors Ltd', 'Meridian Health Partners Ltd', 'Oakfield Construction plc', 'Silverbirch Software Ltd', 'Thames Valley Bakeries Ltd', 'Pennine Outdoor Supplies Ltd', 'Albion Marine Services Ltd', 'Copperleaf Consulting Ltd', 'Riverside Dental Group Ltd'];
const SIM_STREETS = ['High Street', 'Station Road', 'Church Lane', 'Mill Road', 'Victoria Road', 'Park Avenue'];
const SIM_TOWNS = [['London', 'EC2A 4NE'], ['Manchester', 'M2 3AW'], ['Birmingham', 'B3 2BJ'], ['Leeds', 'LS1 4DY'], ['Bristol', 'BS1 6AD'], ['Glasgow', 'G2 1QX'], ['Belfast', 'BT1 5GS']];

// Specific VRNs used in samples/sample-clients.csv so the demo shows every outcome.
const SIM_SAMPLE = {};
function addSample(stem, rec) { SIM_SAMPLE[makeVrn(stem)] = rec; }
addSample('1234567', { name: 'Northgate Engineering Ltd' });
addSample('2345678', { name: 'Harbourline Logistics Limited' });
addSample('3456789', { name: 'Kestrel Analytics LLP' });
addSample('4567890', { name: 'Bramble and Finch Interiors Limited' });
addSample('5678901', { name: 'Meridian Health Partners Ltd' });
addSample('6789012', { notFound: true });
addSample('7890123', { name: 'Oakfield Construction plc' });
addSample('8901234', { name: 'Sterling Vending Machines Ltd' }); // deliberate name mismatch
addSample('9012345', { name: 'Silverbirch Software (UK) Ltd' });
addSample('1357913', { notFound: true });
addSample('2468024', { name: 'Thames Valley Bakeries Ltd' });
addSample('3692581', { name: 'Pennine Outdoor Supplies Limited' });
addSample('4815162', { name: 'Albion Marine Services Ltd' });
addSample('5551234', { error503: true });
addSample('6662345', { name: 'Copperleaf Consulting Ltd' });
addSample('7773456', { name: 'Riverside Dental Group Ltd' });

class SimulatedHmrcClient {
  constructor(cfg, { sleep } = {}) {
    this.cfg = cfg;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.limiter = new RateLimiter(Math.max(cfg.maxRps, 8), undefined, this.sleep);
  }
  async lookup(vrn) {
    await this.limiter.take();
    const h = crypto.createHash('sha256').update(vrn).digest();
    const fixture = SIM_FIXTURES[vrn] || SIM_SAMPLE[vrn];
    const processingDate = new Date().toISOString();
    const consultationNumber = this.cfg.requesterVrn
      ? `SIM-${h.toString('base64url').slice(0, 3)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`
      : null;
    let out;
    if (fixture && fixture.error503) {
      out = outcomeFromResponse(503, { code: 'SERVER_ERROR', message: 'Simulated HMRC service unavailable' }, this.cfg.requesterVrn);
    } else if ((fixture && fixture.notFound) || (!fixture && (h[0] < 30 || !checksumValid(vrn)))) {
      out = outcomeFromResponse(404, { code: 'NOT_FOUND', message: 'targetVrn does not match a registered company' });
    } else {
      const [town, postcode] = SIM_TOWNS[h[2] % SIM_TOWNS.length];
      const body = {
        target: {
          name: (fixture && fixture.name) || SIM_NAMES[h[1] % SIM_NAMES.length],
          vatNumber: vrn,
          address: (fixture && fixture.address) || { line1: `${(h[3] % 200) + 1} ${SIM_STREETS[h[4] % SIM_STREETS.length]}`, line2: town, postcode, countryCode: 'GB' },
        },
        processingDate,
      };
      if (consultationNumber) {
        body.requester = this.cfg.requesterVrn;
        body.consultationNumber = consultationNumber;
      }
      out = outcomeFromResponse(200, body, this.cfg.requesterVrn);
    }
    out.attempts = 1;
    out.source = 'simulation';
    return out;
  }
}

function createClient(cfg, opts) {
  return cfg.mode === 'simulation' ? new SimulatedHmrcClient(cfg, opts) : new HmrcClient(cfg, opts);
}

module.exports = { HmrcClient, SimulatedHmrcClient, RateLimiter, createClient, outcomeFromResponse };
