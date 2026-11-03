'use strict';

/**
 * Tamper-evident audit trail.
 *
 * Each event stores SHA-256(prev_hash + canonical event). Changing, removing or
 * re-ordering any historic row breaks every hash after it, which verify()
 * detects and pinpoints. Rows are also protected by append-only DB triggers.
 */

const crypto = require('node:crypto');

const GENESIS = '0'.repeat(64);

function canonical(e) {
  return JSON.stringify([e.seq, e.ts, e.actor, e.action, e.entity_type || null, e.entity_id || null, e.details || null]);
}

function hashEvent(prevHash, e) {
  return crypto.createHash('sha256').update(prevHash).update(canonical(e)).digest('hex');
}

class AuditLog {
  constructor(db) {
    this.db = db;
    this.lastStmt = db.prepare('SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1');
    this.insStmt = db.prepare('INSERT INTO audit_events (seq, ts, actor, action, entity_type, entity_id, details, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)');
  }

  /** Must be called inside a transaction when combined with other writes. */
  record(actor, action, entityType, entityId, details) {
    const last = this.lastStmt.get();
    const e = {
      seq: last ? last.seq + 1 : 1,
      ts: new Date().toISOString(),
      actor: actor || 'system',
      action,
      entity_type: entityType || null,
      entity_id: entityId == null ? null : String(entityId),
      details: details == null ? null : JSON.stringify(details),
    };
    const prev = last ? last.hash : GENESIS;
    const hash = hashEvent(prev, e);
    this.insStmt.run(e.seq, e.ts, e.actor, e.action, e.entity_type, e.entity_id, e.details, prev, hash);
    return { ...e, prev_hash: prev, hash };
  }

  verify() {
    const rows = this.db.prepare('SELECT * FROM audit_events ORDER BY seq ASC').all();
    let prev = GENESIS;
    let expectedSeq = 1;
    for (const r of rows) {
      if (r.seq !== expectedSeq) return { ok: false, count: rows.length, brokenAt: r.seq, reason: `Missing event before #${r.seq}` };
      if (r.prev_hash !== prev) return { ok: false, count: rows.length, brokenAt: r.seq, reason: `Event #${r.seq} does not link to the previous event` };
      if (hashEvent(prev, r) !== r.hash) return { ok: false, count: rows.length, brokenAt: r.seq, reason: `Event #${r.seq} has been altered` };
      prev = r.hash;
      expectedSeq++;
    }
    return { ok: true, count: rows.length, headHash: prev, verifiedAt: new Date().toISOString() };
  }

  head() {
    const last = this.lastStmt.get();
    return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS };
  }
}

module.exports = { AuditLog, hashEvent, GENESIS };
