// Domain logic. Every state change is permission-checked, written in a transaction and audited.
// Free text (names, notes, reasons, field values) is stored as data and never interpreted.
import { randomBytes } from 'node:crypto';
import { launchCheck, staticChecks, monitor, RULES_VERSION } from './chain.js';
import { decide, canTransition, CONTROLLER_VERSION } from './controller.js';
import { validateCriteria, KEY_RE } from './definitions.js';
import { prepareEvents } from './ingest.js';
import { createAdapter, createNotifier } from './adapters.js';
import { hashPassword, verifyPassword, strip, can, newToken, sha } from './auth.js';

export class HttpError extends Error {
  constructor(status, code, detail) { super(code); this.status = status; this.code = code; this.detail = detail; }
}
const deny = () => { throw new HttpError(403, 'FORBIDDEN'); };
const notFound = () => { throw new HttpError(404, 'NOT_FOUND'); };
const bad = (code, detail) => { throw new HttpError(400, code, detail); };

const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const FIELD_RE = /^[a-z][a-z0-9_]{0,40}$/;
const HOUR = 3600_000;

export function createService(db, config, { clock = () => Date.now(), fetch: fetchImpl, log = console } = {}) {
  const settings = () => config.rules;
  const adapter = createAdapter(config, { fetch: fetchImpl });
  const notify = createNotifier(config, { fetch: fetchImpl, log });

  // ---------- users & tokens ----------
  function needsSetup() { return !db.get('SELECT 1 AS x FROM users LIMIT 1'); }

  function createUser(actor, { email, name, role = 'member', password }) {
    const first = needsSetup();
    if (!first && !(actor && can.manageUsers(actor))) deny();
    email = str(email, 200).toLowerCase(); name = str(name, 120);
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) bad('INVALID_EMAIL');
    if (!name) bad('NAME_REQUIRED');
    if (!['admin', 'approver', 'member'].includes(role)) bad('INVALID_ROLE');
    if (first) role = 'admin';
    if (db.get('SELECT 1 AS x FROM users WHERE email = ?', email)) throw new HttpError(409, 'EMAIL_TAKEN');
    let pw;
    try { pw = hashPassword(password); } catch { bad('PASSWORD_TOO_SHORT'); }
    const now = clock();
    const id = Number(db.run('INSERT INTO users (email, name, role, pw_hash, created_at) VALUES (?,?,?,?,?)', email, name, role, pw, now).lastInsertRowid);
    db.audit('user.created', { actorId: actor?.id ?? id, data: { userId: id, email, role }, at: now });
    return strip(db.get('SELECT * FROM users WHERE id = ?', id));
  }

  function login(email, password) {
    const u = db.get('SELECT * FROM users WHERE email = ? AND disabled = 0', str(email, 200).toLowerCase());
    if (!u || !verifyPassword(password, u.pw_hash)) throw new HttpError(401, 'INVALID_LOGIN');
    db.audit('user.login', { actorId: u.id, at: clock() });
    return strip(u);
  }

  function listUsers(actor) { if (!actor) deny(); return db.all('SELECT * FROM users ORDER BY name').map(strip); }

  function updateUser(actor, id, { role, disabled, password }) {
    if (!can.manageUsers(actor)) deny();
    const u = db.get('SELECT * FROM users WHERE id = ?', id) ?? notFound();
    if (role !== undefined) {
      if (!['admin', 'approver', 'member'].includes(role)) bad('INVALID_ROLE');
      if (u.role === 'admin' && role !== 'admin' && db.get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").n < 2) bad('LAST_ADMIN');
      db.run('UPDATE users SET role = ? WHERE id = ?', role, id);
    }
    if (disabled !== undefined) {
      if (id === actor.id) bad('CANNOT_DISABLE_SELF');
      db.run('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, id);
      if (disabled) db.run('DELETE FROM sessions WHERE user_id = ?', id);
    }
    if (password !== undefined) {
      try { db.run('UPDATE users SET pw_hash = ? WHERE id = ?', hashPassword(password), id); } catch { bad('PASSWORD_TOO_SHORT'); }
    }
    db.audit('user.updated', { actorId: actor.id, data: { userId: id, role, disabled, passwordChanged: password !== undefined }, at: clock() });
    return strip(db.get('SELECT * FROM users WHERE id = ?', id));
  }

  function changeOwnPassword(actor, { current, next }) {
    const u = db.get('SELECT * FROM users WHERE id = ?', actor.id);
    if (!verifyPassword(current, u.pw_hash)) throw new HttpError(401, 'INVALID_LOGIN');
    try { db.run('UPDATE users SET pw_hash = ? WHERE id = ?', hashPassword(next), actor.id); } catch { bad('PASSWORD_TOO_SHORT'); }
    db.audit('user.password_changed', { actorId: actor.id, at: clock() });
  }

  /** API tokens are for machines (n8n, CI, connectors): they can send evidence and read, never start spend. */
  function listTokens(actor) {
    if (!actor) deny();
    return db.all('SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC', actor.id);
  }
  function createToken(actor, name) {
    if (!actor || actor.via === 'token') deny();
    name = str(name, 80); if (!name) bad('NAME_REQUIRED');
    const token = newToken('ant_');
    const now = clock();
    const id = Number(db.run('INSERT INTO api_tokens (name, token_hash, user_id, created_at) VALUES (?,?,?,?)', name, sha(token), actor.id, now).lastInsertRowid);
    db.audit('token.created', { actorId: actor.id, data: { tokenId: id, name }, at: now });
    return { id, name, token };
  }
  function revokeToken(actor, id) {
    const t = db.get('SELECT * FROM api_tokens WHERE id = ?', id) ?? notFound();
    if (t.user_id !== actor.id && !can.manageUsers(actor)) deny();
    db.run('DELETE FROM api_tokens WHERE id = ?', id);
    db.audit('token.revoked', { actorId: actor.id, data: { tokenId: id }, at: clock() });
  }

  // ---------- foundation: versioned definitions ----------
  const defRow = d => ({ id: d.id, key: d.key, version: d.version, label: d.label, criteria: parse(d.criteria, []), note: d.note, active: !!d.active, created_by: d.created_by, created_at: d.created_at });

  function activeDefinitions() {
    return new Map(db.all('SELECT * FROM definitions WHERE active = 1').map(d => [d.key, defRow(d)]));
  }

  function listDefinitions(actor) {
    if (!actor) deny();
    const users = new Map(db.all('SELECT id, name FROM users').map(u => [u.id, u.name]));
    return db.all('SELECT * FROM definitions ORDER BY key, version DESC').map(d => ({ ...defRow(d), created_by_name: users.get(d.created_by) ?? null }));
  }

  async function createDefinitionVersion(actor, { key, label, criteria, note }) {
    if (!actor || !can.manageDefinitions(actor)) deny();
    key = str(key, 40).toLowerCase(); label = str(label, 120); note = str(note, 1000);
    if (!KEY_RE.test(key)) bad('INVALID_KEY');
    if (!label) bad('LABEL_REQUIRED');
    const problems = validateCriteria(criteria);
    if (problems.length) bad('INVALID_CRITERIA', problems);
    const now = clock();
    const version = db.tx(() => {
      const v = (db.get('SELECT MAX(version) AS v FROM definitions WHERE key = ?', key)?.v ?? 0) + 1;
      db.run('UPDATE definitions SET active = 0 WHERE key = ?', key);
      db.run('INSERT INTO definitions (key, version, label, criteria, note, active, created_by, created_at) VALUES (?,?,?,?,?,1,?,?)',
        key, v, label, JSON.stringify(criteria), note, actor.id, now);
      db.audit('definition.versioned', { actorId: actor.id, data: { key, version: v, label, criteria, note }, at: now });
      return v;
    });
    // A new definition can break the chain of campaigns that depend on it: re-check them now.
    const affected = db.all("SELECT id FROM campaigns WHERE state != 'ended' AND (goal_key = ? OR ? = ?)", key, key, settings().opportunityKey);
    for (const c of affected) await runChecks(null, c.id);
    return { key, version, recheckedCampaigns: affected.length };
  }

  // ---------- campaigns ----------
  const camp = row => row && {
    ...row, form_fields: parse(row.form_fields, []), crm_mapping: parse(row.crm_mapping, {})
  };
  const getCamp = id => camp(db.get('SELECT * FROM campaigns WHERE id = ?', id)) ?? notFound();

  function cleanCampaign(body, partial = false) {
    const out = {};
    const take = (k, fn) => { if (!partial || body[k] !== undefined) out[k] = fn(body[k]); };
    take('name', v => str(v, 120));
    take('channel', v => str(v, 60));
    take('goal_key', v => str(v, 40).toLowerCase());
    take('attribution_key', v => str(v, 80));
    take('landing_url', v => str(v, 500));
    take('consent_field', v => str(v, 40).toLowerCase());
    take('daily_budget', v => { const n = Number(v ?? 0); if (!Number.isFinite(n) || n < 0) bad('INVALID_BUDGET'); return n; });
    take('form_fields', v => {
      const list = (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(x => String(x).trim().toLowerCase()).filter(Boolean);
      if (list.some(f => !FIELD_RE.test(f))) bad('INVALID_FIELD_NAME');
      return [...new Set(list)].slice(0, 60);
    });
    take('crm_mapping', v => {
      const m = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      const out2 = {};
      for (const [f, c] of Object.entries(m).slice(0, 60)) {
        const ff = String(f).trim().toLowerCase(), cc = String(c ?? '').trim().toLowerCase();
        if (!cc) continue;
        if (!FIELD_RE.test(ff) || !FIELD_RE.test(cc)) bad('INVALID_FIELD_NAME');
        out2[ff] = cc;
      }
      return out2;
    });
    if (out.name !== undefined && !out.name) bad('NAME_REQUIRED');
    return out;
  }

  async function createCampaign(actor, body) {
    if (!actor) deny();
    const c = cleanCampaign(body);
    const now = clock();
    const id = Number(db.run(`INSERT INTO campaigns (name, channel, owner_id, goal_key, attribution_key, landing_url, form_fields, crm_mapping, consent_field, daily_budget, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, c.name, c.channel, actor.id, c.goal_key, c.attribution_key, c.landing_url,
      JSON.stringify(c.form_fields), JSON.stringify(c.crm_mapping), c.consent_field, c.daily_budget, now, now).lastInsertRowid);
    db.audit('campaign.created', { actorId: actor.id, campaignId: id, data: c, at: now });
    return runChecks(actor, id);
  }

  async function updateCampaign(actor, id, body) {
    if (!actor || actor.via === 'token') deny();
    const before = getCamp(id);
    if (before.state === 'ended') bad('CAMPAIGN_ENDED');
    const c = cleanCampaign(body, true);
    const keys = Object.keys(c);
    if (!keys.length) return getCampaign(actor, id);
    const now = clock();
    const vals = keys.map(k => (k === 'form_fields' || k === 'crm_mapping' ? JSON.stringify(c[k]) : c[k]));
    db.run(`UPDATE campaigns SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...vals, now, id);
    db.audit('campaign.updated', { actorId: actor.id, campaignId: id, data: { changed: c }, at: now });
    // Editing a live campaign is checked immediately: a broken mapping pauses it like any other break.
    return runChecks(actor, id);
  }

  function listCampaigns(actor) {
    if (!actor) deny();
    return db.all(`SELECT c.*, u.name AS owner_name,
        (SELECT COUNT(*) FROM tasks t WHERE t.campaign_id = c.id AND t.done_at IS NULL) AS open_tasks
      FROM campaigns c JOIN users u ON u.id = c.owner_id ORDER BY c.state = 'ended', c.updated_at DESC`).map(camp);
  }

  function latestRun(id, kind) {
    const last = db.get('SELECT run_id, ran_at FROM check_runs WHERE campaign_id = ? AND kind = ? ORDER BY id DESC LIMIT 1', id, kind);
    if (!last) return null;
    const results = db.all('SELECT check_id AS id, stage, status, code, params FROM check_runs WHERE run_id = ? ORDER BY check_runs.id', last.run_id)
      .map(x => ({ ...x, params: parse(x.params, {}) }));
    return { ran_at: last.ran_at, results };
  }

  function evidenceStats(id) {
    const since = clock() - settings().monitorWindowHours * HOUR;
    const q = (kind, extra = '') => db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS sum FROM events WHERE campaign_id = ? AND kind = ? AND at >= ? ${extra}`, id, kind, since);
    return {
      windowHours: settings().monitorWindowHours,
      submissions: q('form_submit', 'AND is_test = 0').n,
      tests: q('form_submit', 'AND is_test = 1').n,
      records: q('crm_record').n,
      spend: Math.round(q('spend').sum * 100) / 100,
      deals: db.get("SELECT COUNT(DISTINCT ref) AS n FROM events WHERE campaign_id = ? AND kind = 'deal'", id).n
    };
  }

  function getCampaign(actor, id) {
    if (!actor) deny();
    const c = getCamp(id);
    const users = new Map(db.all('SELECT id, name FROM users').map(u => [u.id, u.name]));
    return {
      campaign: { ...c, owner_name: users.get(c.owner_id) ?? null },
      launch: latestRun(id, 'launch'),
      monitor: latestRun(id, 'monitor'),
      evidence: evidenceStats(id),
      interventions: db.all('SELECT * FROM interventions WHERE campaign_id = ? ORDER BY id DESC LIMIT 50', id)
        .map(i => ({ ...i, cause: parse(i.cause, {}), adapter: parse(i.adapter, {}), actor_name: users.get(i.actor_id) ?? null })),
      tasks: db.all('SELECT * FROM tasks WHERE campaign_id = ? ORDER BY done_at IS NOT NULL, id DESC LIMIT 50', id).map(t => ({ ...t, cause: parse(t.cause, {}) })),
      definitions: Object.fromEntries([...activeDefinitions()].filter(([k]) => k === c.goal_key || k === settings().opportunityKey)),
      rulesVersion: RULES_VERSION, controllerVersion: CONTROLLER_VERSION
    };
  }

  // ---------- evidence → checks → controller ----------

  function testEvidence(id) {
    const sub = db.get("SELECT ref, at FROM events WHERE campaign_id = ? AND kind = 'form_submit' AND is_test = 1 ORDER BY at DESC, id DESC LIMIT 1", id);
    if (!sub) return null;
    const rec = db.get("SELECT at, fields FROM events WHERE campaign_id = ? AND kind = 'crm_record' AND ref = ? ORDER BY at DESC, id DESC LIMIT 1", id, sub.ref);
    // A paused campaign needs proof newer than its last pause.
    const c = db.get('SELECT state FROM campaigns WHERE id = ?', id);
    const paused = c?.state === 'paused' ? db.get("SELECT MAX(at) AS at FROM interventions WHERE campaign_id = ? AND action = 'pause'", id)?.at : null;
    return { submission: sub, record: rec ? { at: rec.at, fields: parse(rec.fields, {}) } : null, notBefore: paused ?? null };
  }

  function windowEvidence(c, now) {
    const from = Math.max(now - settings().monitorWindowHours * HOUR, c.live_since ?? 0);
    const submissions = db.all("SELECT ref, at FROM events WHERE campaign_id = ? AND kind = 'form_submit' AND is_test = 0 AND at >= ? ORDER BY at", c.id, from);
    const records = new Map();
    for (const row of db.all(`SELECT ref, at, fields FROM events WHERE campaign_id = ? AND kind = 'crm_record' AND is_test = 0
        AND ref IN (SELECT ref FROM events WHERE campaign_id = ? AND kind = 'form_submit' AND is_test = 0 AND at >= ?) ORDER BY at, id`, c.id, c.id, from)) {
      records.set(row.ref, { at: row.at, fields: parse(row.fields, {}) });
    }
    const spend = db.get("SELECT COALESCE(SUM(amount),0) AS s FROM events WHERE campaign_id = ? AND kind = 'spend' AND at >= ?", c.id, from).s;
    return { submissions, records, spend };
  }

  function storeRun(id, kind, results, now) {
    const runId = randomBytes(8).toString('hex');
    for (const x of results) {
      db.run('INSERT INTO check_runs (campaign_id, run_id, kind, check_id, stage, status, code, params, ran_at, rules_version) VALUES (?,?,?,?,?,?,?,?,?,?)',
        id, runId, kind, x.id, x.stage, x.status, x.code, JSON.stringify(x.params ?? {}), now, RULES_VERSION);
    }
  }

  /** One open task per campaign and code: a daily re-check must not flood the owner. */
  function openTask(c, code, rule, cause, now) {
    if (db.get('SELECT 1 AS x FROM tasks WHERE campaign_id = ? AND code = ? AND done_at IS NULL', c.id, code)) return false;
    db.run('INSERT INTO tasks (campaign_id, owner_id, code, rule, cause, created_at) VALUES (?,?,?,?,?,?)', c.id, c.owner_id, code, rule, JSON.stringify(cause ?? {}), now);
    db.audit('task.created', { campaignId: c.id, data: { code, rule, cause }, at: now });
    return true;
  }

  async function applyPause(c, { byKind, actorId = null, rule = null, cause = null, reason = '' }) {
    if (!canTransition('pause', c.state, byKind)) bad('INVALID_TRANSITION');
    const res = await adapter.pause(c, { rule, cause, reason });
    const now = clock();
    db.tx(() => {
      db.run("UPDATE campaigns SET state = 'paused', spend_state = ?, updated_at = ? WHERE id = ?", res.spend ?? 'unknown', now, c.id);
      db.run('INSERT INTO interventions (campaign_id, action, by_kind, actor_id, rule, cause, reason, adapter, at) VALUES (?,?,?,?,?,?,?,?,?)',
        c.id, 'pause', byKind, actorId, rule, JSON.stringify(cause ?? {}), reason, JSON.stringify(res), now);
      db.audit('campaign.paused', { actorId, campaignId: c.id, data: { by: byKind, rule, cause, reason, adapter: res }, at: now });
      // If the platform could not be reached (or there is no integration), a person must pause it by hand.
      if (!res.ok) openTask(c, 'TASK_PAUSE_MANUALLY', rule, { adapter: res.mode, ...(cause ?? {}) }, now);
    });
    return res;
  }

  /**
   * Re-run the chain for one campaign and let the controller react.
   * Draft: launch check only. Live: configuration + live monitoring, may pause. Paused: launch check, may suggest restart.
   */
  async function runChecks(actor, id) {
    const c = getCamp(id);
    if (c.state === 'ended') return getCampaign(actor ?? { id: 0 }, id);
    const now = clock();
    const defs = activeDefinitions();
    const s = settings();
    const launch = launchCheck({ campaign: c, definitions: defs, test: testEvidence(id), now, settings: s });
    // Health describes a running campaign; a draft only has a launch status.
    let decision = { health: '', rule: null, actions: [] };
    db.tx(() => {
      storeRun(id, 'launch', launch.results, now);
      if (c.state === 'live') {
        const results = [...staticChecks({ campaign: c, definitions: defs, settings: s }), ...monitor({ campaign: c, definitions: defs, window: windowEvidence(c, now), now, settings: s })];
        storeRun(id, 'monitor', results, now);
        decision = decide({ campaign: c, results });
      } else if (c.state === 'paused') {
        decision = decide({ campaign: c, results: launch.results });
      }
      db.run('UPDATE campaigns SET launch_status = ?, fingerprint = ?, health = ?, checked_at = ? WHERE id = ?', launch.status, launch.fingerprint, decision.health, now, id);
      db.audit('checks.run', { actorId: actor?.id ?? null, campaignId: id, data: { state: c.state, launch: launch.status, health: decision.health, rule: decision.rule, by: actor ? 'human' : 'system' }, at: now });
      for (const a of decision.actions) if (a.type === 'task') openTask(c, a.code, a.rule, a.cause, now);
    });
    // The controller is handed exactly one capability: pause.
    let pausedNow = false;
    for (const a of decision.actions) {
      if (a.type === 'pause') { await applyPause(c, { byKind: 'system', rule: a.rule, cause: a.cause }); pausedNow = true; }
      if (a.type === 'notify') await notify({ event: a.event, rule: a.rule, cause: a.cause, campaign: { id: c.id, name: c.name, channel: c.channel }, at: new Date(now).toISOString() });
    }
    // Once paused, the launch status must reflect the paused state (which needs post-pause proof), not the live one.
    if (pausedNow) return runChecks(actor, id);
    return getCampaign(actor ?? { id: 0 }, id);
  }

  async function recheckAll() {
    const ids = db.all("SELECT id FROM campaigns WHERE state IN ('draft','live','paused')").map(r => r.id);
    const out = [];
    for (const id of ids) {
      const d = await runChecks(null, id);
      out.push({ id, state: d.campaign.state, launch: d.campaign.launch_status, health: d.campaign.health });
    }
    return out;
  }

  // ---------- human-only transitions ----------

  async function pauseCampaign(actor, id, { reason } = {}) {
    if (!actor || actor.via === 'token') deny();
    const c = getCamp(id);
    reason = str(reason, 1000);
    if (!reason) bad('REASON_REQUIRED');
    await applyPause(c, { byKind: 'human', actorId: actor.id, reason });
    return getCampaign(actor, id);
  }

  /** Start (from draft) or restart (from paused). Only a named approver, personally logged in, with a fresh GO. */
  async function startCampaign(actor, id, { reason } = {}) {
    if (!actor || !can.startSpend(actor)) deny();
    const c = getCamp(id);
    const action = c.state === 'draft' ? 'start' : c.state === 'paused' ? 'restart' : null;
    if (!action || !canTransition(action, c.state, 'human')) bad('INVALID_TRANSITION');
    if (settings().fourEyes && c.owner_id === actor.id) throw new HttpError(403, 'FOUR_EYES', 'The campaign owner cannot start their own campaign.');
    reason = str(reason, 1000);
    if (reason.length < 5) bad('REASON_REQUIRED');
    const now = clock();
    const check = launchCheck({ campaign: c, definitions: activeDefinitions(), test: testEvidence(id), now, settings: settings() });
    if (check.status !== 'GO') throw new HttpError(409, 'NOT_GO', check.results.filter(x => x.status !== 'pass').map(x => x.code));
    const res = await adapter.resume(c, { reason, by: actor.id });
    db.tx(() => {
      db.run("UPDATE campaigns SET state = 'live', spend_state = ?, live_since = ?, launch_status = 'GO', fingerprint = ?, health = 'HEALTHY', updated_at = ? WHERE id = ?",
        res.spend ?? 'unknown', now, check.fingerprint, now, id);
      db.run('INSERT INTO interventions (campaign_id, action, by_kind, actor_id, rule, cause, reason, adapter, at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, action, 'human', actor.id, null, JSON.stringify({ fingerprint: check.fingerprint }), reason, JSON.stringify(res), now);
      db.run("UPDATE tasks SET done_at = ?, done_by = ? WHERE campaign_id = ? AND done_at IS NULL AND code IN ('TASK_PAUSED','TASK_RESTART_POSSIBLE')", now, actor.id, id);
      db.audit('campaign.' + (action === 'start' ? 'started' : 'restarted'), { actorId: actor.id, campaignId: id, data: { reason, fingerprint: check.fingerprint, adapter: res }, at: now });
      if (!res.ok) openTask(c, 'TASK_START_MANUALLY', null, { adapter: res.mode }, now);
    });
    return getCampaign(actor, id);
  }

  async function endCampaign(actor, id) {
    if (!actor || actor.via === 'token') deny();
    const c = getCamp(id);
    if (!canTransition('end', c.state, 'human')) bad('INVALID_TRANSITION');
    const res = c.state === 'live' ? await adapter.pause(c, { reason: 'ended' }) : null;
    const now = clock();
    db.run("UPDATE campaigns SET state = 'ended', spend_state = 'off', updated_at = ? WHERE id = ?", now, id);
    db.run('UPDATE tasks SET done_at = ?, done_by = ? WHERE campaign_id = ? AND done_at IS NULL', now, actor.id, id);
    db.audit('campaign.ended', { actorId: actor.id, campaignId: id, data: { adapter: res }, at: now });
    return getCampaign(actor, id);
  }

  // ---------- evidence intake ----------

  async function ingest(actor, { events, recheck = false } = {}) {
    if (!actor) deny();
    const now = clock();
    const byKey = new Map(db.all("SELECT id, attribution_key FROM campaigns WHERE attribution_key != ''").map(r => [r.attribution_key, r.id]));
    const ids = new Set(db.all('SELECT id FROM campaigns').map(r => r.id));
    const resolveCampaign = e => {
      if (Number.isInteger(e.campaign) && ids.has(e.campaign)) return e.campaign;
      const key = e.utm_campaign ?? e.attribution_key;
      return typeof key === 'string' ? byKey.get(key) ?? null : null;
    };
    const { accepted, rejected, dropped } = prepareEvents(events, { salt: db.meta.get('pseudonym_salt'), now, resolveCampaign });
    db.tx(() => {
      for (const e of accepted) {
        db.run('INSERT INTO events (campaign_id, kind, ref, is_test, fields, amount, at, received_at, source) VALUES (?,?,?,?,?,?,?,?,?)',
          e.campaign_id, e.kind, e.ref, e.is_test, JSON.stringify(e.fields), e.amount, e.at, now, e.source);
      }
      const byKind = accepted.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});
      db.audit('evidence.ingested', { actorId: actor.id, data: { accepted: byKind, rejected: rejected.length, dropped, via: actor.via }, at: now });
    });
    const touched = [...new Set(accepted.map(e => e.campaign_id))];
    if (recheck) for (const id of touched) await runChecks(actor, id);
    return { accepted: accepted.length, rejected, droppedFields: dropped, campaigns: touched };
  }

  // ---------- tasks & audit ----------

  function listTasks(actor, { open = true } = {}) {
    if (!actor) deny();
    return db.all(`SELECT t.*, c.name AS campaign_name, u.name AS owner_name FROM tasks t
      LEFT JOIN campaigns c ON c.id = t.campaign_id LEFT JOIN users u ON u.id = t.owner_id
      ${open ? 'WHERE t.done_at IS NULL' : ''} ORDER BY t.id DESC LIMIT 300`).map(t => ({ ...t, cause: parse(t.cause, {}) }));
  }

  function completeTask(actor, id) {
    if (!actor || actor.via === 'token') deny();
    const t = db.get('SELECT * FROM tasks WHERE id = ?', id) ?? notFound();
    if (t.done_at) return t;
    const now = clock();
    db.run('UPDATE tasks SET done_at = ?, done_by = ? WHERE id = ?', now, actor.id, id);
    db.audit('task.done', { actorId: actor.id, campaignId: t.campaign_id, data: { taskId: id, code: t.code }, at: now });
    return { ok: true };
  }

  function auditLog(actor, { campaignId } = {}) {
    if (!actor) deny();
    const rows = campaignId
      ? db.all('SELECT a.*, u.name AS actor_name FROM audit a LEFT JOIN users u ON u.id = a.actor_id WHERE a.campaign_id = ? ORDER BY a.id DESC LIMIT 300', campaignId)
      : db.all('SELECT a.*, u.name AS actor_name FROM audit a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 300');
    return { entries: rows.map(r => ({ ...r, data: parse(r.data, {}) })), integrity: db.verifyAudit() };
  }

  return {
    needsSetup, createUser, login, listUsers, updateUser, changeOwnPassword, listTokens, createToken, revokeToken,
    activeDefinitions, listDefinitions, createDefinitionVersion,
    createCampaign, updateCampaign, listCampaigns, getCampaign, runChecks, recheckAll,
    pauseCampaign, startCampaign, endCampaign, ingest, listTasks, completeTask, auditLog,
    adapterType: adapter.type
  };
}
