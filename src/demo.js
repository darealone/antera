// Demo mode: sample team, definitions, campaigns and synthetic evidence, plus buttons to simulate traffic.
// All people, companies and numbers are fictitious. Evidence goes through the normal ingest path,
// so the demo also shows pseudonymisation (emails are hashed, names are dropped).
import { HttpError } from './service.js';

export const DEMO_PASSWORD = 'demo-password-123';
const H = 3600_000, MIN = 60_000;

/** A field value that satisfies one criterion. */
function sample(c, i = 0) {
  switch (c.op) {
    case 'eq': return c.value;
    case 'in': return c.value[0];
    case 'gt': case 'gte': return c.value + 10 + (i % 7);
    case 'lt': case 'lte': return c.value - 1;
    case 'neq': return typeof c.value === 'string' ? c.value + '_other' : !c.value;
    default: return c.field === 'company_size' ? ['10-49', '50-249', '250-999'][i % 3] : 'demo';
  }
}

function recordFields(goal, i, { drop = null } = {}) {
  const f = { country: ['DE', 'AT', 'CH'][i % 3], lead_score: 60 + (i % 30) };
  for (const c of goal?.criteria ?? []) f[c.field] = sample(c, i);
  if (drop) delete f[drop];
  // Realistic qualification: about one lead in three becomes an SQL. Monitoring checks that the field
  // arrives, not its value, so this does not affect Level 1.
  if ('lifecycle_stage' in f && i % 3 !== 0) f.lifecycle_stage = 'mql';
  return f;
}

/** The first goal field that comes from the form (not computed by the CRM): the one a broken mapping loses. */
function droppable(goal, settings) {
  const computed = new Set(settings.crmComputedFields);
  return (goal?.criteria ?? []).map(c => c.field).find(f => !computed.has(f) && f !== 'consent') ?? null;
}

let seq = 0;
const uid = p => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function traffic(c, goal, { n, now, spanH = 20, drop = null, spend = 0 }) {
  const events = [];
  for (let i = 0; i < n; i++) {
    const at = now - Math.round(((i + 1) / (n + 1)) * spanH * H) - 40 * MIN;
    const email = `${uid('lead')}@example.test`;
    events.push({ kind: 'form_submit', campaign: c.id, email, at, source: 'demo-form', fields: { first_name: 'Demo', company_size: '50-249', consent: true } });
    events.push({ kind: 'crm_record', campaign: c.id, email, at: at + 2 * MIN, source: 'demo-crm', fields: recordFields(goal, i, { drop }) });
  }
  if (spend) events.push({ kind: 'spend', campaign: c.id, amount: spend, at: now - 30 * MIN, source: 'demo-ads' });
  return events;
}

function testLead(c, goal, { now, drop = null }) {
  const ref = uid('test');
  return [
    { kind: 'form_submit', campaign: c.id, ref, test: true, at: now, source: 'demo-form' },
    { kind: 'crm_record', campaign: c.id, ref, test: true, at: now + 20_000, source: 'demo-crm', fields: recordFields(goal, 1, { drop }) }
  ];
}

export function mountDemo(svc, db, { clock = () => Date.now(), config }) {
  return async (method, path, user, body) => {
    if (method !== 'POST') throw new HttpError(405, 'METHOD');
    const action = path.slice('/api/demo/'.length);
    const id = Number(body.campaignId);
    const c = svc.getCampaign(user, id).campaign;
    const goal = svc.activeDefinitions().get(c.goal_key);
    const drop = droppable(goal, config.rules);
    const now = clock();
    // Demo time travel: simulated traffic is spread over the last hours, so a campaign started a minute ago
    // is treated as if it had been live for 7 hours. Never happens outside demo mode.
    if (c.state === 'live' && c.live_since > now - 7 * H) db.run('UPDATE campaigns SET live_since = ? WHERE id = ?', now - 7 * H, id);
    let events;
    if (action === 'test-lead') events = testLead(c, goal, { now });
    else if (action === 'test-lead-broken') events = testLead(c, goal, { now, drop });
    else if (action === 'traffic') events = traffic(c, goal, { n: 12, now, spanH: 6, spend: c.daily_budget / 4 || 50 });
    else if (action === 'traffic-broken') events = traffic(c, goal, { n: 16, now, spanH: 6, drop, spend: c.daily_budget / 4 || 50 });
    else if (action === 'spend-only') events = [{ kind: 'spend', campaign: c.id, amount: c.daily_budget / 4 || 50, at: now - 20 * MIN, source: 'demo-ads' }];
    else throw new HttpError(404, 'NOT_FOUND');
    const res = await svc.ingest(user, { events });
    const detail = await svc.runChecks(user, id);
    return { ingested: res, detail };
  };
}

/** Seed the demo installation. Runs once, on an empty database. */
export async function seedDemo(svc, db, { clock = () => Date.now() } = {}) {
  const admin = svc.createUser(null, { email: 'alex@example.test', name: 'Alex Admin', password: DEMO_PASSWORD });
  const sam = svc.createUser(admin, { email: 'sam@example.test', name: 'Sam Approver', role: 'approver', password: DEMO_PASSWORD });
  const kim = svc.createUser(admin, { email: 'kim@example.test', name: 'Kim Marketing', role: 'member', password: DEMO_PASSWORD });
  const as = u => ({ ...u, via: 'session' });

  // Foundation. SQL has two versions to show versioning: v2 added the company-size requirement.
  await svc.createDefinitionVersion(as(admin), { key: 'mql', label: 'Marketing Qualified Lead', note: 'Agreed with Sales, Q3 review.', criteria: [{ field: 'consent', op: 'eq', value: true }, { field: 'lead_score', op: 'gte', value: 50 }] });
  await svc.createDefinitionVersion(as(admin), { key: 'sql', label: 'Sales Qualified Lead', note: 'First version.', criteria: [{ field: 'consent', op: 'eq', value: true }, { field: 'lifecycle_stage', op: 'in', value: ['sql', 'opportunity'] }] });
  await svc.createDefinitionVersion(as(admin), { key: 'sql', label: 'Sales Qualified Lead', note: 'Sales only accepts leads with a known company size (ICP check).', criteria: [{ field: 'consent', op: 'eq', value: true }, { field: 'company_size', op: 'exists' }, { field: 'lifecycle_stage', op: 'in', value: ['sql', 'opportunity'] }] });
  await svc.createDefinitionVersion(as(admin), { key: 'opportunity', label: 'Opportunity', note: 'A deal exists in the CRM pipeline.', criteria: [{ field: 'deal_stage', op: 'exists' }] });

  const base = { form_fields: ['email', 'first_name', 'company', 'company_size', 'consent'], consent_field: 'consent', goal_key: 'sql' };
  const fullMap = { email: 'email', company: 'company', company_size: 'company_size', consent: 'consent' };
  const goal = svc.activeDefinitions().get('sql');
  const now = clock();

  // 1 · Kaputt / broken: the form asks for company size, but the CRM mapping drops it. Starts BLOCKED.
  const webinar = await svc.createCampaign(as(kim), { ...base, name: 'Webinar: AI in Sales', channel: 'LinkedIn Ads', daily_budget: 400,
    attribution_key: 'webinar-ai-sales', landing_url: 'https://example.test/webinar?utm_source=linkedin&utm_campaign=webinar-ai-sales',
    crm_mapping: { email: 'email', company: 'company', consent: 'consent' } });
  await svc.ingest(as(kim), { events: testLead(webinar.campaign, goal, { now, drop: 'company_size' }) });
  await svc.runChecks(as(kim), webinar.campaign.id);

  // 2 · Healthy and live. Use the demo buttons to make the CRM drop a field and watch ANTERA pause it.
  const paper = await svc.createCampaign(as(kim), { ...base, name: 'Whitepaper: Pipeline Hygiene', channel: 'Google Ads', daily_budget: 600,
    attribution_key: 'whitepaper-pipeline', landing_url: 'https://example.test/whitepaper?utm_source=google&utm_campaign=whitepaper-pipeline', crm_mapping: fullMap });
  await svc.ingest(as(kim), { events: testLead(paper.campaign, goal, { now }) });
  await svc.startCampaign(as(sam), paper.campaign.id, { reason: 'Chain checked, test lead complete. Approved for Q4 budget.' });
  // Demo only: pretend it has been live for a day, so the seeded traffic counts as live traffic.
  db.run('UPDATE campaigns SET live_since = ? WHERE id = ?', now - 26 * H, paper.campaign.id);
  await svc.ingest(as(kim), { events: traffic(paper.campaign, goal, { n: 18, now, spend: 450 }) });
  await svc.runChecks(as(kim), paper.campaign.id);

  // 3 · Blind: money goes out, nothing comes in. A hint, not proof: ANTERA opens an investigation, no pause.
  const brand = await svc.createCampaign(as(kim), { ...base, name: 'Brand Search DACH', channel: 'Google Ads', daily_budget: 250,
    attribution_key: 'brand-dach', landing_url: 'https://example.test/?utm_source=google&utm_campaign=brand-dach', crm_mapping: fullMap });
  await svc.ingest(as(kim), { events: testLead(brand.campaign, goal, { now }) });
  await svc.startCampaign(as(sam), brand.campaign.id, { reason: 'Evergreen brand campaign, chain verified.' });
  db.run('UPDATE campaigns SET live_since = ? WHERE id = ?', now - 26 * H, brand.campaign.id);
  await svc.ingest(as(kim), { events: [{ kind: 'spend', campaign: brand.campaign.id, amount: 180, at: now - 2 * H, source: 'demo-ads' }] });
  await svc.runChecks(as(kim), brand.campaign.id);

  // Level 2 history: earlier runs with deals and consented call notes (older than the monitoring window).
  await svc.ingest(as(kim), { events: dealHistory(paper.campaign.id, now, PAPER_DEALS) });
  await svc.ingest(as(kim), { events: dealHistory(brand.campaign.id, now, BRAND_DEALS) });
  await replayInvestigation(svc, db, paper.campaign.id, { clock });

  return { admin, sam, kim };
}

// ---------- Level 2 demo data ----------
const DAY = 24 * H;
const OK_FIELDS = { consent: true, company_size: '250-999', lifecycle_stage: 'sql', lead_score: 74 };

// [ref, final stage, CRM loss reason, amount, call note or null]. Fictitious companies and people.
const PAPER_DEALS = [
  ['D-1001', 'won', null, 38000, null],
  ['D-1002', 'lost', 'no budget', 24000, 'Champion (Head of Sales Ops) likes the pilot. Next step: the Betriebsrat has to approve because the tool tracks activity per rep. She will raise it at the works council meeting in March.'],
  ['D-1003', 'lost', 'no budget', 31000, 'IT security review requested a data processing agreement and a DPIA. Our champion asked whether we have a works council FAQ. Procurement paused until the review is done.'],
  ['D-1004', 'lost', 'no budget', 19000, 'Budget for 2027 was frozen company-wide last week; CFO confirmed no new tools until Q3. Champion wants to restart then.'],
  ['D-1005', 'lost', 'no budget', 27000, 'Datenschutzbeauftragter und Betriebsrat sehen Leistungskontrolle kritisch. Champion fragt nach Argumenten für die Mitbestimmungsrunde.'],
  ['D-1006', 'lost', 'timing', 22000, null],
  ['D-1007', 'proposal', null, 29000, null],
  ['D-1008', null, null, 0, null], ['D-1009', null, null, 0, null], ['D-1010', null, null, 0, null]
];
const BRAND_DEALS = [
  ['B-2001', 'won', null, 21000, null], ['B-2002', 'won', null, 17000, null], ['B-2003', 'lost', 'competitor', 15000, null],
  ['B-2004', null, null, 0, null], ['B-2005', null, null, 0, null], ['B-2006', null, null, 0, null], ['B-2007', null, null, 0, null]
];

function dealHistory(campaignId, now, rows) {
  const ev = [];
  rows.forEach(([ref, stage, reason, amount, note], i) => {
    const t0 = now - (40 - i) * DAY;
    ev.push({ kind: 'form_submit', campaign: campaignId, ref, at: t0, source: 'demo-history' });
    ev.push({ kind: 'crm_record', campaign: campaignId, ref, at: t0 + 3 * MIN, source: 'demo-history', fields: stage ? OK_FIELDS : { ...OK_FIELDS, lifecycle_stage: 'mql' } });
    if (!stage) return;
    ev.push({ kind: 'deal', campaign: campaignId, ref, amount, at: t0 + 6 * DAY, source: 'demo-crm', fields: { deal_stage: 'proposal' } });
    if (note) ev.push({ kind: 'conversation', campaign: campaignId, ref, consent: true, at: t0 + 12 * DAY, source: 'demo-calls', text: note });
    if (stage !== 'proposal') ev.push({ kind: 'deal', campaign: campaignId, ref, at: t0 + 18 * DAY, source: 'demo-crm', fields: { deal_stage: stage, ...(reason ? { loss_reason: reason } : {}) } });
  });
  ev.push({ kind: 'spend', campaign: campaignId, amount: rows.length * 310, at: now - 30 * DAY, source: 'demo-history' });
  return ev;
}

/**
 * A scripted investigation: it calls the real read-only tools and goes through the real evidence check,
 * but the "model" is this script, not Claude. It shows the format without an API key, and it includes one
 * invented claim on purpose so the demo shows the check removing it. Stored with model "demo-replay".
 */
async function replayInvestigation(svc, db, campaignId, { clock }) {
  const { investigate } = await import('./investigator.js');
  const campaign = { ...db.get('SELECT * FROM campaigns WHERE id = ?', campaignId) };
  const result = (params, id) => {
    for (const m of params.messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.tool_use_id === id) return JSON.parse(b.content);
  };
  const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
  const turn = content => ({ content, stop_reason: 'tool_use', usage: {}, model: 'demo-replay' });
  const steps = [
    () => turn([use('a', 'check_launch_chain'), use('b', 'get_campaign_funnel'), use('c', 'get_reference_pattern')]),
    () => turn([use('d', 'get_loss_reasons')]),
    () => turn([use('e', 'search_transcripts', { query: 'betriebsrat works council datenschutz security budget', deal_ref: '' })]),
    p => {
      const funnel = result(p, 'b'), lost = result(p, 'd'), hits = result(p, 'e').matches;
      const ref = [...result(p, 'c').campaigns].sort((x, y) => y.opportunities - x.opportunities)[0]; // the comparable one with most deals
      const approval = hits.filter(h => /betriebsrat|works council|datenschutz|security/i.test(h.snippet));
      const noBudget = lost.deals.filter(d => d.crm_loss_reason === 'no budget');
      const pct = x => (x == null ? '—' : Math.round(x * 100) + ' %');
      return turn([use('f', 'submit_findings', {
        summary: `Leads reached the CRM complete, but deals were lost late: ${funnel.lost} of ${funnel.opportunities} opportunities lost, ${noBudget.length} of them recorded as "no budget". For ${approval.length} of those, the call notes point to the works council or an IT/data-protection review instead. Up to the SQL stage this run performs like the reference campaign.`,
        findings: [
          { title: '"No budget" hides an internal approval problem',
            observed: [
              { statement: `${noBudget.length} of ${lost.lost_deals} lost deals carry the CRM loss reason "no budget".`, evidence: noBudget.map(d => d.id) },
              { statement: `Call notes for ${approval.length} of these deals mention the works council (Betriebsrat), IT security or the data protection officer.`, evidence: approval.map(h => h.id) }],
            inferred: 'For most of these deals the blocker was internal approval (co-determination, IT and data protection), not money. The CRM records the visible symptom, not the cause.',
            confidence: 'medium',
            counter_evidence: 'One "no budget" call (D-1004) describes a real company-wide budget freeze. The pattern rests on three conversations, and deals without notes cannot be judged.',
            to_verify: 'Ask the champions of D-1002, D-1003 and D-1005 what stopped the deal. Check whether the CRM offers "internal approval" as a loss reason.' },
          { title: 'The top of the funnel is not the leak',
            observed: [{ statement: `Submission-to-SQL rate ${pct(funnel.rates.submission_to_goal)} here vs ${pct(ref.rates.submission_to_goal)} in "${ref.name}"; opportunity-to-won ${pct(funnel.rates.opportunity_to_won)} vs ${pct(ref.rates.opportunity_to_won)}.`, evidence: ['FUNNEL', ref.id] }],
            inferred: 'More traffic or budget would not fix this run. The loss happens after the proposal.',
            confidence: 'medium',
            counter_evidence: 'The reference campaign is a different channel with few deals; the comparison is indicative, not proof.',
            to_verify: 'Compare again after the next run.' },
          { title: 'Competitor pricing (invented on purpose for the demo)',
            observed: [{ statement: 'A competitor undercut our price in every lost deal.', evidence: ['E0'] }],
            inferred: 'This claim cites evidence that was never returned, so the check removes it.', confidence: 'high', counter_evidence: '—', to_verify: '—' }
        ],
        handoffs: approval.filter(h => noBudget.some(d => d.deal_ref === h.deal_ref)).map(h => ({
          deal_ref: h.deal_ref, crm_reason: 'no budget', conversation_signal: h.snippet.replace(/…/g, '').slice(0, 220), evidence: [h.id] })),
        next_run: [{
          hypothesis: 'Deals stall at internal approval (works council, data protection), not at budget.',
          change: 'Send a works council and data protection pack with every proposal, and add "internal approval" as a CRM loss reason.',
          measure: 'Share of proposals that reach negotiation; share of losses recorded as "no budget".' }]
      })]);
    }
  ];
  const client = { beta: { messages: { create: async params => steps.shift()(params) } } };
  const now = clock();
  const out = await investigate({ client, db, campaign, definitions: svc.activeDefinitions(), settings: {}, model: 'demo-replay', maxTurns: 6 });
  const report = { ...out.report, unsupported: out.unsupported, servedBy: 'demo-replay' };
  const invId = Number(db.run("INSERT INTO investigations (campaign_id, status, trigger, requested_by, model, started_at, finished_at, report, tool_calls, usage) VALUES (?, ?, 'demo', NULL, 'demo-replay', ?, ?, ?, ?, ?)",
    campaignId, out.status, now - 2 * MIN, now, JSON.stringify(report), JSON.stringify(out.toolCalls), JSON.stringify({ requests: out.usage.requests, usd: 0 })).lastInsertRowid);
  db.audit('investigation.finished', { campaignId, data: { investigationId: invId, status: out.status, trigger: 'demo', findings: report.findings?.length ?? 0, unsupported: report.unsupported?.length ?? 0, handoffs: report.handoffs?.length ?? 0 }, at: now });
  if (report.handoffs?.length) db.run("INSERT INTO tasks (campaign_id, owner_id, code, cause, created_at) VALUES (?, ?, 'TASK_HANDOFF_L3', ?, ?)", campaignId, campaign.owner_id, JSON.stringify({ investigation: invId, deals: report.handoffs.length }), now);
}
