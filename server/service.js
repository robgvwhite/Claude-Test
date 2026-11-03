'use strict';

const crypto = require('node:crypto');
const { normaliseVrn } = require('./vrn');
const { compareNames } = require('./nameMatch');
const { tx } = require('./db');

const ATTENTION_SQL = `(c.status IN ('not_registered','invalid_format','error') OR c.name_level IN ('mismatch','partial'))`;

function nowIso() { return new Date().toISOString(); }

function rowToCheck(r) {
  if (!r) return r;
  return {
    ...r,
    format_valid: !!r.format_valid,
    hmrc_address: r.hmrc_address ? JSON.parse(r.hmrc_address) : null,
    raw_response: undefined,
    needs_attention: !r.review_status && (['not_registered', 'invalid_format', 'error'].includes(r.status) || ['mismatch', 'partial'].includes(r.name_level)),
  };
}

function outcomeLabel(c) {
  switch (c.status) {
    case 'registered':
      if (c.name_level === 'mismatch') return 'Registered – name mismatch';
      if (c.name_level === 'partial') return 'Registered – name partly matches';
      return 'Registered';
    case 'not_registered': return 'Not registered';
    case 'invalid_format': return 'Invalid format (not sent to HMRC)';
    case 'error': return 'Check failed – retry';
    default: return 'Pending';
  }
}

class VatService {
  constructor({ db, audit, client, cfg, log = () => {} }) {
    this.db = db;
    this.audit = audit;
    this.client = client;
    this.cfg = cfg;
    this.log = log;
    this.queue = [];
    this.running = false;
    this.listeners = new Set();
    this.uploads = new Map();
  }

  // ---------- uploads ----------
  stashUpload(parsed, filename, actor) {
    const id = crypto.randomUUID();
    this.uploads.set(id, { ...parsed, filename, actor, at: Date.now() });
    for (const [k, v] of this.uploads) if (Date.now() - v.at > 3600_000) this.uploads.delete(k);
    tx(this.db, () => this.audit.record(actor, 'file.uploaded', 'upload', id, {
      filename, sha256: parsed.sha256, rows: parsed.rows.length, sheet: parsed.sheetName,
    }));
    return id;
  }

  // ---------- batches ----------
  createBatch({ uploadId, mapping, name, actor }) {
    const up = this.uploads.get(uploadId);
    if (!up) throw Object.assign(new Error('Upload has expired — please upload the file again'), { status: 400 });
    if (mapping == null || mapping.vrn == null) throw Object.assign(new Error('Choose which column contains the VAT number'), { status: 400 });
    if (up.rows.length > this.cfg.maxBatchRows) throw Object.assign(new Error(`Batches are limited to ${this.cfg.maxBatchRows} rows`), { status: 400 });

    const id = `B-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const ts = nowIso();
    const seen = new Map();
    const pick = (row, idx) => (idx == null || idx === '' ? '' : String(row[Number(idx)] ?? '').trim());

    const ins = this.db.prepare(`INSERT INTO checks (batch_id,row_number,client_ref,client_name,input_vrn,vrn,format_valid,format_reason,status,duplicate_of_row,checked_at,checked_by,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    let invalid = 0;
    let dupes = 0;
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO batches (id,name,source_filename,file_sha256,created_by,created_at,mode,requester_vrn,status,total)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, name || up.filename || 'Untitled batch', up.filename, up.sha256, actor, ts, this.cfg.mode, this.cfg.requesterVrn, 'queued', up.rows.length);
      up.rows.forEach((row, i) => {
        const rowNo = i + 2; // spreadsheet row number (header = row 1)
        const n = normaliseVrn(pick(row, mapping.vrn));
        let status = 'pending';
        let dup = null;
        if (!n.valid) { status = 'invalid_format'; invalid++; }
        else if (seen.has(n.vrn)) { dup = seen.get(n.vrn); dupes++; }
        else seen.set(n.vrn, rowNo);
        ins.run(id, rowNo, pick(row, mapping.clientRef) || null, pick(row, mapping.clientName) || null, n.input, n.vrn, n.valid ? 1 : 0, n.reason || n.warning || null,
          status, dup, status === 'invalid_format' ? ts : null, status === 'invalid_format' ? 'system' : null, status === 'invalid_format' ? 'local-validation' : null);
      });
      this.audit.record(actor, 'batch.created', 'batch', id, {
        name: name || up.filename, filename: up.filename, file_sha256: up.sha256, rows: up.rows.length,
        unique_vrns: seen.size, invalid_format: invalid, duplicates: dupes, mode: this.cfg.mode, requester_vrn: this.cfg.requesterVrn, mapping,
      });
    });
    this.uploads.delete(uploadId);
    this.enqueue(id);
    return this.getBatch(id);
  }

  listBatches() {
    return this.db.prepare(`SELECT b.*,
        SUM(c.status='registered') AS registered,
        SUM(c.status='not_registered') AS not_registered,
        SUM(c.status='invalid_format') AS invalid_format,
        SUM(c.status='error') AS errors,
        SUM(c.status='pending') AS pending,
        SUM(c.name_level='mismatch') AS name_mismatch,
        SUM(CASE WHEN ${ATTENTION_SQL} AND c.review_status IS NULL THEN 1 ELSE 0 END) AS attention
      FROM batches b LEFT JOIN checks c ON c.batch_id=b.id
      GROUP BY b.id ORDER BY b.created_at DESC`).all();
  }

  getBatch(id) {
    const b = this.listBatches().find((x) => x.id === id);
    if (!b) return null;
    return b;
  }

  getBatchChecks(id) {
    return this.db.prepare('SELECT * FROM checks WHERE batch_id=? ORDER BY row_number').all(id).map(rowToCheck);
  }

  getCheck(id) {
    const r = this.db.prepare('SELECT * FROM checks WHERE id=?').get(id);
    if (!r) return null;
    const c = rowToCheck(r);
    c.raw_response = r.raw_response ? JSON.parse(r.raw_response) : null;
    c.history = this.db.prepare(`SELECT seq, ts, actor, action, details FROM audit_events WHERE entity_type='check' AND entity_id=? ORDER BY seq`).all(String(id))
      .map((e) => ({ ...e, details: e.details ? JSON.parse(e.details) : null }));
    return c;
  }

  retryFailed(batchId, actor) {
    const n = tx(this.db, () => {
      const r = this.db.prepare(`UPDATE checks SET status='pending', message=NULL WHERE batch_id=? AND status='error' AND duplicate_of_row IS NULL`).run(batchId);
      this.db.prepare(`UPDATE checks SET status='pending', message=NULL WHERE batch_id=? AND status='error'`).run(batchId);
      if (r.changes) {
        this.db.prepare(`UPDATE batches SET status='queued', completed_at=NULL WHERE id=?`).run(batchId);
        this.audit.record(actor, 'batch.retry', 'batch', batchId, { rows: Number(r.changes) });
      }
      return Number(r.changes);
    });
    if (n) this.enqueue(batchId);
    return n;
  }

  review(checkId, { status, note }, actor) {
    if (!['accepted', 'query', null, ''].includes(status ?? null)) throw Object.assign(new Error('Invalid review status'), { status: 400 });
    const c = this.db.prepare('SELECT * FROM checks WHERE id=?').get(checkId);
    if (!c) throw Object.assign(new Error('Not found'), { status: 404 });
    tx(this.db, () => {
      this.db.prepare('UPDATE checks SET review_status=?, review_note=?, reviewed_by=?, reviewed_at=? WHERE id=?')
        .run(status || null, note || null, status ? actor : null, status ? nowIso() : null, checkId);
      this.audit.record(actor, status ? `review.${status}` : 'review.cleared', 'check', checkId, {
        batch_id: c.batch_id, row: c.row_number, vrn: c.vrn, previous: c.review_status, note: note || null,
      });
    });
    return this.getCheck(checkId);
  }

  // ---------- quick check ----------
  async quickCheck({ vrn: input, clientName, clientRef }, actor) {
    const n = normaliseVrn(input);
    const ts = nowIso();
    if (!n.valid) {
      const id = tx(this.db, () => {
        const r = this.db.prepare(`INSERT INTO checks (batch_id,row_number,client_ref,client_name,input_vrn,vrn,format_valid,format_reason,status,checked_at,checked_by,source)
          VALUES (NULL,NULL,?,?,?,?,0,?,'invalid_format',?,?,'local-validation')`).run(clientRef || null, clientName || null, n.input, n.vrn, n.reason, ts, actor);
        this.audit.record(actor, 'check.invalid_format', 'check', r.lastInsertRowid, { vrn_input: n.input, reason: n.reason });
        return r.lastInsertRowid;
      });
      return this.getCheck(Number(id));
    }
    const out = await this.client.lookup(n.vrn);
    const id = tx(this.db, () => {
      const r = this.db.prepare(`INSERT INTO checks (batch_id,row_number,client_ref,client_name,input_vrn,vrn,format_valid,status,checked_at,checked_by)
        VALUES (NULL,NULL,?,?,?,?,1,'pending',?,?)`).run(clientRef || null, clientName || null, n.input, n.vrn, ts, actor);
      const cid = Number(r.lastInsertRowid);
      this.applyOutcome(cid, out, actor);
      return cid;
    });
    return this.getCheck(id);
  }

  /** Persist an HMRC outcome on a check row and write the audit event. Call inside tx. */
  applyOutcome(checkId, out, actor) {
    const c = this.db.prepare('SELECT * FROM checks WHERE id=?').get(checkId);
    const name = out.status === 'registered' ? compareNames(c.client_name, out.name) : { score: null, level: null };
    const ts = nowIso();
    this.db.prepare(`UPDATE checks SET status=?, hmrc_name=?, hmrc_address=?, name_score=?, name_level=?, consultation_number=?, processing_date=?,
        http_status=?, message=?, raw_response=?, attempts=attempts+?, source=?, checked_at=?, checked_by=? WHERE id=?`)
      .run(out.status, out.name || null, out.address ? JSON.stringify(out.address) : null, name.score, name.level, out.consultationNumber || null,
        out.processingDate || null, out.httpStatus ?? null, out.message || null, out.raw ? JSON.stringify(out.raw) : null, out.attempts || 1,
        out.source || this.cfg.mode, ts, actor, checkId);
    this.audit.record(actor, `hmrc.${out.status}`, 'check', checkId, {
      batch_id: c.batch_id, row: c.row_number, vrn: c.vrn, http_status: out.httpStatus ?? null, hmrc_name: out.name || null,
      name_match: name.level, name_score: name.score, consultation_number: out.consultationNumber || null,
      processing_date: out.processingDate || null, attempts: out.attempts, source: out.source || this.cfg.mode, message: out.message || null,
    });
    return name;
  }

  // ---------- background processing ----------
  enqueue(batchId) {
    if (!this.queue.includes(batchId)) this.queue.push(batchId);
    this.kick();
  }

  resumeIncomplete() {
    const rows = this.db.prepare(`SELECT DISTINCT batch_id FROM checks WHERE status='pending' AND batch_id IS NOT NULL`).all();
    rows.forEach((r) => this.enqueue(r.batch_id));
    return rows.length;
  }

  onProgress(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(evt) { for (const fn of this.listeners) { try { fn(evt); } catch { /* ignore */ } } }

  kick() {
    if (this.running) return;
    this.running = true;
    this.idle = (async () => {
      try {
        while (this.queue.length) {
          const id = this.queue[0];
          try { await this.processBatch(id); } catch (e) { this.log(`Batch ${id} failed: ${e.stack || e}`); }
          this.queue.shift();
        }
      } finally {
        this.running = false;
      }
    })();
  }

  async processBatch(id) {
    const b = this.db.prepare('SELECT * FROM batches WHERE id=?').get(id);
    if (!b) return;
    if (!b.started_at) this.db.prepare(`UPDATE batches SET status='running', started_at=? WHERE id=?`).run(nowIso(), id);
    else this.db.prepare(`UPDATE batches SET status='running' WHERE id=?`).run(id);
    this.emit({ type: 'batch', id });

    const pending = this.db.prepare(`SELECT id, vrn, row_number FROM checks WHERE batch_id=? AND status='pending' AND duplicate_of_row IS NULL ORDER BY row_number`).all(id);
    for (const p of pending) {
      const out = await this.client.lookup(p.vrn);
      tx(this.db, () => {
        // Checks are attributed to the person who ran the batch.
        this.applyOutcome(p.id, out, b.created_by);
        // Copy the result to any duplicate rows of the same VRN in this batch.
        const dups = this.db.prepare(`SELECT id FROM checks WHERE batch_id=? AND duplicate_of_row=? AND status='pending'`).all(id, p.row_number);
        for (const d of dups) this.applyOutcome(d.id, { ...out, attempts: 0, message: out.message || `Same VAT number as row ${p.row_number} — result reused` }, b.created_by);
      });
      this.emit({ type: 'progress', id });
    }
    // Duplicates whose primary was already done earlier (e.g. after a retry).
    const orphans = this.db.prepare(`SELECT d.id, p.id AS pid FROM checks d JOIN checks p ON p.batch_id=d.batch_id AND p.row_number=d.duplicate_of_row
      WHERE d.batch_id=? AND d.status='pending' AND p.status!='pending'`).all(id);
    if (orphans.length) {
      tx(this.db, () => {
        for (const o of orphans) {
          const p = this.db.prepare('SELECT * FROM checks WHERE id=?').get(o.pid);
          this.applyOutcome(o.id, {
            status: p.status, httpStatus: p.http_status, name: p.hmrc_name, address: p.hmrc_address ? JSON.parse(p.hmrc_address) : null,
            consultationNumber: p.consultation_number, processingDate: p.processing_date, raw: p.raw_response ? JSON.parse(p.raw_response) : null,
            attempts: 0, source: p.source, message: `Same VAT number as row ${p.row_number} — result reused`,
          }, b.created_by);
        }
      });
    }

    const resultsHash = this.resultsHash(id);
    tx(this.db, () => {
      this.db.prepare(`UPDATE batches SET status='completed', completed_at=?, results_sha256=? WHERE id=?`).run(nowIso(), resultsHash, id);
      const s = this.getBatch(id);
      this.audit.record('system', 'batch.completed', 'batch', id, {
        results_sha256: resultsHash, registered: s.registered, not_registered: s.not_registered, invalid_format: s.invalid_format,
        errors: s.errors, name_mismatch: s.name_mismatch,
      });
    });
    this.emit({ type: 'batch', id });
  }

  /** Fingerprint of a batch's results, so an exported file can be proven unaltered. */
  resultsHash(id) {
    const rows = this.db.prepare(`SELECT row_number, client_ref, client_name, vrn, status, hmrc_name, consultation_number, processing_date FROM checks WHERE batch_id=? ORDER BY row_number`).all(id);
    return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }

  // ---------- reporting ----------
  recentQuickChecks(limit = 20) {
    return this.db.prepare('SELECT * FROM checks WHERE batch_id IS NULL ORDER BY id DESC LIMIT ?').all(limit).map(rowToCheck);
  }

  searchChecks(q, limit = 100) {
    const like = `%${String(q || '').trim()}%`;
    return this.db.prepare(`SELECT c.*, b.name AS batch_name FROM checks c LEFT JOIN batches b ON b.id=c.batch_id
      WHERE c.vrn LIKE ? OR c.client_name LIKE ? OR c.client_ref LIKE ? OR c.hmrc_name LIKE ? OR c.consultation_number LIKE ?
      ORDER BY c.id DESC LIMIT ?`).all(like, like, like, like, like, limit).map(rowToCheck);
  }

  insights() {
    const one = (sql, ...a) => this.db.prepare(sql).get(...a);
    const all = (sql, ...a) => this.db.prepare(sql).all(...a);
    const totals = one(`SELECT COUNT(*) AS checks,
        SUM(status='registered') AS registered, SUM(status='not_registered') AS not_registered,
        SUM(status='invalid_format') AS invalid_format, SUM(status='error') AS errors, SUM(status='pending') AS pending,
        SUM(name_level='match') AS name_match, SUM(name_level='partial') AS name_partial, SUM(name_level='mismatch') AS name_mismatch,
        SUM(review_status='accepted') AS accepted, SUM(review_status='query') AS queried,
        SUM(CASE WHEN ${ATTENTION_SQL.replace(/c\./g, '')} AND review_status IS NULL THEN 1 ELSE 0 END) AS attention,
        COUNT(DISTINCT vrn) AS unique_vrns,
        SUM(consultation_number IS NOT NULL) AS with_consultation
      FROM checks`);
    const batches = one(`SELECT COUNT(*) AS n, SUM(total) AS rows FROM batches`);
    const daily = all(`SELECT substr(checked_at,1,10) AS day, COUNT(*) AS n,
        SUM(status='registered') AS registered, SUM(status!='registered') AS other
      FROM checks WHERE checked_at >= date('now','-29 days') GROUP BY day ORDER BY day`);
    const users = all(`SELECT actor, COUNT(*) AS n FROM audit_events WHERE actor!='system' GROUP BY actor ORDER BY n DESC LIMIT 8`);
    const recentBatches = this.listBatches().slice(0, 6);
    const speed = one(`SELECT AVG((julianday(completed_at)-julianday(started_at))*86400.0/NULLIF(total,0)) AS secs_per_row FROM batches WHERE completed_at IS NOT NULL AND started_at IS NOT NULL`);
    const attentionList = all(`SELECT c.*, b.name AS batch_name FROM checks c LEFT JOIN batches b ON b.id=c.batch_id
      WHERE ${ATTENTION_SQL} AND c.review_status IS NULL ORDER BY c.id DESC LIMIT 10`).map(rowToCheck);
    return { totals, batches, daily, users, recentBatches, secsPerRow: speed.secs_per_row, attentionList, audit: this.audit.head() };
  }

  auditEvents({ q, action, actor, entity, limit = 200, before } = {}) {
    const where = [];
    const args = [];
    if (q) { where.push('(details LIKE ? OR entity_id LIKE ? OR actor LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (action) { where.push('action LIKE ?'); args.push(`${action}%`); }
    if (actor) { where.push('actor = ?'); args.push(actor); }
    if (entity) { where.push('(entity_id = ? OR details LIKE ?)'); args.push(entity, `%"batch_id":"${entity}"%`); }
    if (before) { where.push('seq < ?'); args.push(Number(before)); }
    const sql = `SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.min(Number(limit) || 200, 5000))
      .map((e) => ({ ...e, details: e.details ? JSON.parse(e.details) : null }));
  }
}

module.exports = { VatService, outcomeLabel };
