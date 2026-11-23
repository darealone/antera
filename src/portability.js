// Level 3 · Decision portability. Pure functions: no database, no clock reads, no network.
//
// A deal is decided in rooms the seller never enters. Level 3 looks for roles that can stop it (veto profiles),
// shows which of them are visibly involved, and helps prepare answers the champion can carry into the room.
// Rules enforced here:
// - Every signal starts as a HINT. "Not visible" only means the connected data shows no involvement.
// - A draft may contain only approved claims (copied word for word), exact quotes from evidence, and
//   recommendations for the account owner. Anything else is UNBACKED and blocks approval.
// - Approved does not mean answered: coverage shows every part of the role's question that is still open.
// - ANTERA judges decisions, not people. Activities name roles, never persons.

export const PORTABILITY_VERSION = 'portability-2026.1';
const DAY = 86_400_000;

export const DEFAULT_SETTINGS = Object.freeze({ lateRiskDays: 90, silenceDays: 14, minWonDeals: 2, roleShare: 0.5, lateTopics: ['works_council', 'it_security', 'privacy'] });

/** Starting profiles. Admins version them like definitions; ANTERA itself never changes them. */
export const DEFAULT_PROFILES = [
  { key: 'works_council', label: 'Works council', veto: 'high', approves: 'Co-determination on any system that could monitor employees',
    question: 'Can the system evaluate who works on what, and for how long?',
    parts: [{ key: 'monitoring', text: 'Can it be used to monitor individual performance?' }, { key: 'access', text: 'Who can see individual-level data?' }, { key: 'agreement', text: 'Is there a works agreement we can start from?' }],
    keywords: ['betriebsrat', 'works council', 'mitbestimmung', 'co-determination', 'betriebsvereinbarung', 'works agreement', 'leistungskontrolle'] },
  { key: 'it_security', label: 'IT security', veto: 'high', approves: 'Release of systems and access',
    question: 'SSO, hosting, certifications, and who is liable after an incident?',
    parts: [{ key: 'sso', text: 'Single sign-on and access control' }, { key: 'hosting', text: 'Hosting and certifications' }, { key: 'incident', text: 'Liability and response after a security incident' }],
    keywords: ['it-sicherheit', 'it security', 'security review', 'sicherheitsfragebogen', 'security questionnaire', 'ciso', 'penetration test', 'iso 27001'] },
  { key: 'privacy', label: 'Data protection', veto: 'medium', approves: 'Release of personal data processing',
    question: 'Where is the data stored, and is there a data processing agreement?',
    parts: [{ key: 'location', text: 'Where the data is stored' }, { key: 'dpa', text: 'Data processing agreement (DPA / AVV)' }, { key: 'deletion', text: 'Deletion and retention' }],
    keywords: ['datenschutz', 'data protection', 'datenschutzbeauftragte', 'dsb', 'dpo', 'avv', 'dpa', 'dsgvo', 'gdpr', 'dpia', 'dsfa'] },
  { key: 'finance', label: 'Finance', veto: 'medium', approves: 'Budget and business case',
    question: 'Why now, and what does it cost to do nothing?',
    parts: [{ key: 'why_now', text: 'Why now?' }, { key: 'cost_of_inaction', text: 'What does it cost to do nothing?' }, { key: 'payback', text: 'When does it pay back?' }],
    keywords: ['cfo', 'finanzen', 'finance', 'controlling', 'business case', 'payback', 'roi'] },
  { key: 'procurement', label: 'Procurement', veto: 'low', approves: 'Supplier approval and contract terms',
    question: 'Contract term, exit, and supplier onboarding?',
    parts: [{ key: 'terms', text: 'Contract term and cancellation' }, { key: 'exit', text: 'Exit and data export' }],
    keywords: ['einkauf', 'procurement', 'purchasing', 'lieferantenfreigabe', 'vendor onboarding'] },
  { key: 'management', label: 'Management / steering committee', veto: 'high', approves: 'Priority and final go-ahead',
    question: 'Why this, why now, and what is the risk if it goes wrong?',
    parts: [{ key: 'priority', text: 'Strategic priority' }, { key: 'risk', text: 'Risk if it goes wrong' }],
    keywords: ['geschäftsführung', 'vorstand', 'management board', 'steering committee', 'lenkungskreis', 'ceo'] }
];

const KEY_RE = /^[a-z][a-z0-9_]{1,30}$/;

export function validateProfile(p) {
  const problems = [];
  if (!KEY_RE.test(p?.key ?? '')) problems.push('key must be snake_case');
  if (!String(p?.label ?? '').trim()) problems.push('label is required');
  if (!['high', 'medium', 'low'].includes(p?.veto)) problems.push('veto must be high, medium or low');
  if (!String(p?.question ?? '').trim()) problems.push('question is required');
  if (!Array.isArray(p?.parts) || !p.parts.length || p.parts.some(x => !KEY_RE.test(x?.key ?? '') || !String(x?.text ?? '').trim())) problems.push('parts must be a non-empty list of {key, text}');
  if (!Array.isArray(p?.keywords) || p.keywords.some(k => typeof k !== 'string' || k.trim().length < 2)) problems.push('keywords must be a list of words');
  return problems;
}

// ---------- signals ----------

const norm = s => String(s ?? '').toLowerCase();
/** Word-boundary match, so "dpa" does not match inside another word. */
function findTerm(body, keywords) {
  const low = norm(body);
  let best = null;
  for (const k of keywords) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u');
    const m = re.exec(low);
    if (m && (best === null || m.index < best.index)) best = { term: k, index: m.index + m[1].length };
  }
  return best;
}
/** Every position of every keyword (word-boundary match). */
function findAll(body, keywords) {
  const low = norm(body), out = [];
  for (const k of keywords) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
    for (const m of low.matchAll(re)) out.push({ term: k, index: m.index + m[1].length });
  }
  return out;
}
export function quoteAround(body, index, len = 0, radius = 160) {
  const a = Math.max(0, index - radius), b = Math.min(body.length, index + len + radius);
  return (a > 0 ? '…' : '') + body.slice(a, b).trim() + (b < body.length ? '…' : '');
}
const UNSURE = /(muss|müsste) ich (noch )?klären|kläre ich (noch|erst)|weiß ich (noch )?nicht|need to (check|clarify|find out)|have to (check|clarify)|i('| wi)ll (have to )?find out|not sure yet/gi;

/**
 * S06 attribution: each "I need to check that" belongs to ONE role: the closest one mentioned before it
 * (within 250 characters), or else the closest after it. One unsure answer is not counted against every role nearby.
 */
function unsureAnswers(conversations, profiles) {
  const out = new Map(); // profileKey -> first { c, term, index, phrase }
  for (const c of [...conversations].sort((x, y) => x.at - y.at)) {
    const hits = profiles.flatMap(p => findAll(c.body, p.keywords).map(h => ({ ...h, key: p.key })));
    for (const u of c.body.matchAll(UNSURE)) {
      // An unsure answer usually replies to a topic raised BEFORE it; look back first, then forward.
      const within = hits.map(h => ({ ...h, dist: Math.abs(h.index - u.index) })).filter(h => h.dist <= 250);
      const before = within.filter(h => h.index <= u.index).sort((x, y) => x.dist - y.dist);
      const near = before[0] ?? within.sort((x, y) => x.dist - y.dist)[0];
      if (near && !out.has(near.key)) out.set(near.key, { c, term: near.term, index: near.index, phrase: u[0], at: u.index });
    }
  }
  return out;
}

/**
 * @param {object} deal      { ref, first_at, company_size, closed }
 * @param {object[]} activities     [{ id, at, type, roles: [] }]   of this deal
 * @param {object[]} conversations  [{ id, at, body }]              of this deal
 * @param {object[]} wonDeals       [{ ref, company_size, before: { role: [eventIds] } }]  roles involved before the proposal
 * @param {object[]} profiles       active veto profiles
 * @returns {Map<profileKey, { group, signals: [{code, params, evidence, quote?}] }>}
 */
export function computeSignals({ deal, activities = [], conversations = [], wonDeals = [], profiles, now, settings = {} }) {
  if (typeof now !== 'number') throw new TypeError('computeSignals() needs an explicit `now`');
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const out = new Map();
  const involved = role => activities.filter(a => a.roles.includes(role));
  const lastAt = Math.max(deal.first_at ?? 0, ...activities.map(a => a.at), ...conversations.map(c => c.at));
  const peers = wonDeals.filter(w => w.company_size && w.company_size === deal.company_size && w.ref !== deal.ref);
  const unsure = unsureAnswers(conversations, profiles);

  for (const p of profiles) {
    const signals = [];
    const acts = involved(p.key);
    const mentions = conversations.map(c => ({ c, hit: findTerm(c.body, p.keywords) })).filter(x => x.hit).sort((x, y) => x.c.at - y.c.at);

    // S01 · rule: comparable won deals had this role involved before the proposal; this one shows none.
    if (peers.length >= s.minWonDeals && !acts.length) {
      const withRole = peers.filter(w => w.before?.[p.key]?.length);
      if (withRole.length / peers.length >= s.roleShare) {
        signals.push({ code: 'S01_MISSING_ROLE', params: { won: peers.length, withRole: withRole.length, size: deal.company_size }, evidence: withRole.flatMap(w => w.before[p.key]).slice(0, 6).map(id => 'E' + id) });
      }
    }
    // S02 · keyword + quote: mentioned in a conversation, but no activity shows the role taking part.
    if (mentions.length && !acts.length) {
      const { c, hit } = mentions[0];
      signals.push({ code: 'S02_MENTIONED_NOT_INVOLVED', params: { term: hit.term }, evidence: ['E' + c.id], quote: quoteAround(c.body, hit.index, hit.term.length) });
    }
    // S03 · rule: activity stops after the topic was taken "upstairs" (steering committee, board).
    if (p.key === 'management') {
      const markers = [...activities.filter(a => a.type === 'escalation').map(a => ({ id: a.id, at: a.at })),
        ...mentions.map(m => ({ id: m.c.id, at: m.c.at, quote: quoteAround(m.c.body, m.hit.index, m.hit.term.length) }))].sort((x, y) => y.at - x.at);
      const m = markers[0];
      if (m && !deal.closed && lastAt <= m.at + DAY && now - m.at >= s.silenceDays * DAY) {
        signals.push({ code: 'S03_SILENCE_AFTER_ESCALATION', params: { days: Math.floor((now - m.at) / DAY) }, evidence: ['E' + m.id], ...(m.quote ? { quote: m.quote } : {}) });
      }
    }
    // S05 · keyword + quote: a risk topic first appears late in the deal (month seven instead of month two).
    if (s.lateTopics.includes(p.key) && deal.first_at) {
      const first = [...acts.map(a => ({ id: a.id, at: a.at })), ...mentions.map(m => ({ id: m.c.id, at: m.c.at, quote: quoteAround(m.c.body, m.hit.index, m.hit.term.length) }))].sort((x, y) => x.at - y.at)[0];
      const day = first ? Math.floor((first.at - deal.first_at) / DAY) : null;
      if (first && day > s.lateRiskDays) signals.push({ code: 'S05_LATE_RISK_TOPIC', params: { day, max: s.lateRiskDays }, evidence: ['E' + first.id], ...(first.quote ? { quote: first.quote } : {}) });
    }
    // S06 · keyword + quote: the champion could not answer a question that matters to this role.
    const u = unsure.get(p.key);
    if (u) {
      const from = Math.min(u.at, u.index), to = Math.max(u.at + u.phrase.length, u.index + u.term.length);
      signals.push({ code: 'S06_CHAMPION_NO_ANSWER', params: { term: u.term, phrase: u.phrase }, evidence: ['E' + u.c.id], quote: quoteAround(u.c.body, from, to - from, 120) });
    }
    const group = acts.length ? 'in' : mentions.length ? 'mention' : 'never';
    out.set(p.key, { group, signals });
  }
  return out;
}

// ---------- claims, drafts, coverage ----------

export const CAPACITIES = Object.freeze(['product', 'legal', 'privacy']);

/** A claim may appear in drafts only when product, legal and privacy all approved it, and it is current. */
export function claimStatus(claim, approvals = []) {
  if (claim.retired_at) return { status: 'retired', missing: [] };
  if (claim.superseded_by) return { status: 'superseded', missing: [] };
  const have = new Set(approvals.map(a => a.capacity));
  const missing = CAPACITIES.filter(c => !have.has(c));
  return { status: missing.length ? 'pending' : 'approved', missing };
}

const squash = s => norm(s).replace(/[„“"”‚‘’']/g, '"').replace(/\s+/g, ' ').trim();

/**
 * Checks every draft line. Claim text is taken from the library, never from the draft, so it cannot be
 * paraphrased. Quotes must appear in the cited evidence. Anything else is UNBACKED and blocks approval.
 * @param {object[]} lines        [{ kind: 'claim', claim_id } | { kind: 'evidence', evidence_id, quote } | { kind: 'recommendation', text } | { kind: 'free', text }]
 * @param {Map} claims            id -> { ...claim, status }
 * @param {Map} evidence          'E42' -> body text (conversations) or a short description (activities)
 */
export function checkDraft(lines, claims, evidence) {
  const checked = (lines ?? []).slice(0, 20).map(l => {
    if (l?.kind === 'claim') {
      const c = claims.get(Number(l.claim_id));
      if (!c) return { kind: 'claim', claim_id: Number(l.claim_id) || null, ok: false, reason: 'CLAIM_UNKNOWN' };
      if (c.status !== 'approved') return { kind: 'claim', claim_id: c.id, text: c.text, source: c.source, ok: false, reason: 'CLAIM_' + c.status.toUpperCase() };
      return { kind: 'claim', claim_id: c.id, text: c.text, source: c.source, parts: c.parts, ok: true };
    }
    if (l?.kind === 'evidence') {
      const id = String(l.evidence_id ?? '');
      const quote = String(l.quote ?? '').trim().slice(0, 400);
      const body = evidence.get(id);
      if (body === undefined) return { kind: 'evidence', evidence_id: id, text: quote, ok: false, reason: 'EVIDENCE_UNKNOWN' };
      if (quote.length < 12 || !squash(body).includes(squash(quote))) return { kind: 'evidence', evidence_id: id, text: quote, ok: false, reason: 'QUOTE_NOT_FOUND' };
      return { kind: 'evidence', evidence_id: id, text: quote, ok: true };
    }
    if (l?.kind === 'recommendation') return { kind: 'recommendation', text: String(l.text ?? '').trim().slice(0, 400), ok: true };
    return { kind: 'free', text: String(l?.text ?? '').trim().slice(0, 400), ok: false, reason: 'UNBACKED' };
  });
  return { lines: checked, blocked: checked.some(l => !l.ok), empty: !checked.some(l => l.kind === 'claim' || l.kind === 'evidence') };
}

/** Which parts of the role's question the approved claims in the draft answer. */
export function coverage(profile, checkedLines) {
  const covered = new Set(checkedLines.filter(l => l.kind === 'claim' && l.ok).flatMap(l => l.parts ?? []));
  const parts = profile.parts.map(p => ({ ...p, covered: covered.has(p.key) }));
  const n = parts.filter(p => p.covered).length;
  return { parts, level: n === 0 ? 'none' : n === parts.length ? 'full' : 'partial', open: parts.filter(p => !p.covered).map(p => p.key) };
}

export const ARGUMENT_TESTS = Object.freeze(['corridor', 'protection', 'room']);

/**
 * The four steps: 1 classify the hint, 2 cover the question, 3 approve the draft, 4 brief the champion.
 * Approval is bound to a draft version; any change to the draft needs a new approval and a new briefing.
 */
export function gapState(gap, check, cov) {
  if (!gap.classification) return { state: 'hint', step: 1 };
  if (gap.classification === 'handled') return { state: 'dismissed', step: null };
  if (check.empty) return { state: 'risk', step: 2 };
  const approved = gap.approved_version === gap.draft_version && !check.blocked;
  if (!approved) return { state: 'in_progress', step: 3, staleApproval: gap.approved_version != null && gap.approved_version !== gap.draft_version };
  if (gap.briefed_version !== gap.draft_version) return { state: 'in_progress', step: 4 };
  return cov.level === 'full' ? { state: 'prepared', step: null } : { state: 'briefed_partial', step: null };
}

export function dealSummary(states) {
  const count = st => states.filter(x => x === st).length;
  const hints = count('hint');
  const risks = count('risk') + count('in_progress') + count('briefed_partial');
  const overall = hints ? 'UNREVIEWED' : risks ? 'AT_RISK' : states.length ? (count('prepared') ? 'PREPARED' : 'CLEAR') : 'NO_SIGNALS';
  return { hints, risks, prepared: count('prepared'), dismissed: count('dismissed'), overall };
}
