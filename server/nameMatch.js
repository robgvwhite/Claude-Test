'use strict';

/**
 * Compare the client name held in our records with the name HMRC returns.
 * A VAT number can be "valid" yet belong to a different business — this is
 * the most common real-world error, so we score every registered result.
 */

const NOISE = new Set([
  'the', 'ltd', 'limited', 'plc', 'llp', 'lp', 'llc', 'inc', 'co', 'company', 'and',
  'uk', 'group', 'holdings', 'services', 'trading', 't/a', 'ta', 'cic', 'gmbh', 'sa',
]);

function clean(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(name) {
  return clean(name).split(' ').filter((t) => t && !NOISE.has(t));
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

function dice(a, b) {
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  for (const [g, n] of A) overlap += Math.min(n, B.get(g) || 0);
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

/**
 * Returns { score: 0-100, level: 'match'|'partial'|'mismatch'|'not_provided' }.
 */
function compareNames(ours, theirs) {
  if (!ours || !String(ours).trim()) return { score: null, level: 'not_provided' };
  if (!theirs) return { score: null, level: 'not_provided' };

  const ta = tokens(ours);
  const tb = tokens(theirs);
  const ja = ta.join('');
  const jb = tb.join('');
  if (ja && ja === jb) return { score: 100, level: 'match' };

  const setA = new Set(ta);
  const setB = new Set(tb);
  const inter = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size || 1;
  const jaccard = inter / union;
  // Containment helps "Acme" vs "Acme Widgets" (trading name vs legal name).
  const contain = inter / (Math.min(setA.size, setB.size) || 1);
  const fuzzy = dice(ja, jb);

  const score = Math.round(100 * Math.max(fuzzy, 0.5 * jaccard + 0.5 * contain * 0.9));
  const level = score >= 90 ? 'match' : score >= 65 ? 'partial' : 'mismatch';
  return { score, level };
}

module.exports = { compareNames, clean };
