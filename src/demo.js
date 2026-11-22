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

  return { admin, sam, kim };
}
