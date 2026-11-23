import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createService } from '../src/service.js';
import { loadConfig } from '../src/config.js';
import { computeSignals, checkDraft, coverage, gapState, claimStatus, DEFAULT_PROFILES } from '../src/portability.js';
import { DRAFT_TOOLS } from '../src/drafter.js';

const DAY = 86_400_000, MIN = 60_000;
const NOW = Date.UTC(2026, 10, 23, 12);
const P = Object.fromEntries(DEFAULT_PROFILES.map(p => [p.key, p]));

// ---------- signals (pure) ----------

const deal = { ref: 'D-1', first_at: NOW - 210 * DAY, company_size: '1000+', closed: false };
const sig = (o) => computeSignals({ deal, profiles: DEFAULT_PROFILES, now: NOW, ...o });
const codes = (r, key) => r.get(key).signals.map(s => s.code);

test('S01: comparable won deals had finance involved before the proposal; this one has none → hint', () => {
  const won = [{ ref: 'W1', company_size: '1000+', before: { finance: [10] } }, { ref: 'W2', company_size: '1000+', before: { finance: [11] } }, { ref: 'W3', company_size: '10-49', before: {} }];
  const r = sig({ wonDeals: won });
  assert.deepEqual(codes(r, 'finance'), ['S01_MISSING_ROLE']);
  assert.deepEqual(r.get('finance').signals[0].evidence, ['E10', 'E11']);
  assert.equal(r.get('finance').signals[0].params.won, 2, 'only deals of the same size count');
  assert.deepEqual(codes(sig({ wonDeals: won.slice(0, 1) }), 'finance'), [], 'one comparable deal is not a pattern');
  assert.deepEqual(codes(sig({ wonDeals: won, activities: [{ id: 5, at: NOW - 100 * DAY, type: 'meeting', roles: ['finance'] }] }), 'finance'), [], 'involved → no signal');
});

test('S02/S05/S06: mentioned but not involved, raised late, champion without an answer — each with a quote', () => {
  const body = 'Der Betriebsrat fragt, ob man sehen kann, wer wie lange arbeitet. Das müsste ich noch klären. Vorlage im Lenkungskreis nächste Woche.';
  const r = sig({ conversations: [{ id: 7, at: NOW - 20 * DAY, body }] });
  assert.deepEqual(codes(r, 'works_council'), ['S02_MENTIONED_NOT_INVOLVED', 'S05_LATE_RISK_TOPIC', 'S06_CHAMPION_NO_ANSWER']);
  assert.ok(!codes(r, 'management').includes('S06_CHAMPION_NO_ANSWER'), 'the unsure answer belongs to the topic raised before it');
  for (const s of r.get('works_council').signals) { assert.deepEqual(s.evidence, ['E7']); assert.ok(s.quote.includes('Betriebsrat')); }
  assert.equal(r.get('works_council').group, 'mention');
  assert.equal(r.get('privacy').group, 'never');
});

test('S03: silence after the topic went to the steering committee', () => {
  const conv = [{ id: 8, at: NOW - 20 * DAY, body: 'Champion takes it to the steering committee on Tuesday.' }];
  assert.ok(codes(sig({ conversations: conv }), 'management').includes('S03_SILENCE_AFTER_ESCALATION'));
  const after = [{ id: 9, at: NOW - 10 * DAY, type: 'call', roles: ['champion'] }];
  assert.ok(!codes(sig({ conversations: conv, activities: after }), 'management').includes('S03_SILENCE_AFTER_ESCALATION'), 'activity afterwards → no silence');
  assert.ok(!codes(sig({ conversations: [{ ...conv[0], at: NOW - 5 * DAY }] }), 'management').includes('S03_SILENCE_AFTER_ESCALATION'), 'too early to call it silence');
});

test('keywords match whole words only ("dpa" does not fire inside another word)', () => {
  const r = sig({ conversations: [{ id: 1, at: NOW - 10 * DAY, body: 'We discussed the update pipeline; adpatch is fine.' }] });
  assert.equal(r.get('privacy').group, 'never');
});

// ---------- drafts, claims, coverage (pure) ----------

const approved = { id: 1, topic: 'works_council', text: 'Individual performance evaluation is technically disabled.', source: 'Spec 3.2', parts: ['monitoring'], status: 'approved' };
const pending = { id: 2, topic: 'works_council', text: 'A template works agreement is available.', source: 'Legal', parts: ['agreement'], status: 'pending' };
const claims = new Map([[1, approved], [2, pending]]);
const evidence = new Map([['E7', 'Der Betriebsrat fragt, ob man sehen kann, wer wie lange arbeitet.']]);

test('draft check: claim text comes from the library; quotes must exist; anything else blocks approval', () => {
  const c = checkDraft([
    { kind: 'claim', claim_id: 1, text: 'We never monitor anyone, guaranteed!' },     // a paraphrase attempt is ignored
    { kind: 'evidence', evidence_id: 'E7', quote: 'ob man sehen kann, wer wie lange arbeitet' },
    { kind: 'recommendation', text: 'Let the champion read the paragraph out himself.' }
  ], claims, evidence);
  assert.equal(c.blocked, false);
  assert.equal(c.lines[0].text, approved.text, 'claim wording is copied from the library, never from the draft');
  const bad = checkDraft([{ kind: 'claim', claim_id: 2 }, { kind: 'claim', claim_id: 99 }, { kind: 'evidence', evidence_id: 'E7', quote: 'the works council loves it' }, { kind: 'free', text: 'We are GDPR certified.' }], claims, evidence);
  assert.equal(bad.blocked, true);
  assert.deepEqual(bad.lines.map(l => l.reason), ['CLAIM_PENDING', 'CLAIM_UNKNOWN', 'QUOTE_NOT_FOUND', 'UNBACKED']);
});

test('coverage: approved does not mean answered — every open part stays visible', () => {
  const cov = coverage(P.works_council, checkDraft([{ kind: 'claim', claim_id: 1 }], claims, evidence).lines);
  assert.equal(cov.level, 'partial');
  assert.deepEqual(cov.open, ['access', 'agreement']);
});

test('claim status: needs product, legal and privacy; retired or superseded claims are not usable', () => {
  assert.deepEqual(claimStatus({}, [{ capacity: 'product' }]), { status: 'pending', missing: ['legal', 'privacy'] });
  assert.equal(claimStatus({}, [{ capacity: 'product' }, { capacity: 'legal' }, { capacity: 'privacy' }]).status, 'approved');
  assert.equal(claimStatus({ retired_at: 1 }, []).status, 'retired');
  assert.equal(claimStatus({ superseded_by: 3 }, []).status, 'superseded');
});

test('gap states follow the four steps; a changed draft needs a new approval and briefing', () => {
  const chk = { blocked: false, empty: false }, full = { level: 'full' }, part = { level: 'partial' };
  assert.equal(gapState({}, chk, full).state, 'hint');
  assert.equal(gapState({ classification: 'handled' }, chk, full).state, 'dismissed');
  assert.equal(gapState({ classification: 'shadow' }, { ...chk, empty: true }, full).state, 'risk');
  assert.equal(gapState({ classification: 'notyet', draft_version: 1 }, chk, full).step, 3);
  assert.equal(gapState({ classification: 'notyet', draft_version: 1, approved_version: 1 }, chk, full).step, 4);
  assert.equal(gapState({ classification: 'notyet', draft_version: 1, approved_version: 1, briefed_version: 1 }, chk, full).state, 'prepared');
  assert.equal(gapState({ classification: 'notyet', draft_version: 1, approved_version: 1, briefed_version: 1 }, chk, part).state, 'briefed_partial');
  const edited = gapState({ classification: 'notyet', draft_version: 2, approved_version: 1, briefed_version: 1 }, chk, full);
  assert.equal(edited.step, 3); assert.equal(edited.staleApproval, true);
  assert.equal(gapState({ classification: 'notyet', draft_version: 1, approved_version: 1, briefed_version: 1 }, { ...chk, blocked: true }, full).step, 3, 'a claim retired after approval reopens the gap');
});

// ---------- the workflow through the service ----------

let db, svc, now, admin, sam, kim, pat, lee, calls, script;
const as = (u, via = 'session') => ({ ...u, via });
const fakeClient = { beta: { messages: { create: async params => { calls.push(params); return script.shift()(params); } } } };

beforeEach(() => {
  now = NOW; calls = []; script = [];
  db = openDb(':memory:');
  svc = createService(db, loadConfig(null, { adapter: { type: 'demo' } }), { clock: () => now, anthropic: fakeClient, log: { error() {} } });
  admin = as(svc.createUser(null, { email: 'a@x.test', name: 'Admin', password: 'password-123' }));
  sam = as(svc.createUser(admin, { email: 's@x.test', name: 'Sam', role: 'approver', password: 'password-123' }));
  pat = as(svc.createUser(admin, { email: 'p@x.test', name: 'Pat', role: 'approver', password: 'password-123' }));
  lee = as(svc.createUser(admin, { email: 'l@x.test', name: 'Lee', role: 'approver', password: 'password-123' }));
  kim = as(svc.createUser(admin, { email: 'k@x.test', name: 'Kim', role: 'member', password: 'password-123' }));
});

async function openDeal() {
  const c = await svc.createCampaign(kim, { name: 'C', goal_key: 'sql', form_fields: ['email'], crm_mapping: { email: 'email' } });
  const id = c.campaign.id;
  await svc.ingest(kim, { events: [
    { kind: 'crm_record', campaign: id, ref: 'D-9', at: now - 220 * DAY, fields: { company_size: '1000+' } },
    { kind: 'deal', campaign: id, ref: 'D-9', at: now - 210 * DAY, fields: { deal_stage: 'discovery' } },
    { kind: 'activity', campaign: id, ref: 'D-9', at: now - 200 * DAY, fields: { type: 'meeting', roles: 'champion' } },
    { kind: 'conversation', campaign: id, ref: 'D-9', consent: true, at: now - 20 * DAY, text: 'Der Betriebsrat fragt, ob man sehen kann, wer wie lange arbeitet. Das müsste ich noch klären.' }
  ] });
  return id;
}
async function approvedClaim(by = kim) {
  const { id } = svc.createClaim(by, { topic: 'works_council', text: 'Individual performance evaluation is technically disabled.', source: 'Product spec 3.2', parts: ['monitoring', 'access'] });
  svc.approveClaim(sam, id, { capacity: 'product' }); svc.approveClaim(pat, id, { capacity: 'legal' }); svc.approveClaim(lee, id, { capacity: 'privacy' });
  return id;
}

test('claims: three different people, none of them the author; a revision starts over', () => {
  const { id } = svc.createClaim(sam, { topic: 'works_council', text: 'Individual performance evaluation is disabled.', source: 'Spec', parts: ['monitoring'] });
  assert.throws(() => svc.approveClaim(sam, id, { capacity: 'product' }), { code: 'AUTHOR_CANNOT_APPROVE' });
  assert.throws(() => svc.approveClaim(kim, id, { capacity: 'product' }), { code: 'FORBIDDEN' }, 'marketing cannot approve claims');
  assert.throws(() => svc.approveClaim(as(pat, 'token'), id, { capacity: 'product' }), { code: 'FORBIDDEN' }, 'not via API token');
  svc.approveClaim(pat, id, { capacity: 'product' });
  assert.throws(() => svc.approveClaim(pat, id, { capacity: 'legal' }), { code: 'ONE_CAPACITY_PER_PERSON' });
  assert.throws(() => svc.createClaim(kim, { topic: 'works_council', text: 'Something long enough.', source: 'x', parts: ['nonsense'] }), { code: 'SOURCE_REQUIRED' });
  assert.throws(() => svc.createClaim(kim, { topic: 'works_council', text: 'Something long enough.', source: 'Spec', parts: ['nonsense'] }), { code: 'INVALID_PARTS' });
  svc.approveClaim(lee, id, { capacity: 'legal' }); svc.approveClaim(admin, id, { capacity: 'privacy' });
  assert.equal(svc.listClaims(kim).find(c => c.id === id).status, 'approved');
  const { id: v2 } = svc.reviseClaim(kim, id, { text: 'Individual performance evaluation is technically disabled.', source: 'Spec 3.3', parts: ['monitoring'] });
  const list = svc.listClaims(kim);
  assert.equal(list.find(c => c.id === id).status, 'superseded');
  assert.equal(list.find(c => c.id === v2).status, 'pending', 'approvals do not carry over to a new version');
});

test('deal map: signals open grey hints; one gap per role; hints without signals disappear, classified gaps stay', async () => {
  const cid = await openDeal();
  const d = svc.getDeal(kim, cid, 'D-9');
  assert.equal(d.summary.overall, 'UNREVIEWED');
  const wc = d.roles.find(r => r.profile.key === 'works_council');
  assert.equal(wc.group, 'mention');
  assert.equal(wc.gap.state, 'hint');
  assert.ok(wc.gap.signals.some(s => s.code === 'S06_CHAMPION_NO_ANSWER'));
  assert.equal(d.roles.find(r => r.profile.key === 'privacy').gap, null);
  // The works council joins a meeting: S02 no longer applies, but S05/S06 remain → the hint stays.
  await svc.ingest(kim, { events: [{ kind: 'activity', campaign: cid, ref: 'D-9', at: now - DAY, fields: { type: 'meeting', roles: 'works_council,champion' } }] });
  const d2 = svc.getDeal(kim, cid, 'D-9');
  assert.equal(d2.roles.find(r => r.profile.key === 'works_council').group, 'in');
  assert.ok(!d2.roles.find(r => r.profile.key === 'works_council').gap.signals.some(s => s.code === 'S02_MENTIONED_NOT_INVOLVED'));
});

test('four steps: classify → draft (claims only) → approve with three tests → brief; nothing is ever sent', async () => {
  const cid = await openDeal();
  const claimId = await approvedClaim();
  const gap = svc.getDeal(kim, cid, 'D-9').roles.find(r => r.profile.key === 'works_council').gap;

  assert.throws(() => svc.saveDraft(kim, gap.id, { lines: [{ kind: 'claim', claim_id: claimId }] }), { code: 'CLASSIFY_FIRST' });
  assert.throws(() => svc.classifyGap(as(kim, 'token'), gap.id, { classification: 'shadow' }), { code: 'FORBIDDEN' }, 'machines cannot classify');
  svc.classifyGap(kim, gap.id, { classification: 'shadow' });

  svc.saveDraft(kim, gap.id, { lines: [{ kind: 'claim', claim_id: claimId }, { kind: 'free', text: 'And it is 100% GDPR compliant.' }] });
  assert.throws(() => svc.approveDraft(kim, gap.id, { tests: { corridor: true, protection: true, room: true } }), { code: 'DRAFT_BLOCKED' }, 'an unbacked line blocks approval');
  svc.saveDraft(kim, gap.id, { lines: [{ kind: 'claim', claim_id: claimId }, { kind: 'recommendation', text: 'Send it as a one-page note, no meeting.' }] });
  assert.throws(() => svc.approveDraft(kim, gap.id, { tests: { corridor: true, protection: true } }), { code: 'TESTS_REQUIRED' });
  await assert.rejects(svc.logBriefing(kim, gap.id, {}), { code: 'APPROVE_FIRST' });
  assert.equal(svc.approveDraft(kim, gap.id, { tests: { corridor: true, protection: true, room: true } }).coverage, 'partial');
  await svc.logBriefing(kim, gap.id, { date: '2026-11-20', participants: 'Champion', note: 'Passed on as a note.' });

  const g = svc.getDeal(kim, cid, 'D-9').roles.find(r => r.profile.key === 'works_council').gap;
  assert.equal(g.state, 'briefed_partial', 'briefed, but the agreement question is still open');
  assert.equal(g.briefing.mode, 'handover', 'a silent review gets a document, not a meeting');
  assert.deepEqual(g.briefing.open, ['agreement']);

  // Editing the draft invalidates approval and briefing; retiring a claim reopens the gap.
  svc.saveDraft(kim, gap.id, { lines: [{ kind: 'claim', claim_id: claimId }] });
  assert.equal(svc.getDeal(kim, cid, 'D-9').roles.find(r => r.profile.key === 'works_council').gap.step, 3);
  svc.approveDraft(kim, gap.id, { tests: { corridor: true, protection: true, room: true } });
  svc.retireClaim(admin, claimId);
  const after = svc.getDeal(kim, cid, 'D-9').roles.find(r => r.profile.key === 'works_council').gap;
  assert.equal(after.step, 3); assert.equal(after.draft[0].reason, 'CLAIM_RETIRED');

  const actions = svc.auditLog(admin).entries.map(e => e.action);
  for (const a of ['gap.classified', 'gap.draft_saved', 'gap.draft_approved', 'gap.briefed', 'claim.retired']) assert.ok(actions.includes(a), a);
  assert.equal(db.verifyAudit().ok, true);
});

test('"already handled" dismisses the hint and is counted, so false alarms are visible', async () => {
  const cid = await openDeal();
  const gap = svc.getDeal(kim, cid, 'D-9').roles.find(r => r.profile.key === 'works_council').gap;
  svc.classifyGap(kim, gap.id, { classification: 'handled' });
  const { stats } = svc.listDeals(kim);
  assert.equal(stats.dismissed, 1);
  assert.equal(svc.getDeal(kim, cid, 'D-9').roles.find(r => r.profile.key === 'works_council').gap.state, 'dismissed');
});

test('AI draft: picks claim ids only; code copies the wording, flags invented ids and false quotes; a person must approve', async () => {
  const cid = await openDeal();
  const claimId = await approvedClaim();
  const gap = svc.getDeal(kim, cid, 'D-9').roles.find(r => r.profile.key === 'works_council').gap;
  svc.classifyGap(kim, gap.id, { classification: 'notyet' });
  const convo = svc.getDeal(kim, cid, 'D-9').conversations[0];
  script = [
    () => ({ content: [{ type: 'tool_use', id: 't1', name: 'get_approved_claims', input: {} }, { type: 'tool_use', id: 't2', name: 'get_deal_conversations', input: {} }], stop_reason: 'tool_use', usage: {}, model: 'claude-opus-5-5' }),
    () => ({ content: [{ type: 'tool_use', id: 't3', name: 'submit_draft', input: {
      claim_ids: [claimId, 424242],
      quotes: [{ evidence_id: convo.id, quote: 'ob man sehen kann, wer wie lange arbeitet' }, { evidence_id: convo.id, quote: 'the works council approved it already' }],
      recommendations: ['The champion decides whether the works council joins the next meeting.'], note: 'Monitoring is covered; the works agreement is open.' } }], stop_reason: 'tool_use', usage: {}, model: 'claude-opus-5-5' })
  ];
  const r = await svc.draftGap(kim, gap.id);
  assert.equal(r.note, 'Monitoring is covered; the works agreement is open.');
  const g = svc.getDeal(kim, cid, 'D-9').roles.find(x => x.profile.key === 'works_council').gap;
  assert.equal(g.draft_source, 'ai');
  assert.deepEqual(g.draft.map(l => l.ok), [true, false, true, false, true]);
  assert.deepEqual(g.draft.filter(l => !l.ok).map(l => l.reason), ['CLAIM_UNKNOWN', 'QUOTE_NOT_FOUND']);
  assert.equal(g.step, 3, 'an AI draft is never approved automatically');
  assert.equal(g.blocked, true);
  assert.deepEqual(calls[0].tools.map(t => t.name).sort(), ['get_approved_claims', 'get_deal_conversations', 'get_role_context', 'submit_draft'], 'no tool can write, send or approve');
  assert.ok(DRAFT_TOOLS.every(t => t.strict));
  assert.equal(calls[0].model, 'claude-opus-5-5');
});

test('veto profiles: seeded once, versioned by admins only', () => {
  assert.equal(svc.activeProfiles().length, 6);
  assert.throws(() => svc.createProfileVersion(kim, { ...P.finance }), { code: 'FORBIDDEN' });
  assert.throws(() => svc.createProfileVersion(admin, { ...P.finance, veto: 'absolute' }), { code: 'INVALID_PROFILE' });
  const r = svc.createProfileVersion(admin, { ...P.finance, keywords: [...P.finance.keywords, 'kaufmännische leitung'], note: 'Added German title' });
  assert.equal(r.version, 2);
  assert.equal(svc.activeProfiles().find(p => p.key === 'finance').version, 2);
});

test('activities name roles, never people; invalid ones are rejected', async () => {
  const cid = await openDeal();
  const r = await svc.ingest(kim, { events: [
    { kind: 'activity', campaign: cid, ref: 'D-9', fields: { type: 'meeting', roles: 'Max Mustermann' } },
    { kind: 'activity', campaign: cid, ref: 'D-9', fields: { type: 'party', roles: 'finance' } },
    { kind: 'activity', campaign: cid, ref: 'D-9', fields: { type: 'email', roles: 'finance, it_security,finance', name: 'Jane' } }
  ] });
  assert.deepEqual(r.rejected.map(x => x.error), ['INVALID_ROLES', 'INVALID_ACTIVITY_TYPE']);
  assert.equal(JSON.parse(db.get("SELECT fields FROM events WHERE kind = 'activity' ORDER BY id DESC LIMIT 1").fields).roles, 'finance,it_security');
});
