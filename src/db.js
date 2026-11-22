// SQLite storage via Node's built-in node:sqlite. No native dependencies to install.
// The evidence model links campaign → form submission → CRM record → deal through a pseudonymous `ref`.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical } from './chain.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','approver','member')),
  pw_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, last_used_at INTEGER);

-- Foundation: versioned definitions. Rows are never edited; a change is a new version.
CREATE TABLE IF NOT EXISTS definitions (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL, version INTEGER NOT NULL, label TEXT NOT NULL,
  criteria TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id), created_at INTEGER NOT NULL, UNIQUE (key, version));

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, channel TEXT NOT NULL DEFAULT '',
  owner_id INTEGER NOT NULL REFERENCES users(id), goal_key TEXT NOT NULL DEFAULT '',
  attribution_key TEXT NOT NULL DEFAULT '', landing_url TEXT NOT NULL DEFAULT '',
  form_fields TEXT NOT NULL DEFAULT '[]', crm_mapping TEXT NOT NULL DEFAULT '{}', consent_field TEXT NOT NULL DEFAULT '',
  daily_budget REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','live','paused','ended')),
  launch_status TEXT NOT NULL DEFAULT 'BLOCKED', health TEXT NOT NULL DEFAULT 'UNCLEAR', fingerprint TEXT NOT NULL DEFAULT '',
  spend_state TEXT NOT NULL DEFAULT 'off', live_since INTEGER, checked_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

-- Evidence: what actually happened. Pseudonymous refs only; no names, emails or phone numbers.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('form_submit','crm_record','spend','deal')),
  ref TEXT, is_test INTEGER NOT NULL DEFAULT 0, fields TEXT NOT NULL DEFAULT '{}', amount REAL NOT NULL DEFAULT 0,
  at INTEGER NOT NULL, received_at INTEGER NOT NULL, source TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS events_campaign ON events(campaign_id, kind, at);
CREATE INDEX IF NOT EXISTS events_ref ON events(campaign_id, ref, kind, at);

CREATE TABLE IF NOT EXISTS check_runs (
  id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('launch','monitor')), check_id TEXT NOT NULL, stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass','fail','unknown')), code TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}',
  ran_at INTEGER NOT NULL, rules_version TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS runs_campaign ON check_runs(campaign_id, ran_at DESC);

-- Every pause and (human) start/restart, with the rule or person that caused it.
CREATE TABLE IF NOT EXISTS interventions (
  id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  action TEXT NOT NULL, by_kind TEXT NOT NULL CHECK (by_kind IN ('system','human')), actor_id INTEGER REFERENCES users(id),
  rule TEXT, cause TEXT NOT NULL DEFAULT '{}', reason TEXT NOT NULL DEFAULT '', adapter TEXT NOT NULL DEFAULT '{}', at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  owner_id INTEGER REFERENCES users(id), code TEXT NOT NULL, rule TEXT, cause TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, done_at INTEGER, done_by INTEGER REFERENCES users(id));

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor_id INTEGER, action TEXT NOT NULL,
  campaign_id INTEGER, data TEXT NOT NULL DEFAULT '{}', prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const metaGet = db.prepare('SELECT value FROM meta WHERE key = ?');
  const metaSet = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (!metaGet.get('schema_version')) metaSet.run('schema_version', '1');
  // Per-installation secret for pseudonymising emails. Never leaves the database.
  if (!metaGet.get('pseudonym_salt')) metaSet.run('pseudonym_salt', randomBytes(24).toString('hex'));

  const api = {
    raw: db,
    all: (sql, ...p) => db.prepare(sql).all(...p),
    get: (sql, ...p) => db.prepare(sql).get(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
    meta: { get: k => metaGet.get(k)?.value, set: (k, v) => metaSet.run(k, String(v)) },
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    /** Append-only, hash-chained audit log. Editing or deleting a row breaks the chain. */
    audit(action, { actorId = null, campaignId = null, data = {}, at = Date.now() } = {}) {
      const prev = db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get()?.hash ?? 'genesis';
      const body = canonical({ at, actorId, action, campaignId, data });
      const hash = createHash('sha256').update(prev + '|' + body).digest('hex');
      db.prepare('INSERT INTO audit (at, actor_id, action, campaign_id, data, prev_hash, hash) VALUES (?,?,?,?,?,?,?)')
        .run(at, actorId, action, campaignId, JSON.stringify(data), prev, hash);
      return hash;
    },
    verifyAudit() {
      let prev = 'genesis';
      for (const row of db.prepare('SELECT * FROM audit ORDER BY id').all()) {
        const body = canonical({ at: row.at, actorId: row.actor_id, action: row.action, campaignId: row.campaign_id, data: JSON.parse(row.data) });
        const hash = createHash('sha256').update(prev + '|' + body).digest('hex');
        if (row.prev_hash !== prev || row.hash !== hash) return { ok: false, brokenAt: row.id };
        prev = hash;
      }
      return { ok: true };
    },
    close: () => db.close()
  };
  return api;
}
