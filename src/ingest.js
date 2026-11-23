// Intake & protection: validate incoming evidence and pseudonymise it before anything is stored.
// Emails become a salted hash, direct identifiers are dropped, free text is length-limited.
// Pure functions: the caller passes the salt, the campaign lookup and the clock.
import { createHash } from 'node:crypto';

export const KINDS = Object.freeze(['form_submit', 'crm_record', 'spend', 'deal', 'conversation', 'activity']);
export const ACTIVITY_TYPES = Object.freeze(['meeting', 'call', 'email', 'document', 'escalation']);
const ROLE_RE = /^[a-z][a-z0-9_]{1,30}$/;
export const MAX_TEXT = 20_000;

/**
 * Removes what can be detected reliably: email addresses, phone numbers, IBANs and card-like numbers.
 * Names in free text are NOT reliably detectable; connectors should send pseudonymised transcripts.
 */
export function scrubText(text) {
  return String(text)
    .replace(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi, '[email]')
    .replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g, '[iban]')
    // A full stop only belongs to the number when a digit follows (1.2.3.4), not at the end of a sentence.
    .replace(/(?<![\w.])\+?\d[\d ()\/.-]{6,}\d(?!\w|\.\d)/g, m =>
      (DATE_RE.test(m.trim()) || m.replace(/\D/g, '').length < 7 ? m : '[number]'));
}
// Dates are evidence, not identifiers: 2026-11-22, 22.11.2026, 22/11/2026.
const DATE_RE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4})$/;
export const MAX_EVENTS = 1000;

/** Direct identifiers that are never stored, whatever a connector sends. */
export const PII_FIELDS = Object.freeze(new Set([
  'email', 'e_mail', 'mail', 'phone', 'mobile', 'telephone', 'name', 'first_name', 'last_name', 'firstname', 'lastname',
  'full_name', 'address', 'street', 'ip', 'ip_address', 'birthday', 'date_of_birth'
]));
const FIELD_RE = /^[a-z][a-z0-9_]{0,40}$/;

export function pseudonym(salt, value) {
  return 'p_' + createHash('sha256').update(salt + '|' + String(value).trim().toLowerCase()).digest('hex').slice(0, 20);
}

function cleanFields(raw, dropped) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k0, v] of Object.entries(raw).slice(0, 60)) {
    const k = String(k0).toLowerCase();
    if (PII_FIELDS.has(k)) { dropped.add(k); continue; }
    if (!FIELD_RE.test(k)) { dropped.add(k.slice(0, 40)); continue; }
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean' || v === null) out[k] = v;
    else dropped.add(k);
  }
  return out;
}

function toTime(v, now) {
  if (v === undefined || v === null || v === '') return now;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * @param {object[]} events  raw events from a connector (n8n, CRM webhook, CSV import…)
 * @param {object} ctx       { salt, now, resolveCampaign(event) -> id|null }
 * @returns {{ accepted: object[], rejected: {index, error}[], dropped: string[] }}
 */
export function prepareEvents(events, { salt, now, resolveCampaign }) {
  if (!Array.isArray(events)) return { accepted: [], rejected: [{ index: -1, error: 'EVENTS_MUST_BE_A_LIST' }], dropped: [] };
  if (events.length > MAX_EVENTS) return { accepted: [], rejected: [{ index: -1, error: 'TOO_MANY_EVENTS' }], dropped: [] };
  const accepted = [], rejected = [], dropped = new Set();
  events.forEach((e0, index) => {
    let e = e0;
    if (!e || typeof e !== 'object') return rejected.push({ index, error: 'NOT_AN_OBJECT' });
    if (!KINDS.includes(e.kind)) return rejected.push({ index, error: 'UNKNOWN_KIND' });
    const campaignId = resolveCampaign(e);
    if (!campaignId) return rejected.push({ index, error: 'UNKNOWN_CAMPAIGN' });
    const at = toTime(e.at, now);
    if (Number.isNaN(at)) return rejected.push({ index, error: 'INVALID_TIME' });
    if (at > now + 5 * 60_000) return rejected.push({ index, error: 'TIME_IN_FUTURE' });

    // The ref links submission, CRM record and deal. Prefer the connector's own id; hash emails.
    let ref = null;
    const email = e.email ?? e.fields?.email;
    if (typeof e.ref === 'string' && e.ref.trim()) ref = e.ref.includes('@') ? pseudonym(salt, e.ref) : e.ref.trim().slice(0, 80);
    else if (typeof email === 'string' && email.includes('@')) ref = pseudonym(salt, email);
    if (email !== undefined) dropped.add('email');
    if (e.kind !== 'spend' && !ref) return rejected.push({ index, error: 'REF_REQUIRED' });

    const amount = e.kind === 'spend' || e.kind === 'deal' ? Number(e.amount ?? 0) : 0;
    if (!Number.isFinite(amount) || amount < 0) return rejected.push({ index, error: 'INVALID_AMOUNT' });
    // Conversations (call notes, transcripts) only with recorded consent, scrubbed, and with an expiry date.
    let body = null;
    if (e.kind === 'conversation') {
      if (e.consent !== true) return rejected.push({ index, error: 'CONSENT_REQUIRED' });
      if (typeof e.text !== 'string' || !e.text.trim()) return rejected.push({ index, error: 'TEXT_REQUIRED' });
      if (e.text.length > MAX_TEXT) return rejected.push({ index, error: 'TEXT_TOO_LONG' });
      body = scrubText(e.text.trim());
    }
    // Activities (meetings, emails, documents) name the ROLES involved, never people: "finance,it_security".
    if (e.kind === 'activity') {
      const type = e.fields?.type;
      const roles = String(e.fields?.roles ?? '').split(',').map(r => r.trim().toLowerCase()).filter(Boolean);
      if (!ACTIVITY_TYPES.includes(type)) return rejected.push({ index, error: 'INVALID_ACTIVITY_TYPE' });
      if (!roles.length || roles.some(r => !ROLE_RE.test(r))) return rejected.push({ index, error: 'INVALID_ROLES' });
      e = { ...e, fields: { type, roles: [...new Set(roles)].join(',') } };
    }
    accepted.push({ campaign_id: campaignId, kind: e.kind, ref, is_test: e.test ? 1 : 0, fields: cleanFields(e.fields, dropped), amount, at, source: String(e.source ?? '').slice(0, 40), body });
  });
  return { accepted, rejected, dropped: [...dropped].sort() };
}
