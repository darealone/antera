// Level 3 · Decision portability: storage, permissions and audit around the pure rules in portability.js.
// Every step that commits to something (classify, approve, brief, approve a claim) needs a person who is
// logged in personally; API tokens (machines, n8n) may only send evidence and read.
import { DEFAULT_PROFILES, validateProfile, computeSignals, claimStatus, checkDraft, coverage, gapState, dealSummary, CAPACITIES, ARGUMENT_TESTS, DEFAULT_SETTINGS } from './portability.js';
import { HttpError } from './service.js';

const DAY = 86_400_000;
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const deny = () => { throw new HttpError(403, 'FORBIDDEN'); };
const notFound = () => { throw new HttpError(404, 'NOT_FOUND'); };
const bad = (code, detail) => { throw new HttpError(400, code, detail); };
const human = u => { if (!u || u.via === 'token') deny(); return u; };
const OPEN_STAGES_EXCLUDED = new Set(['won', 'lost']);

export function createPortability(db, config, { clock, notify, draftWithAgent }) {
  const settings = () => ({ ...DEFAULT_SETTINGS, ...(config.portability ?? {}) });
  const names = () => new Map(db.all('SELECT id, name FROM users').map(u => [u.id, u.name]));

  // ---------- veto profiles (versioned, admins only) ----------
  const profRow = r => ({ ...r, parts: parse(r.parts, []), keywords: parse(r.keywords, []), active: !!r.active });

  function ensureDefaultProfiles() {
    if (db.get('SELECT 1 AS x FROM veto_profiles LIMIT 1')) return;
    const now = clock();
    db.tx(() => {
      for (const p of DEFAULT_PROFILES) {
        db.run('INSERT INTO veto_profiles (key, version, label, veto, approves, question, parts, keywords, note, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,1,?)',
          p.key, 1, p.label, p.veto, p.approves, p.question, JSON.stringify(p.parts), JSON.stringify(p.keywords), 'Default profile', now);
      }
      db.audit('veto_profiles.seeded', { data: { keys: DEFAULT_PROFILES.map(p => p.key) }, at: now });
    });
  }

  const activeProfiles = () => db.all('SELECT * FROM veto_profiles WHERE active = 1 ORDER BY id').map(profRow);

  function listProfiles(actor) {
    if (!actor) deny();
    return db.all('SELECT * FROM veto_profiles ORDER BY key, version DESC').map(profRow);
  }

  function createProfileVersion(actor, body) {
    if (!actor || actor.role !== 'admin' || actor.via === 'token') deny();
    const p = { key: str(body.key, 40).toLowerCase(), label: str(body.label, 80), veto: body.veto, approves: str(body.approves, 300), question: str(body.question, 300),
      parts: Array.isArray(body.parts) ? body.parts.slice(0, 8).map(x => ({ key: str(x?.key, 40).toLowerCase(), text: str(x?.text, 200) })) : body.parts,
      keywords: Array.isArray(body.keywords) ? body.keywords.slice(0, 30).map(k => str(k, 60).toLowerCase()) : body.keywords, note: str(body.note, 500) };
    const problems = validateProfile(p);
    if (problems.length) bad('INVALID_PROFILE', problems);
    const now = clock();
    return db.tx(() => {
      const v = (db.get('SELECT MAX(version) AS v FROM veto_profiles WHERE key = ?', p.key)?.v ?? 0) + 1;
      db.run('UPDATE veto_profiles SET active = 0 WHERE key = ?', p.key);
      db.run('INSERT INTO veto_profiles (key, version, label, veto, approves, question, parts, keywords, note, active, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)',
        p.key, v, p.label, p.veto, p.approves, p.question, JSON.stringify(p.parts), JSON.stringify(p.keywords), p.note, actor.id, now);
      db.audit('veto_profile.versioned', { actorId: actor.id, data: { key: p.key, version: v, note: p.note }, at: now });
      return { key: p.key, version: v };
    });
  }

  // ---------- claim library ----------
  function claimsWithStatus() {
    const approvals = new Map();
    for (const a of db.all('SELECT * FROM claim_approvals')) {
      if (!approvals.has(a.claim_id)) approvals.set(a.claim_id, []);
      approvals.get(a.claim_id).push(a);
    }
    return db.all('SELECT * FROM claims ORDER BY topic, id DESC').map(c => {
      const ap = approvals.get(c.id) ?? [];
      return { ...c, parts: parse(c.parts, []), approvals: ap, ...claimStatus(c, ap) };
    });
  }

  function listClaims(actor) {
    if (!actor) deny();
    const n = names();
    return claimsWithStatus().map(c => ({ ...c, created_by_name: n.get(c.created_by) ?? null, approvals: c.approvals.map(a => ({ ...a, name: n.get(a.user_id) ?? null })) }));
  }

  function cleanClaim(body) {
    const topic = str(body.topic, 40).toLowerCase();
    const profile = activeProfiles().find(p => p.key === topic);
    if (topic !== 'general' && !profile) bad('INVALID_TOPIC');
    const text = str(body.text, 600), source = str(body.source, 200);
    if (text.length < 10) bad('TEXT_REQUIRED');
    if (source.length < 3) bad('SOURCE_REQUIRED');
    const allowed = new Set(profile?.parts.map(p => p.key) ?? []);
    const parts = [...new Set((Array.isArray(body.parts) ? body.parts : []).map(x => str(x, 40)))];
    if (parts.some(x => !allowed.has(x))) bad('INVALID_PARTS');
    return { topic, text, source, parts };
  }

  function createClaim(actor, body) {
    human(actor);
    const c = cleanClaim(body);
    const now = clock();
    const id = Number(db.run('INSERT INTO claims (topic, text, source, parts, created_by, created_at) VALUES (?,?,?,?,?,?)', c.topic, c.text, c.source, JSON.stringify(c.parts), actor.id, now).lastInsertRowid);
    db.audit('claim.created', { actorId: actor.id, data: { claimId: id, ...c }, at: now });
    return { id };
  }

  /** A change is a new claim that supersedes the old one. Approvals do not carry over. */
  function reviseClaim(actor, id, body) {
    human(actor);
    const old = db.get('SELECT * FROM claims WHERE id = ?', id) ?? notFound();
    if (old.superseded_by || old.retired_at) bad('CLAIM_NOT_CURRENT');
    const c = cleanClaim({ topic: old.topic, ...body });
    const now = clock();
    return db.tx(() => {
      const nid = Number(db.run('INSERT INTO claims (topic, text, source, parts, supersedes, created_by, created_at) VALUES (?,?,?,?,?,?,?)', c.topic, c.text, c.source, JSON.stringify(c.parts), id, actor.id, now).lastInsertRowid);
      db.run('UPDATE claims SET superseded_by = ? WHERE id = ?', nid, id);
      db.audit('claim.revised', { actorId: actor.id, data: { from: id, to: nid, ...c }, at: now });
      return { id: nid };
    });
  }

  /** Product, legal and privacy each sign once, by three different people, none of them the author. */
  function approveClaim(actor, id, { capacity }) {
    human(actor);
    if (!(actor.role === 'admin' || actor.role === 'approver')) deny();
    if (!CAPACITIES.includes(capacity)) bad('INVALID_CAPACITY');
    const c = db.get('SELECT * FROM claims WHERE id = ?', id) ?? notFound();
    if (c.superseded_by || c.retired_at) bad('CLAIM_NOT_CURRENT');
    if (c.created_by === actor.id) throw new HttpError(403, 'AUTHOR_CANNOT_APPROVE');
    const existing = db.all('SELECT * FROM claim_approvals WHERE claim_id = ?', id);
    if (existing.some(a => a.capacity === capacity)) bad('ALREADY_APPROVED');
    if (existing.some(a => a.user_id === actor.id)) throw new HttpError(403, 'ONE_CAPACITY_PER_PERSON');
    const now = clock();
    db.run('INSERT INTO claim_approvals (claim_id, capacity, user_id, at) VALUES (?,?,?,?)', id, capacity, actor.id, now);
    db.audit('claim.approved', { actorId: actor.id, data: { claimId: id, capacity }, at: now });
    return claimsWithStatus().find(x => x.id === id);
  }

  function retireClaim(actor, id) {
    human(actor);
    const c = db.get('SELECT * FROM claims WHERE id = ?', id) ?? notFound();
    if (!(actor.role === 'admin' || c.created_by === actor.id)) deny();
    if (c.retired_at) return { ok: true };
    const now = clock();
    db.run('UPDATE claims SET retired_at = ? WHERE id = ?', now, id);
    db.audit('claim.retired', { actorId: actor.id, data: { claimId: id }, at: now });
    return { ok: true };
  }

  // ---------- deals ----------

  /** Latest stage, start, size and closed flag of one deal, from the evidence. */
  function dealInfo(campaignId, ref) {
    const deals = db.all("SELECT fields, at FROM events WHERE campaign_id = ? AND ref = ? AND kind = 'deal' ORDER BY at, id", campaignId, ref);
    if (!deals.length) return null;
    const stages = deals.map(d => ({ stage: parse(d.fields, {}).deal_stage ?? null, at: d.at }));
    const stage = [...stages].reverse().find(s => s.stage)?.stage ?? null;
    const rec = db.get("SELECT fields FROM events WHERE campaign_id = ? AND ref = ? AND kind = 'crm_record' ORDER BY at DESC, id DESC LIMIT 1", campaignId, ref);
    const proposal = stages.find(s => s.stage === 'proposal')?.at ?? null;
    return { ref, campaign_id: campaignId, stage, first_at: deals[0].at, proposal_at: proposal, company_size: parse(rec?.fields, {}).company_size ?? null, closed: OPEN_STAGES_EXCLUDED.has(stage) };
  }

  function dealEvidence(campaignId, ref) {
    const activities = db.all("SELECT id, at, fields FROM events WHERE campaign_id = ? AND ref = ? AND kind = 'activity' ORDER BY at, id", campaignId, ref)
      .map(a => { const f = parse(a.fields, {}); return { id: a.id, at: a.at, type: f.type, roles: String(f.roles ?? '').split(',').filter(Boolean) }; });
    const conversations = db.all("SELECT id, at, body FROM events WHERE campaign_id = ? AND ref = ? AND kind = 'conversation' ORDER BY at, id", campaignId, ref);
    return { activities, conversations };
  }

  /** Roles involved in each won deal before its proposal (or before it was won). */
  function wonDeals() {
    const out = [];
    for (const r of db.all("SELECT DISTINCT campaign_id, ref FROM events WHERE kind = 'deal' AND fields LIKE '%\"won\"%'")) {
      const d = dealInfo(r.campaign_id, r.ref);
      if (d?.stage !== 'won') continue;
      const cutoff = d.proposal_at ?? Infinity;
      const before = {};
      for (const a of dealEvidence(r.campaign_id, r.ref).activities) if (a.at < cutoff) for (const role of a.roles) (before[role] ??= []).push(a.id);
      out.push({ ref: r.ref, company_size: d.company_size, before });
    }
    return out;
  }

  /** Recompute signals and keep gaps in step: new signals open hints; unclassified hints without signals disappear. */
  function refreshDeal(campaignId, ref) {
    const deal = dealInfo(campaignId, ref);
    if (!deal) return null;
    const profiles = activeProfiles();
    const ev = dealEvidence(campaignId, ref);
    const now = clock();
    const result = computeSignals({ deal, ...ev, wonDeals: wonDeals(), profiles, now, settings: settings() });
    const changes = { opened: 0, removed: 0 };
    db.tx(() => {
      for (const p of profiles) {
        const r = result.get(p.key);
        const gap = db.get('SELECT * FROM gaps WHERE campaign_id = ? AND deal_ref = ? AND profile_key = ?', campaignId, ref, p.key);
        if (r.signals.length && !gap) {
          db.run('INSERT INTO gaps (campaign_id, deal_ref, profile_key, signals, created_at, updated_at) VALUES (?,?,?,?,?,?)', campaignId, ref, p.key, JSON.stringify(r.signals), now, now);
          changes.opened++;
        } else if (gap && !r.signals.length && !gap.classification) {
          db.run('DELETE FROM gaps WHERE id = ?', gap.id);
          changes.removed++;
        } else if (gap && JSON.stringify(r.signals) !== gap.signals) {
          db.run('UPDATE gaps SET signals = ?, updated_at = ? WHERE id = ?', JSON.stringify(r.signals), now, gap.id);
        }
      }
      if (changes.opened || changes.removed) db.audit('portability.signals', { campaignId, data: { deal: ref, ...changes }, at: now });
    });
    return { deal, ev, result, profiles };
  }

  /** Gap with its checked draft, coverage and state. */
  function gapView(gap, profile, claimMap, evidenceMap) {
    const lines = parse(gap.draft, []);
    const check = checkDraft(lines, claimMap, evidenceMap);
    const cov = coverage(profile, check.lines);
    const st = gapState(gap, check, cov);
    return { id: gap.id, profile_key: gap.profile_key, signals: parse(gap.signals, []), classification: gap.classification, classified_at: gap.classified_at,
      draft: check.lines, draft_version: gap.draft_version, draft_source: gap.draft_source, blocked: check.blocked, coverage: cov,
      approved_version: gap.approved_version, approved_at: gap.approved_at, approval_tests: parse(gap.approval_tests, {}),
      briefed_version: gap.briefed_version, briefed_at: gap.briefed_at, briefing: parse(gap.briefing, {}), ...st };
  }

  function evidenceMapFor(ev) {
    const m = new Map(ev.conversations.map(c => ['E' + c.id, c.body]));
    for (const a of ev.activities) m.set('E' + a.id, `${a.type}: ${a.roles.join(', ')}`);
    return m;
  }
  const claimMap = () => new Map(claimsWithStatus().map(c => [c.id, c]));

  function getDeal(actor, campaignId, ref) {
    if (!actor) deny();
    const r = refreshDeal(campaignId, ref) ?? notFound();
    const n = names();
    const claims = claimMap();
    const evidence = evidenceMapFor(r.ev);
    const gaps = new Map(db.all('SELECT * FROM gaps WHERE campaign_id = ? AND deal_ref = ?', campaignId, ref).map(g => [g.profile_key, g]));
    const roles = r.profiles.map(p => {
      const g = gaps.get(p.key);
      return { profile: p, group: r.result.get(p.key).group, gap: g ? { ...gapView(g, p, claims, evidence), classified_by_name: n.get(g.classified_by) ?? null, approved_by_name: n.get(g.approved_by) ?? null, briefed_by_name: n.get(g.briefed_by) ?? null } : null };
    });
    const campaign = db.get('SELECT id, name, owner_id FROM campaigns WHERE id = ?', campaignId);
    const usable = [...claims.values()].filter(c => c.status === 'approved').map(c => ({ id: c.id, topic: c.topic, text: c.text, source: c.source, parts: c.parts }));
    return {
      deal: { ...r.deal, day: Math.floor((clock() - r.deal.first_at) / DAY), campaign_name: campaign?.name },
      roles, summary: dealSummary(roles.filter(x => x.gap).map(x => x.gap.state)),
      conversations: r.ev.conversations.map(c => ({ id: 'E' + c.id, at: c.at, body: c.body })),
      activities: r.ev.activities.map(a => ({ id: 'E' + a.id, at: a.at, type: a.type, roles: a.roles })),
      claims: usable, drafter: draftWithAgent ? draftWithAgent.status() : 'disabled'
    };
  }

  function listDeals(actor) {
    if (!actor) deny();
    const refs = db.all("SELECT DISTINCT e.campaign_id, e.ref, c.name AS campaign_name FROM events e JOIN campaigns c ON c.id = e.campaign_id WHERE e.kind = 'deal' AND e.is_test = 0 ORDER BY e.campaign_id, e.ref");
    const claims = claimMap();
    const profiles = new Map(activeProfiles().map(p => [p.key, p]));
    const open = [];
    for (const r of refs) {
      const d = dealInfo(r.campaign_id, r.ref);
      if (!d || d.closed) continue;
      const refreshed = refreshDeal(r.campaign_id, r.ref);
      const evidence = evidenceMapFor(refreshed.ev);
      const states = db.all('SELECT * FROM gaps WHERE campaign_id = ? AND deal_ref = ?', r.campaign_id, r.ref)
        .filter(g => profiles.has(g.profile_key)).map(g => gapView(g, profiles.get(g.profile_key), claims, evidence).state);
      open.push({ ...d, campaign_name: r.campaign_name, day: Math.floor((clock() - d.first_at) / DAY), summary: dealSummary(states) });
    }
    // Level 2 hands over lost deals whose CRM reason contradicts the conversations: lessons for the claim library.
    const handoffs = [];
    for (const inv of db.all("SELECT i.id, i.campaign_id, i.report, c.name AS campaign_name FROM investigations i JOIN campaigns c ON c.id = i.campaign_id WHERE i.status = 'done' ORDER BY i.id DESC")) {
      for (const h of parse(inv.report, {}).handoffs ?? []) if (!handoffs.some(x => x.deal_ref === h.deal_ref && x.campaign_id === inv.campaign_id)) handoffs.push({ ...h, campaign_id: inv.campaign_id, campaign_name: inv.campaign_name, investigation: inv.id });
    }
    // Calibration: false alarms are counted, not hidden ("already handled" = hint not confirmed).
    const all = db.all('SELECT classification, briefed_version, draft_version FROM gaps');
    const stats = { hints: all.length, confirmed: all.filter(g => g.classification === 'notyet' || g.classification === 'shadow').length,
      dismissed: all.filter(g => g.classification === 'handled').length, briefed: all.filter(g => g.briefed_version != null && g.briefed_version === g.draft_version).length };
    return { deals: open, handoffs, stats };
  }

  // ---------- the four steps ----------
  const getGap = id => db.get('SELECT * FROM gaps WHERE id = ?', id) ?? notFound();
  const profileOf = key => activeProfiles().find(p => p.key === key) ?? notFound();

  function classifyGap(actor, id, { classification }) {
    human(actor);
    if (![null, 'notyet', 'shadow', 'handled'].includes(classification ?? null)) bad('INVALID_CLASSIFICATION');
    const g = getGap(id);
    const now = clock();
    db.run('UPDATE gaps SET classification = ?, classified_by = ?, classified_at = ?, updated_at = ? WHERE id = ?', classification ?? null, classification ? actor.id : null, classification ? now : null, now, id);
    db.audit('gap.classified', { actorId: actor.id, campaignId: g.campaign_id, data: { gapId: id, deal: g.deal_ref, role: g.profile_key, classification: classification ?? null }, at: now });
    return { ok: true };
  }

  function normaliseLines(lines) {
    if (!Array.isArray(lines)) bad('INVALID_DRAFT');
    return lines.slice(0, 20).map(l => {
      if (l?.kind === 'claim') return { kind: 'claim', claim_id: Number(l.claim_id) };
      if (l?.kind === 'evidence') return { kind: 'evidence', evidence_id: str(l.evidence_id, 20), quote: str(l.quote, 400) };
      if (l?.kind === 'recommendation') return { kind: 'recommendation', text: str(l.text, 400) };
      return { kind: 'free', text: str(l?.text, 400) };
    });
  }

  /** Any change to the draft makes a new version: approval and briefing of the old version no longer count. */
  function saveDraft(actor, id, { lines }, source = 'human') {
    if (source === 'human') human(actor);
    const g = getGap(id);
    if (!g.classification || g.classification === 'handled') bad('CLASSIFY_FIRST');
    const clean = normaliseLines(lines);
    const now = clock();
    db.run('UPDATE gaps SET draft = ?, draft_version = draft_version + 1, draft_source = ?, updated_at = ? WHERE id = ?', JSON.stringify(clean), source, now, id);
    db.audit('gap.draft_saved', { actorId: actor?.id ?? null, campaignId: g.campaign_id, data: { gapId: id, deal: g.deal_ref, role: g.profile_key, lines: clean.length, source, version: g.draft_version + 1 }, at: now });
    return { ok: true, version: g.draft_version + 1 };
  }

  function currentView(g) {
    const ev = dealEvidence(g.campaign_id, g.deal_ref);
    return gapView(g, profileOf(g.profile_key), claimMap(), evidenceMapFor(ev));
  }

  function approveDraft(actor, id, { tests } = {}) {
    human(actor);
    const g = getGap(id);
    const v = currentView(g);
    if (!g.classification || g.classification === 'handled') bad('CLASSIFY_FIRST');
    if (v.draft.length === 0 || !v.draft.some(l => l.kind === 'claim' || l.kind === 'evidence')) bad('DRAFT_EMPTY');
    if (v.blocked) throw new HttpError(409, 'DRAFT_BLOCKED', v.draft.filter(l => !l.ok).map(l => l.reason));
    if (!ARGUMENT_TESTS.every(t => tests?.[t] === true)) bad('TESTS_REQUIRED', ARGUMENT_TESTS);
    const now = clock();
    db.run('UPDATE gaps SET approved_version = draft_version, approved_by = ?, approved_at = ?, approval_tests = ?, updated_at = ? WHERE id = ?', actor.id, now, JSON.stringify(tests), now, id);
    db.audit('gap.draft_approved', { actorId: actor.id, campaignId: g.campaign_id, data: { gapId: id, deal: g.deal_ref, role: g.profile_key, version: g.draft_version, coverage: v.coverage.level, open: v.coverage.open }, at: now });
    return { ok: true, coverage: v.coverage.level };
  }

  /** Step 4: the champion is briefed (or, for a silent review, gets a document to pass on). Logged, never sent by ANTERA. */
  async function logBriefing(actor, id, { date, participants, note } = {}) {
    human(actor);
    const g = getGap(id);
    const v = currentView(g);
    if (!(v.state === 'in_progress' && v.step === 4)) throw new HttpError(409, 'APPROVE_FIRST');
    const when = date ? Date.parse(date) : clock();
    if (!Number.isFinite(when)) bad('INVALID_DATE');
    const briefing = { mode: g.classification === 'shadow' ? 'handover' : 'briefing', date: new Date(when).toISOString().slice(0, 10), participants: str(participants, 300), note: str(note, 1000), open: v.coverage.open };
    const now = clock();
    db.run('UPDATE gaps SET briefed_version = draft_version, briefed_by = ?, briefed_at = ?, briefing = ?, updated_at = ? WHERE id = ?', actor.id, now, JSON.stringify(briefing), now, id);
    db.audit('gap.briefed', { actorId: actor.id, campaignId: g.campaign_id, data: { gapId: id, deal: g.deal_ref, role: g.profile_key, version: g.draft_version, ...briefing }, at: now });
    await notify({ event: 'gap.briefed', deal: g.deal_ref, campaign: g.campaign_id, role: g.profile_key, ...briefing, at: new Date(now).toISOString() });
    return { ok: true };
  }

  /** The AI drafts; code checks. Saved as a normal draft version, so a person still has to approve it. */
  async function draftGap(actor, id) {
    human(actor);
    if (!draftWithAgent || draftWithAgent.status() !== 'ready') throw new HttpError(409, 'INVESTIGATOR_UNAVAILABLE', draftWithAgent?.status() ?? 'disabled');
    const g = getGap(id);
    if (!g.classification || g.classification === 'handled') bad('CLASSIFY_FIRST');
    const profile = profileOf(g.profile_key);
    const ev = dealEvidence(g.campaign_id, g.deal_ref);
    const claims = [...claimMap().values()].filter(c => c.status === 'approved' && (c.topic === g.profile_key || c.topic === 'general'));
    const out = await draftWithAgent.run({ gap: { ...g, signals: parse(g.signals, []) }, profile, claims, conversations: ev.conversations });
    db.audit('gap.ai_draft', { actorId: actor.id, campaignId: g.campaign_id, data: { gapId: id, status: out.status, error: out.error ?? null, lines: out.lines?.length ?? 0, usd: out.usage?.usd ?? null }, at: clock() });
    if (out.status !== 'done') throw new HttpError(502, 'DRAFT_FAILED', out.error ?? out.status);
    saveDraft(actor, id, { lines: out.lines }, 'ai');
    return { ok: true, note: out.note ?? '', usage: out.usage };
  }

  return {
    ensureDefaultProfiles, activeProfiles, listProfiles, createProfileVersion,
    listClaims, createClaim, reviseClaim, approveClaim, retireClaim,
    listDeals, getDeal, refreshDeal, classifyGap, saveDraft, approveDraft, logBriefing, draftGap
  };
}
