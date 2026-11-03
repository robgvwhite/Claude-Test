'use strict';

/**
 * UK VAT Registration Number (VRN) helpers.
 *
 * A standard UK VRN is 9 digits (optionally prefixed "GB", or "XI" for
 * Northern Ireland). Some registrations carry a 3-digit branch suffix (12 digits
 * total) — the HMRC API is queried on the first 9 digits.
 *
 * Genuine HMRC VRNs satisfy a modulus-97 check. Two schemes are in use:
 *   - legacy:  (weighted sum + last two digits) % 97 === 0
 *   - "9755":  (weighted sum + 55 + last two digits) % 97 === 0
 * where the weighted sum multiplies the first seven digits by 8,7,6,5,4,3,2.
 */

const WEIGHTS = [8, 7, 6, 5, 4, 3, 2];

function checksumValid(nine) {
  if (!/^\d{9}$/.test(nine)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(nine[i]) * WEIGHTS[i];
  const check = Number(nine.slice(7));
  return (sum + check) % 97 === 0 || (sum + 55 + check) % 97 === 0;
}

/**
 * Normalise a VRN as typed / pasted by a user or found in a spreadsheet.
 * Returns { input, vrn, prefix, branch, valid, reason }.
 */
function normaliseVrn(raw) {
  const input = raw == null ? '' : String(raw);
  // Excel may turn a number into "123456789.0".
  let s = input.trim().replace(/^(\d+)\.0+$/, '$1').toUpperCase().replace(/[\s.\-_/]/g, '');

  let prefix = 'GB';
  const m = s.match(/^(GB|XI)/);
  if (m) {
    prefix = m[1];
    s = s.slice(2);
  }

  if (!s) return { input, vrn: null, prefix, branch: null, valid: false, checksumOk: false, reason: 'No VAT number supplied' };
  if (/^(GD|HA)\d{3}$/.test(s)) {
    return { input, vrn: null, prefix, branch: null, valid: false, checksumOk: false, reason: 'Government department / health authority numbers cannot be checked via HMRC API' };
  }
  if (!/^\d+$/.test(s)) return { input, vrn: null, prefix, branch: null, valid: false, checksumOk: false, reason: 'Contains characters other than digits' };

  let branch = null;
  if (s.length === 12) {
    branch = s.slice(9);
    s = s.slice(0, 9);
  } else if (s.length !== 9) {
    return { input, vrn: null, prefix, branch: null, valid: false, checksumOk: false, reason: `Expected 9 digits, found ${s.length}` };
  }

  // A check-digit failure is a strong hint of a typo, but HMRC is the
  // authority (and sandbox test VRNs do not follow the scheme), so we still
  // send the number to HMRC and surface the warning alongside the result.
  const checksumOk = checksumValid(s);
  return {
    input, vrn: s, prefix, branch, valid: true, checksumOk, reason: null,
    warning: checksumOk ? null : 'Fails the HMRC check-digit test — possible typo',
  };
}

/** Make a valid VRN from a 7-digit stem (used for test data / simulation). */
function makeVrn(stem7) {
  const s = String(stem7).padStart(7, '0').slice(0, 7);
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(s[i]) * WEIGHTS[i];
  const check = (97 - (sum % 97)) % 97;
  return s + String(check).padStart(2, '0');
}

module.exports = { normaliseVrn, checksumValid, makeVrn };
