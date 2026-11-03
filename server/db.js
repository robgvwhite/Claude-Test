'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS batches (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  source_filename  TEXT,
  file_sha256      TEXT,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  mode             TEXT NOT NULL,
  requester_vrn    TEXT,
  status           TEXT NOT NULL,      -- queued | running | completed
  total            INTEGER NOT NULL,
  started_at       TEXT,
  completed_at     TEXT,
  results_sha256   TEXT
);

CREATE TABLE IF NOT EXISTS checks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id            TEXT REFERENCES batches(id),
  row_number          INTEGER,
  client_ref          TEXT,
  client_name         TEXT,
  input_vrn           TEXT,
  vrn                 TEXT,
  format_valid        INTEGER NOT NULL,
  format_reason       TEXT,
  status              TEXT NOT NULL,   -- pending | registered | not_registered | invalid_format | error
  hmrc_name           TEXT,
  hmrc_address        TEXT,
  name_score          INTEGER,
  name_level          TEXT,
  consultation_number TEXT,
  processing_date     TEXT,
  http_status         INTEGER,
  message             TEXT,
  raw_response        TEXT,
  attempts            INTEGER DEFAULT 0,
  duplicate_of_row    INTEGER,
  source              TEXT,
  checked_at          TEXT,
  checked_by          TEXT,
  review_status       TEXT,            -- accepted | query | null
  review_note         TEXT,
  reviewed_by         TEXT,
  reviewed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_batch ON checks(batch_id, row_number);
CREATE INDEX IF NOT EXISTS idx_checks_vrn ON checks(vrn);

CREATE TABLE IF NOT EXISTS audit_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  details     TEXT,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL
);

-- The audit trail is append-only: block edits and deletes at the database level.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
`;

function open(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { open, tx };
