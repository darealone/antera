import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCriteria, requiredFields, matches } from '../src/definitions.js';
import { launchCheck, monitor, fingerprint, staticChecks, LAUNCH } from '../src/chain.js';
import { decide, canTransition, ACTION_TYPES, TRANSITIONS } from '../src/controller.js';

const NOW = Date.UTC(2026, 10, 22, 12);
const MIN = 60_000, H = 60 * MIN;

const SQL = { key: 'sql', version: 1, criteria: [
  { field: 'consent', op: 'eq', value: true },
  { field: 'company_size', op: 'exists' },
  { field: 'lifecycle_stage', op: 'in', value: ['sql', 'opportunity'] }
] };
const OPP = { key: 'opportunity', version: 1, criteria: [{ field: 'deal_stage', op: 'exists' }] };
const DEFS = [SQL, OPP];

const campaign = (over = {}) => ({
  id: 1, state: 'draft', owner_id: 1, goal_key: 'sql', attribution_key: 'webinar-q4',
  landing_url: 'https://example.test/webinar?utm_source=linkedin&utm_campaign=webinar-q4',
  form_fields: ['email', 'company', 'company_size', 'consent'],
  crm_mapping: { email: 'email', company: 'company', company_size: 'company_size', consent: 'consent' },
  consent_field: 'consent', ...over
});
const goodRecord = { at: NOW - 59 * MIN, fields: { consent: true, company_size: '50-249', lifecycle_stage: 'sql' } };
const goodTest = { submission: { ref: 't1', at: NOW - H }, record: goodRecord };
const check = (over = {}) => launchCheck({ campaign: campaign(), definitions: DEFS, test: goodTest, now: NOW, ...over });
const byId = (res, id) => res.results.find(x => x.id === id);

// ---------- definitions ----------

test('definitions: criteria are validated as data', () => {
  assert.deepEqual(validateCriteria(SQL.criteria), []);
  assert.ok(validateCriteria([]).length);
  assert.ok(validateCriteria([{ field: 'Score', op: 'gte', value: 5 }]).length, 'field names must be snake_case');
  assert.ok(validateCriteria([{ field: 'score', op: 'gte', value: '5' }]).length, 'numeric ops need numbers');
  assert.ok(validateCriteria([{ field: 'score', op: 'eval', value: 1 }]).length, 'unknown ops are rejected');
});

test('definitions: a missing field is reported apart from a value that does not qualify', () => {
  assert.deepEqual(requiredFields(SQL.criteria), ['company_size', 'consent', 'lifecycle_stage']);
  assert.equal(matches(SQL.criteria, goodRecord.fields).ok, true);
  const m = matches(SQL.criteria, { consent: true, lifecycle_stage: 'mql' });
  assert.deepEqual(m.missing, ['company_size']);
  assert.deepEqual(m.failed, ['lifecycle_stage']);
});

// ---------- launch chain ----------

test('chain: complete, fresh chain → GO, in click-to-deal order', () => {
  const res = check();
  assert.equal(res.status, LAUNCH.GO);
  assert.deepEqual(res.results.map(x => x.stage), ['click', 'form', 'crm', 'test', 'definition', 'deal']);
});

test('chain: form collects company_size but the CRM mapping drops it → BLOCKED at the CRM step', () => {
  const res = check({ campaign: campaign({ crm_mapping: { email: 'email', company: 'company', consent: 'consent' } }) });
  assert.equal(res.status, LAUNCH.BLOCKED);
  assert.equal(byId(res, 'mapping').code, 'MAPPING_MISSING');
  assert.deepEqual(byId(res, 'mapping').params.fields, ['company_size']);
});

test('chain: CRM-computed fields (lifecycle_stage) need no form mapping, but must arrive in the test record', () => {
  assert.equal(byId(check(), 'mapping').status, 'pass');
  const res = check({ test: { ...goodTest, record: { at: NOW - 59 * MIN, fields: { consent: true, company_size: '50-249' } } } });
  assert.equal(byId(res, 'roundtrip').code, 'ROUNDTRIP_FIELDS_MISSING');
  assert.deepEqual(byId(res, 'roundtrip').params.fields, ['lifecycle_stage']);
});

test('chain: no test lead is unknown, not a failure, and still blocks the launch', () => {
  const res = check({ test: null });
  assert.equal(byId(res, 'roundtrip').status, 'unknown');
  assert.equal(res.status, LAUNCH.BLOCKED);
});

test('chain: test lead not in the CRM: pending within the grace period, failed after it', () => {
  const pending = check({ test: { submission: { ref: 't1', at: NOW - 10 * MIN }, record: null } });
  assert.equal(byId(pending, 'roundtrip').code, 'ROUNDTRIP_PENDING');
  const lost = check({ test: { submission: { ref: 't1', at: NOW - 2 * H }, record: null } });
  assert.equal(byId(lost, 'roundtrip').code, 'ROUNDTRIP_NOT_SYNCED');
  assert.equal(byId(lost, 'roundtrip').status, 'fail');
});

test('chain: an old test lead is stale', () => {
  const res = check({ test: { submission: { ref: 't1', at: NOW - 72 * H }, record: goodRecord } });
  assert.equal(byId(res, 'roundtrip').code, 'ROUNDTRIP_STALE');
});

test('chain: tracking — missing UTM and mismatched attribution are caught', () => {
  assert.equal(byId(check({ campaign: campaign({ landing_url: 'https://example.test/webinar' }) }), 'tracking').code, 'TRACKING_NO_UTM');
  assert.equal(byId(check({ campaign: campaign({ attribution_key: 'other' }) }), 'tracking').code, 'TRACKING_MISMATCH');
  assert.equal(byId(check({ campaign: campaign({ landing_url: 'not a url' }) }), 'tracking').code, 'TRACKING_BAD_URL');
});

test('chain: consent must be on the form and mapped', () => {
  assert.equal(byId(check({ campaign: campaign({ consent_field: '' }) }), 'consent').code, 'CONSENT_MISSING');
  assert.equal(byId(check({ campaign: campaign({ crm_mapping: { company_size: 'company_size' } }) }), 'consent').code, 'CONSENT_NOT_MAPPED');
});

test('chain: a goal without an active definition cannot be measured', () => {
  const res = check({ definitions: [OPP] });
  assert.equal(byId(res, 'goal').code, 'GOAL_UNDEFINED');
  assert.equal(byId(res, 'mapping').status, 'unknown');
  assert.equal(byId(check({ definitions: [SQL] }), 'deal').code, 'DEAL_NO_DEFINITION');
});

test('chain: deterministic — same input, same output; needs an explicit clock', () => {
  assert.deepEqual(check(), check());
  assert.throws(() => launchCheck({ campaign: campaign(), definitions: DEFS }), /explicit `now`/);
});

test('fingerprint: changes with a new definition version or an edited mapping, not with key order', () => {
  const fp = fingerprint(campaign(), DEFS);
  assert.equal(fp, fingerprint(campaign({ crm_mapping: { consent: 'consent', company_size: 'company_size', company: 'company', email: 'email' } }), DEFS));
  assert.notEqual(fp, fingerprint(campaign(), [{ ...SQL, version: 2 }, OPP]));
  assert.notEqual(fp, fingerprint(campaign({ crm_mapping: { consent: 'consent' } }), DEFS));
});

// ---------- monitoring ----------

const subs = (n, at = NOW - 3 * H, prefix = 'p') => Array.from({ length: n }, (_, i) => ({ ref: `${prefix}${i}`, at }));
const recs = (list, fields = goodRecord.fields) => new Map(list.map(x => [x.ref, { at: x.at + MIN, fields }]));

test('monitor: healthy traffic passes', () => {
  const s = subs(20);
  const res = monitor({ campaign: campaign({ state: 'live' }), definitions: DEFS, window: { submissions: s, records: recs(s), spend: 300 }, now: NOW });
  assert.deepEqual(res.map(x => x.status), ['pass', 'pass', 'pass']);
});

test('monitor: CRM silently drops company_size → MON_FIELDS_DROPPED names the field', () => {
  const s = subs(20);
  const res = monitor({ campaign: campaign({ state: 'live' }), definitions: DEFS, window: { submissions: s, records: recs(s, { consent: true, lifecycle_stage: 'sql' }), spend: 300 }, now: NOW });
  const c = res.find(x => x.id === 'complete');
  assert.equal(c.code, 'MON_FIELDS_DROPPED');
  assert.deepEqual(c.params.fields, ['company_size']);
  assert.equal(c.params.pct, 0);
});

test('monitor: leads never reach the CRM → MON_NOT_SYNCED', () => {
  const s = subs(10);
  const res = monitor({ campaign: campaign({ state: 'live' }), definitions: DEFS, window: { submissions: s, records: recs(s.slice(0, 5)), spend: 100 }, now: NOW });
  assert.equal(res.find(x => x.id === 'sync').code, 'MON_NOT_SYNCED');
});

test('monitor: too little traffic or spend without leads is a hint (unknown), never a failure', () => {
  const few = subs(2);
  const res = monitor({ campaign: campaign({ state: 'live' }), definitions: DEFS, window: { submissions: few, records: recs(few), spend: 0 }, now: NOW });
  assert.ok(res.every(x => x.status !== 'fail'));
  const silent = monitor({ campaign: campaign({ state: 'live' }), definitions: DEFS, window: { submissions: [], records: new Map(), spend: 250 }, now: NOW });
  assert.equal(silent.find(x => x.id === 'activity').code, 'MON_SPEND_NO_LEADS');
  assert.ok(silent.every(x => x.status !== 'fail'));
});

// ---------- controller ----------

test('controller: live + broken chain → pause, task, notify (C1)', () => {
  const d = decide({ campaign: { state: 'live' }, results: [{ id: 'complete', status: 'fail', code: 'MON_FIELDS_DROPPED', params: {} }] });
  assert.equal(d.rule, 'C1_PAUSE_ON_BROKEN_CHAIN');
  assert.deepEqual(d.actions.map(a => a.type), ['pause', 'task', 'notify']);
  assert.equal(d.actions[0].cause.code, 'MON_FIELDS_DROPPED');
});

test('controller: live + only unknowns → investigate, do NOT pause (absence is a hint, not a finding)', () => {
  const d = decide({ campaign: { state: 'live' }, results: [{ id: 'activity', status: 'unknown', code: 'MON_SPEND_NO_LEADS', params: {} }] });
  assert.equal(d.rule, 'C2_INVESTIGATE_UNCLEAR');
  assert.ok(!d.actions.some(a => a.type === 'pause'));
});

test('controller: paused + healthy → tells a human restart is possible, never restarts itself (C3)', () => {
  const d = decide({ campaign: { state: 'paused' }, results: [{ id: 'x', status: 'pass', code: 'OK', params: {} }] });
  assert.equal(d.rule, 'C3_READY_FOR_HUMAN_RESTART');
  assert.ok(d.actions.every(a => a.type === 'task' || a.type === 'notify'));
});

test('controller: may stop, never start — no input can produce a start, restart or budget action', () => {
  const statuses = ['pass', 'fail', 'unknown'];
  for (const state of ['draft', 'live', 'paused', 'ended']) for (const a of statuses) for (const b of statuses) {
    const d = decide({ campaign: { state }, results: [{ id: 'a', status: a, code: 'X', params: {} }, { id: 'b', status: b, code: 'Y', params: {} }] });
    for (const act of d.actions) assert.ok(ACTION_TYPES.includes(act.type), `unexpected action ${act.type}`);
    if (state !== 'live') assert.ok(!d.actions.some(x => x.type === 'pause'), 'only live campaigns are paused');
  }
});

test('transitions: the system may only pause; start and restart are human-only', () => {
  assert.equal(canTransition('pause', 'live', 'system'), true);
  assert.equal(canTransition('start', 'draft', 'system'), false);
  assert.equal(canTransition('restart', 'paused', 'system'), false);
  assert.equal(canTransition('restart', 'paused', 'human'), true);
  assert.equal(canTransition('start', 'live', 'human'), false);
  for (const [name, t] of Object.entries(TRANSITIONS)) if (t.to === 'live') assert.deepEqual(t.by, ['human'], `${name} must be human-only`);
});

test('staticChecks: the configuration part runs without test leads (used while live)', () => {
  assert.deepEqual(staticChecks({ campaign: campaign(), definitions: DEFS }).map(x => x.status), ['pass', 'pass', 'pass', 'pass', 'pass']);
});
