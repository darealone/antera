import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createService } from '../src/service.js';
import { loadConfig } from '../src/config.js';
import { prepareEvents, pseudonym } from '../src/ingest.js';

const H = 3600_000, MIN = 60_000;
let now, db, svc, admin, sam, kim, calls;

const as = (u, via = 'session') => ({ ...u, via });
const SQL = [{ field: 'consent', op: 'eq', value: true }, { field: 'company_size', op: 'exists' }, { field: 'lifecycle_stage', op: 'in', value: ['sql'] }];
const good = { consent: true, company_size: '50-249', lifecycle_stage: 'sql' };
const broken = { consent: true, lifecycle_stage: 'sql' };

function setup(adapter = { type: 'demo' }) {
  now = Date.UTC(2026, 10, 22, 12);
  calls = [];
  const fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; };
  db = openDb(':memory:');
  svc = createService(db, loadConfig(null, { adapter, notify: { webhookUrl: 'https://hooks.example.test/n' } }), { clock: () => now, fetch, log: { error() {} } });
  admin = as(svc.createUser(null, { email: 'a@x.test', name: 'Admin', password: 'password-123' }));
  sam = as(svc.createUser(admin, { email: 's@x.test', name: 'Sam', role: 'approver', password: 'password-123' }));
  kim = as(svc.createUser(admin, { email: 'k@x.test', name: 'Kim', role: 'member', password: 'password-123' }));
}

async function defs() {
  await svc.createDefinitionVersion(admin, { key: 'sql', label: 'SQL', criteria: SQL });
  await svc.createDefinitionVersion(admin, { key: 'opportunity', label: 'Opp', criteria: [{ field: 'deal_stage', op: 'exists' }] });
}

async function campaign(over = {}) {
  const d = await svc.createCampaign(kim, {
    name: 'Webinar', channel: 'LinkedIn', goal_key: 'sql', attribution_key: 'web-q4',
    landing_url: 'https://x.test/w?utm_campaign=web-q4', form_fields: ['email', 'company_size', 'consent'],
    crm_mapping: { email: 'email', company_size: 'company_size', consent: 'consent' }, consent_field: 'consent', ...over
  });
  return d.campaign.id;
}

const testLead = (id, fields = good, ref = 'T' + now) => svc.ingest(kim, { events: [
  { kind: 'form_submit', campaign: id, ref, test: true, at: now - 5 * MIN },
  { kind: 'crm_record', campaign: id, ref, test: true, at: now - 4 * MIN, fields }
] });

const traffic = (id, n, fields, tag) => svc.ingest(kim, { events: Array.from({ length: n }, (_, i) => [
  { kind: 'form_submit', utm_campaign: 'web-q4', email: `${tag}${i}@lead.test`, at: now - 2 * H },
  { kind: 'crm_record', utm_campaign: 'web-q4', email: `${tag}${i}@lead.test`, at: now - 2 * H + MIN, fields }
]).flat() });

async function liveCampaign() {
  await defs();
  const id = await campaign();
  await testLead(id);
  await svc.startCampaign(sam, id, { reason: 'Chain verified, approved.' });
  now += 3 * H; // traffic two hours old, after going live
  return id;
}

beforeEach(() => setup());

test('launch: complete chain → GO; the owner cannot start it themselves (four eyes)', async () => {
  await defs();
  const id = await campaign();
  await testLead(id);
  const d = await svc.runChecks(kim, id);
  assert.equal(d.campaign.launch_status, 'GO');
  await assert.rejects(svc.startCampaign(as(kim), id, { reason: 'go go go' }), { code: 'FORBIDDEN' });
  const started = await svc.startCampaign(sam, id, { reason: 'Approved for Q4.' });
  assert.equal(started.campaign.state, 'live');
  assert.equal(started.campaign.spend_state, 'running');
  assert.equal(started.interventions[0].action, 'start');
  assert.equal(started.interventions[0].by_kind, 'human');
});

test('launch: a BLOCKED campaign cannot be started, even by an approver', async () => {
  await defs();
  const id = await campaign({ crm_mapping: { email: 'email', consent: 'consent' } });
  await testLead(id, broken);
  await assert.rejects(svc.startCampaign(sam, id, { reason: 'Please just start it.' }), err => err.code === 'NOT_GO' && err.detail.includes('MAPPING_MISSING'));
});

test('never start: API tokens (machines, n8n) cannot start or restart spend', async () => {
  await defs();
  const id = await campaign();
  await testLead(id);
  await assert.rejects(svc.startCampaign(as(sam, 'token'), id, { reason: 'from a workflow' }), { code: 'FORBIDDEN' });
});

test('C1: live campaign, CRM silently drops a field → ANTERA pauses spend, opens a task, notifies', async () => {
  const id = await liveCampaign();
  await traffic(id, 6, good, 'g');
  assert.equal((await svc.runChecks(null, id)).campaign.health, 'HEALTHY');
  await traffic(id, 14, broken, 'b');
  const d = await svc.runChecks(null, id);
  assert.equal(d.campaign.state, 'paused');
  assert.equal(d.campaign.spend_state, 'paused');
  const pause = d.interventions.find(i => i.action === 'pause');
  assert.equal(pause.by_kind, 'system');
  assert.equal(pause.rule, 'C1_PAUSE_ON_BROKEN_CHAIN');
  assert.equal(pause.cause.code, 'MON_FIELDS_DROPPED');
  assert.ok(d.tasks.some(t => t.code === 'TASK_PAUSED' && !t.done_at));
  assert.ok(calls.some(c => c.body.event === 'campaign.paused' && c.body.cause.code === 'MON_FIELDS_DROPPED'));
});

test('C3: after the fix ANTERA only says a restart is possible; a human restarts with a reason', async () => {
  const id = await liveCampaign();
  await traffic(id, 10, broken, 'b');
  await svc.runChecks(null, id);
  now += H;
  await testLead(id, good, 'T-fixed');
  const d = await svc.runChecks(null, id);
  assert.equal(d.campaign.state, 'paused', 'never restarts by itself');
  assert.ok(d.tasks.some(t => t.code === 'TASK_RESTART_POSSIBLE'));
  // Re-checking again does not restart either, and does not duplicate the task.
  const again = await svc.runChecks(null, id);
  assert.equal(again.campaign.state, 'paused');
  assert.equal(again.tasks.filter(t => t.code === 'TASK_RESTART_POSSIBLE').length, 1);
  await assert.rejects(svc.startCampaign(sam, id, { reason: '' }), { code: 'REASON_REQUIRED' });
  const r = await svc.startCampaign(sam, id, { reason: 'CRM mapping fixed, test lead complete.' });
  assert.equal(r.campaign.state, 'live');
  assert.equal(r.interventions[0].action, 'restart');
  assert.ok(r.tasks.filter(t => ['TASK_PAUSED', 'TASK_RESTART_POSSIBLE'].includes(t.code)).every(t => t.done_at));
  // After the restart, the old broken traffic is outside the window and does not pause again.
  assert.equal((await svc.runChecks(null, id)).campaign.state, 'live');
});

test('restart needs proof newer than the pause: the old test lead from before the break does not count', async () => {
  const id = await liveCampaign();
  await traffic(id, 10, broken, 'b');
  const paused = await svc.runChecks(null, id);
  assert.equal(paused.campaign.state, 'paused');
  const rt = paused.launch.results.find(r => r.id === 'roundtrip');
  assert.equal(rt.code, 'ROUNDTRIP_BEFORE_PAUSE', 'the pre-pause test lead is still within 48 h but must not count');
  assert.equal(paused.campaign.launch_status, 'BLOCKED');
  await assert.rejects(svc.startCampaign(sam, id, { reason: 'Looks fine to me.' }), err => err.code === 'NOT_GO' && err.detail.includes('ROUNDTRIP_BEFORE_PAUSE'));
  assert.ok(!paused.tasks.some(t => t.code === 'TASK_RESTART_POSSIBLE'));
});

test('C2: spend without leads is a hint — investigate, keep running', async () => {
  const id = await liveCampaign();
  await svc.ingest(kim, { events: [{ kind: 'spend', campaign: id, amount: 200, at: now - H }] });
  const d = await svc.runChecks(null, id);
  assert.equal(d.campaign.state, 'live');
  assert.equal(d.campaign.health, 'UNCLEAR');
  assert.ok(d.tasks.some(t => t.code === 'TASK_INVESTIGATE'));
});

test('editing a live campaign so the mapping breaks pauses it immediately', async () => {
  const id = await liveCampaign();
  const d = await svc.updateCampaign(kim, id, { crm_mapping: { email: 'email', consent: 'consent' } });
  assert.equal(d.campaign.state, 'paused');
  assert.equal(d.interventions[0].cause.code, 'MAPPING_MISSING');
});

test('definitions: only admins version them; a new version re-checks and can pause dependent campaigns', async () => {
  const id = await liveCampaign();
  await assert.rejects(svc.createDefinitionVersion(kim, { key: 'sql', label: 'x', criteria: SQL }), { code: 'FORBIDDEN' });
  await assert.rejects(svc.createDefinitionVersion(admin, { key: 'sql', label: 'x', criteria: [{ field: 'x', op: 'eval' }] }), { code: 'INVALID_CRITERIA' });
  // Sales now also requires the job role, which this form never collects.
  const res = await svc.createDefinitionVersion(admin, { key: 'sql', label: 'SQL', criteria: [...SQL, { field: 'job_role', op: 'exists' }], note: 'ICP v2' });
  assert.equal(res.version, 2);
  const list = svc.listDefinitions(admin).filter(d => d.key === 'sql');
  assert.deepEqual(list.map(d => [d.version, d.active]), [[2, true], [1, false]], 'old versions are kept, not edited');
  const d = svc.getCampaign(admin, id);
  assert.equal(d.campaign.state, 'paused');
  assert.equal(d.interventions[0].cause.code, 'MAPPING_MISSING');
});

test('manual adapter: a pause the platform cannot receive becomes a task for a human', async () => {
  setup({ type: 'manual' });
  const id = await liveCampaign();
  await traffic(id, 10, broken, 'b');
  const d = await svc.runChecks(null, id);
  assert.equal(d.campaign.state, 'paused');
  assert.equal(d.campaign.spend_state, 'unknown');
  assert.ok(d.tasks.some(t => t.code === 'TASK_PAUSE_MANUALLY'));
});

test('webhook adapter: pause is sent to the configured URL (e.g. an n8n workflow)', async () => {
  setup({ type: 'webhook', url: 'https://n8n.example.test/webhook/ads' });
  const id = await liveCampaign();
  await traffic(id, 10, broken, 'b');
  await svc.runChecks(null, id);
  const call = calls.find(c => c.url === 'https://n8n.example.test/webhook/ads' && c.body.action === 'pause');
  assert.ok(call, 'pause was sent');
  assert.equal(call.body.why.rule, 'C1_PAUSE_ON_BROKEN_CHAIN');
});

test('ingest: emails are hashed, direct identifiers dropped, nothing personal stored', async () => {
  await defs();
  const id = await campaign();
  const r = await svc.ingest(kim, { events: [
    { kind: 'form_submit', campaign: id, email: 'Jane.Doe@Corp.test', fields: { first_name: 'Jane', phone: '+49 123', company_size: '50-249' } },
    { kind: 'crm_record', utm_campaign: 'web-q4', email: 'jane.doe@corp.test', fields: { last_name: 'Doe', consent: true } },
    { kind: 'form_submit', utm_campaign: 'nope', email: 'x@y.test' },
    { kind: 'teleport', campaign: id }
  ] });
  assert.equal(r.accepted, 2);
  assert.deepEqual(r.rejected.map(x => x.error), ['UNKNOWN_CAMPAIGN', 'UNKNOWN_KIND']);
  assert.deepEqual(r.droppedFields, ['email', 'first_name', 'last_name', 'phone']);
  const rows = db.all('SELECT ref, fields FROM events');
  const dump = JSON.stringify(rows);
  for (const s of ['Jane', 'Doe', 'corp.test', '+49']) assert.ok(!dump.includes(s), `${s} must not be stored`);
  assert.equal(rows[0].ref, rows[1].ref, 'same person → same pseudonym, so submission and CRM record still link');
});

test('ingest: pseudonyms depend on the per-installation salt', () => {
  assert.notEqual(pseudonym('a', 'x@y.test'), pseudonym('b', 'x@y.test'));
  assert.equal(pseudonym('a', 'X@Y.test '), pseudonym('a', 'x@y.test'));
  const r = prepareEvents([{ kind: 'form_submit', campaign: 1, ref: 'r1', at: Date.UTC(2030, 0, 1) }], { salt: 's', now: Date.UTC(2026, 0, 1), resolveCampaign: () => 1 });
  assert.equal(r.rejected[0].error, 'TIME_IN_FUTURE');
});

test('audit: every step is logged and the hash chain verifies; tampering is detected', async () => {
  const id = await liveCampaign();
  await traffic(id, 10, broken, 'b');
  await svc.runChecks(null, id);
  const log = svc.auditLog(admin, { campaignId: id });
  const actions = log.entries.map(e => e.action);
  for (const a of ['campaign.created', 'campaign.started', 'evidence.ingested', 'checks.run', 'campaign.paused', 'task.created']) assert.ok(actions.includes(a) || svc.auditLog(admin).entries.some(e => e.action === a), a);
  assert.deepEqual(log.integrity, { ok: true });
  db.run("UPDATE audit SET data = '{}' WHERE action = 'campaign.paused'");
  assert.equal(db.verifyAudit().ok, false);
});
