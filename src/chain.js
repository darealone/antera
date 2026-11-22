// Level 1 · Prevent. The launch chain from click to deal, as deterministic checks.
// Same input + same RULES_VERSION = same result. No network, no clock reads, no randomness:
// the caller passes `now`, so every result can be replayed from stored evidence.
//
// Every finding is a code plus parameters. The UI turns a code into three sentences:
// what was OBSERVED, what is INFERRED from it, and what a human should VERIFY.
// Absence of data is never a failure: it is "unknown" (a hint), and only observed breaks are "fail".

import { createHash } from 'node:crypto';
import { requiredFields, isPresent } from './definitions.js';

export const RULES_VERSION = 'antera-2026.1';
export const LAUNCH = Object.freeze({ GO: 'GO', BLOCKED: 'BLOCKED' });

export const SETTINGS = Object.freeze({
  maxTestAgeHours: 48,
  syncGraceMinutes: 30,
  monitorWindowHours: 24,
  minSample: 5,
  completenessThreshold: 0.9,
  maxUnsyncedShare: 0.2,
  crmComputedFields: ['lead_score', 'lifecycle_stage'],
  opportunityKey: 'opportunity'
});

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Stable JSON: object keys sorted, so hashes do not depend on key order. */
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

const r = (id, stage, status, code, params = {}) => ({ id, stage, status, code, params });

function utmCampaign(url) {
  try { return new URL(url).searchParams.get('utm_campaign') || null; } catch { return undefined; }
}

/** The CRM fields a campaign delivers: values of its mapping whose form field actually exists on the form. */
export function mappedCrmFields(campaign) {
  const form = new Set(campaign.form_fields ?? []);
  return [...new Set(Object.entries(campaign.crm_mapping ?? {}).filter(([f]) => form.has(f)).map(([, crm]) => crm))].sort();
}

// ---------- the static part of the chain: configuration and definitions ----------

function checkTracking(c) {
  if (!c.landing_url) return r('tracking', 'click', 'fail', 'TRACKING_NO_URL');
  const utm = utmCampaign(c.landing_url);
  if (utm === undefined) return r('tracking', 'click', 'fail', 'TRACKING_BAD_URL', { url: c.landing_url });
  if (!utm) return r('tracking', 'click', 'fail', 'TRACKING_NO_UTM', { url: c.landing_url });
  if (c.attribution_key && c.attribution_key !== utm) return r('tracking', 'click', 'fail', 'TRACKING_MISMATCH', { utm, key: c.attribution_key });
  return r('tracking', 'click', 'pass', 'TRACKING_OK', { utm });
}

function checkConsent(c) {
  const field = c.consent_field;
  if (!field || !(c.form_fields ?? []).includes(field)) return r('consent', 'form', 'fail', 'CONSENT_MISSING', { field: field || null });
  if (!c.crm_mapping?.[field]) return r('consent', 'form', 'fail', 'CONSENT_NOT_MAPPED', { field });
  return r('consent', 'form', 'pass', 'CONSENT_OK', { field, crm: c.crm_mapping[field] });
}

function checkGoal(c, defs) {
  const d = defs.get(c.goal_key);
  if (!d) return r('goal', 'definition', 'fail', 'GOAL_UNDEFINED', { key: c.goal_key || null });
  return r('goal', 'definition', 'pass', 'GOAL_OK', { key: d.key, version: d.version });
}

function checkMapping(c, defs, s) {
  const d = defs.get(c.goal_key);
  if (!d) return r('mapping', 'crm', 'unknown', 'MAPPING_NO_GOAL', { key: c.goal_key || null });
  const computed = new Set(s.crmComputedFields);
  const need = requiredFields(d.criteria).filter(f => !computed.has(f));
  const have = new Set(mappedCrmFields(c));
  const missing = need.filter(f => !have.has(f));
  if (missing.length) return r('mapping', 'crm', 'fail', 'MAPPING_MISSING', { fields: missing, key: d.key, version: d.version });
  return r('mapping', 'crm', 'pass', 'MAPPING_OK', { fields: need, key: d.key });
}

function checkDeal(c, defs, s) {
  if (!defs.get(s.opportunityKey)) return r('deal', 'deal', 'fail', 'DEAL_NO_DEFINITION', { key: s.opportunityKey });
  if (!c.attribution_key) return r('deal', 'deal', 'fail', 'DEAL_NO_ATTRIBUTION');
  return r('deal', 'deal', 'pass', 'DEAL_OK', { key: c.attribution_key });
}

/**
 * The test lead round trip: a test submission must arrive in the CRM with every field the goal reads.
 * @param {object|null} test   { submission: {ref, at}|null, record: {at, fields}|null, notBefore?: epoch ms }
 */
function checkRoundtrip(c, defs, test, now, s) {
  const d = defs.get(c.goal_key);
  const sub = test?.submission;
  if (!sub) return r('roundtrip', 'test', 'unknown', 'ROUNDTRIP_NO_TEST');
  const ageH = (now - sub.at) / HOUR;
  if (ageH > s.maxTestAgeHours) return r('roundtrip', 'test', 'unknown', 'ROUNDTRIP_STALE', { ref: sub.ref, hours: Math.floor(ageH), max: s.maxTestAgeHours });
  // After a pause, only a test lead sent after the pause proves the fix.
  if (test.notBefore && sub.at < test.notBefore) return r('roundtrip', 'test', 'unknown', 'ROUNDTRIP_BEFORE_PAUSE', { ref: sub.ref });
  const rec = test.record;
  if (!rec) {
    const mins = Math.floor((now - sub.at) / MIN);
    if (mins < s.syncGraceMinutes) return r('roundtrip', 'test', 'unknown', 'ROUNDTRIP_PENDING', { ref: sub.ref, minutes: mins });
    return r('roundtrip', 'test', 'fail', 'ROUNDTRIP_NOT_SYNCED', { ref: sub.ref, minutes: mins });
  }
  if (!d) return r('roundtrip', 'test', 'unknown', 'ROUNDTRIP_NO_GOAL', { ref: sub.ref });
  const missing = requiredFields(d.criteria).filter(f => !isPresent(rec.fields?.[f]));
  if (missing.length) return r('roundtrip', 'test', 'fail', 'ROUNDTRIP_FIELDS_MISSING', { ref: sub.ref, fields: missing });
  return r('roundtrip', 'test', 'pass', 'ROUNDTRIP_OK', { ref: sub.ref, seconds: Math.max(0, Math.round((rec.at - sub.at) / 1000)) });
}

const toMap = defs => (defs instanceof Map ? defs : new Map((defs ?? []).map(d => [d.key, d])));

/** The configuration checks, which also run daily while a campaign is live. */
export function staticChecks({ campaign, definitions, settings = {} }) {
  const s = { ...SETTINGS, ...settings };
  const defs = toMap(definitions);
  return [checkTracking(campaign), checkConsent(campaign), checkMapping(campaign, defs, s), checkGoal(campaign, defs), checkDeal(campaign, defs, s)];
}

/**
 * The full launch check, in chain order: click → form → CRM → test lead → definition → deal.
 * GO only when every step has a fresh pass. Anything else is BLOCKED.
 */
export function launchCheck({ campaign, definitions, test = null, now, settings = {} }) {
  if (typeof now !== 'number') throw new TypeError('launchCheck() needs an explicit `now` (epoch ms)');
  const s = { ...SETTINGS, ...settings };
  const defs = toMap(definitions);
  const [tracking, consent, mapping, goal, deal] = staticChecks({ campaign, definitions: defs, settings: s });
  const results = [tracking, consent, mapping, checkRoundtrip(campaign, defs, test, now, s), goal, deal];
  const status = results.every(x => x.status === 'pass') ? LAUNCH.GO : LAUNCH.BLOCKED;
  return { status, results, fingerprint: fingerprint(campaign, defs, s), rulesVersion: RULES_VERSION, evaluatedAt: now };
}

/**
 * Identifies exactly what was checked: the campaign's chain configuration and the versions of the
 * definitions it depends on. A new definition version or an edited mapping changes it.
 */
export function fingerprint(campaign, definitions, settings = {}) {
  const s = { ...SETTINGS, ...settings };
  const defs = toMap(definitions);
  const ver = k => defs.get(k)?.version ?? null;
  const scope = {
    landing_url: campaign.landing_url ?? '', attribution_key: campaign.attribution_key ?? '', goal_key: campaign.goal_key ?? '',
    form_fields: [...(campaign.form_fields ?? [])].sort(), crm_mapping: campaign.crm_mapping ?? {}, consent_field: campaign.consent_field ?? '',
    defs: { [campaign.goal_key ?? '']: ver(campaign.goal_key), [s.opportunityKey]: ver(s.opportunityKey) }, rules: RULES_VERSION
  };
  return createHash('sha256').update(canonical(scope)).digest('hex').slice(0, 16);
}

// ---------- the live part: monitoring a running campaign ----------

/**
 * Daily health of a live campaign, from real (non-test) traffic in the monitoring window.
 * @param {object} input.window  { submissions: [{ref, at}], records: Map|object ref -> {at, fields}, spend: number }
 */
export function monitor({ campaign, definitions, window, now, settings = {} }) {
  if (typeof now !== 'number') throw new TypeError('monitor() needs an explicit `now` (epoch ms)');
  const s = { ...SETTINGS, ...settings };
  const defs = toMap(definitions);
  const d = defs.get(campaign.goal_key);
  const subs = window?.submissions ?? [];
  const records = window?.records instanceof Map ? window.records : new Map(Object.entries(window?.records ?? {}));
  const spend = Number(window?.spend ?? 0);
  const out = [];

  // Leads reach the CRM at all?
  const due = subs.filter(x => now - x.at >= s.syncGraceMinutes * MIN);
  if (due.length < s.minSample) out.push(r('sync', 'crm', 'unknown', 'MON_SAMPLE_SMALL', { n: due.length, min: s.minSample }));
  else {
    const unsynced = due.filter(x => !records.has(x.ref)).length;
    const share = unsynced / due.length;
    out.push(share > s.maxUnsyncedShare
      ? r('sync', 'crm', 'fail', 'MON_NOT_SYNCED', { n: due.length, lost: unsynced, pct: Math.round(share * 100), max: Math.round(s.maxUnsyncedShare * 100) })
      : r('sync', 'crm', 'pass', 'MON_SYNCED', { n: due.length, lost: unsynced }));
  }

  // Do the leads that arrive carry what the goal definition needs?
  const arrived = subs.filter(x => records.has(x.ref));
  if (!d) out.push(r('complete', 'definition', 'unknown', 'MON_NO_GOAL', { key: campaign.goal_key || null }));
  else if (arrived.length < s.minSample) out.push(r('complete', 'definition', 'unknown', 'MON_SAMPLE_SMALL', { n: arrived.length, min: s.minSample }));
  else {
    const need = requiredFields(d.criteria);
    const counts = {};
    let complete = 0;
    for (const x of arrived) {
      const miss = need.filter(f => !isPresent(records.get(x.ref)?.fields?.[f]));
      if (!miss.length) complete++;
      for (const f of miss) counts[f] = (counts[f] ?? 0) + 1;
    }
    const share = complete / arrived.length;
    const fields = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f]) => f);
    out.push(share < s.completenessThreshold
      ? r('complete', 'definition', 'fail', 'MON_FIELDS_DROPPED', { n: arrived.length, pct: Math.round(share * 100), min: Math.round(s.completenessThreshold * 100), fields })
      : r('complete', 'definition', 'pass', 'MON_COMPLETE', { n: arrived.length, pct: Math.round(share * 100) }));
  }

  // Money going out but nothing coming in is suspicious, but it is a hint, not proof of a break.
  if (spend > 0 && subs.length === 0) out.push(r('activity', 'click', 'unknown', 'MON_SPEND_NO_LEADS', { spend: Math.round(spend * 100) / 100, hours: s.monitorWindowHours }));
  else out.push(r('activity', 'click', 'pass', 'MON_ACTIVITY', { n: subs.length, spend: Math.round(spend * 100) / 100 }));

  return out;
}
