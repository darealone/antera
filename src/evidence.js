// Level 2 · Understand: the investigator's read-only tools.
// Every function only SELECTs. Each returned item carries an evidence id ("E42" = events row 42,
// "CHAIN", "FUNNEL", "REF:3"), and every id handed out is recorded so findings can be checked against it.
import { matches, requiredFields } from './definitions.js';

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const iso = ms => (ms ? new Date(ms).toISOString() : null);
const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const rate = (a, b) => (b > 0 ? round(a / b, 3) : null);

/**
 * @param {object} db         the database wrapper from db.js
 * @param {object} campaign   the campaign under investigation (parsed row)
 * @param {object} ctx        { definitions: Map, opportunityKey }
 */
export function createEvidenceTools(db, campaign, { definitions, opportunityKey = 'opportunity' }) {
  const handedOut = new Map(); // id -> kind
  const cite = (id, kind) => { handedOut.set(id, kind); return id; };
  const cid = campaign.id;

  /** Latest stage per deal ref, plus its loss reason and amount. */
  function deals(campaignId = cid) {
    const out = new Map();
    for (const e of db.all("SELECT id, ref, fields, amount, at FROM events WHERE campaign_id = ? AND kind = 'deal' ORDER BY at, id", campaignId)) {
      const f = parse(e.fields, {});
      const prev = out.get(e.ref);
      out.set(e.ref, { id: e.id, ref: e.ref, stage: f.deal_stage ?? prev?.stage ?? null, loss_reason: f.loss_reason ?? prev?.loss_reason ?? null,
        amount: e.amount || prev?.amount || 0, first_at: prev?.first_at ?? e.at, last_at: e.at });
    }
    return out;
  }

  function funnel(campaignId) {
    const c = campaignId === cid ? campaign : { ...db.get('SELECT * FROM campaigns WHERE id = ?', campaignId) };
    const subs = db.get("SELECT COUNT(DISTINCT ref) AS n FROM events WHERE campaign_id = ? AND kind = 'form_submit' AND is_test = 0", campaignId).n;
    const records = new Map();
    for (const r of db.all("SELECT ref, fields FROM events WHERE campaign_id = ? AND kind = 'crm_record' AND is_test = 0 ORDER BY at, id", campaignId)) records.set(r.ref, parse(r.fields, {}));
    const goal = definitions.get(c.goal_key);
    const mql = definitions.get('mql');
    const count = d => (d ? [...records.values()].filter(f => matches(d.criteria, f).ok).length : null);
    const ds = [...deals(campaignId).values()];
    const won = ds.filter(d => d.stage === 'won').length;
    const lost = ds.filter(d => d.stage === 'lost').length;
    const spend = db.get("SELECT COALESCE(SUM(amount),0) AS s FROM events WHERE campaign_id = ? AND kind = 'spend'", campaignId).s;
    const sql = count(goal);
    return {
      submissions: subs, crm_records: records.size, mql: count(mql), [c.goal_key || 'goal']: sql, opportunities: ds.length,
      open: ds.length - won - lost, won, lost, spend: round(spend),
      rates: { submission_to_goal: rate(sql ?? 0, subs), goal_to_opportunity: rate(ds.length, sql ?? 0), opportunity_to_won: rate(won, won + lost) },
      cost_per_goal: sql ? round(spend / sql) : null, cost_per_won: won ? round(spend / won) : null
    };
  }

  const tools = {
    /** Level 1 results as the investigator's starting point. */
    check_launch_chain() {
      const last = kind => {
        const run = db.get('SELECT run_id, ran_at FROM check_runs WHERE campaign_id = ? AND kind = ? ORDER BY id DESC LIMIT 1', cid, kind);
        if (!run) return null;
        return { ran_at: iso(run.ran_at), results: db.all('SELECT check_id, stage, status, code, params FROM check_runs WHERE run_id = ? ORDER BY check_runs.id', run.run_id).map(r => ({ ...r, params: parse(r.params, {}) })) };
      };
      const pauses = db.all("SELECT action, by_kind, rule, cause, at FROM interventions WHERE campaign_id = ? ORDER BY id DESC LIMIT 10", cid)
        .map(i => ({ action: i.action, by: i.by_kind, rule: i.rule, cause: parse(i.cause, {}), at: iso(i.at) }));
      return { id: cite('CHAIN', 'chain'), state: campaign.state, launch_status: campaign.launch_status, health: campaign.health, launch: last('launch'), monitor: last('monitor'), interventions: pauses };
    },

    /** Counts from submission to won deal, with conversion rates and cost per step. */
    get_campaign_funnel() {
      const goal = definitions.get(campaign.goal_key);
      return { id: cite('FUNNEL', 'funnel'), campaign: campaign.name, goal: goal ? { key: goal.key, version: goal.version, needs: requiredFields(goal.criteria) } : null, ...funnel(cid) };
    },

    /** Lost deals with the reason recorded in the CRM, and whether any conversation exists for them. */
    get_loss_reasons() {
      const lost = [...deals().values()].filter(d => d.stage === 'lost');
      const convo = new Set(db.all("SELECT DISTINCT ref FROM events WHERE campaign_id = ? AND kind = 'conversation'", cid).map(r => r.ref));
      const tally = {};
      for (const d of lost) tally[d.loss_reason ?? 'none recorded'] = (tally[d.loss_reason ?? 'none recorded'] ?? 0) + 1;
      return {
        lost_deals: lost.length, by_reason: tally,
        deals: lost.map(d => ({ id: cite('E' + d.id, 'deal'), deal_ref: d.ref, crm_loss_reason: d.loss_reason, amount: d.amount, lost_at: iso(d.last_at), has_conversation: convo.has(d.ref) }))
      };
    },

    /** Everything known about one deal, in time order. */
    get_deal_timeline({ deal_ref }) {
      const ref = String(deal_ref ?? '').slice(0, 80);
      const rows = db.all('SELECT id, kind, fields, amount, at, body FROM events WHERE campaign_id = ? AND ref = ? AND is_test = 0 ORDER BY at, id', cid, ref);
      if (!rows.length) return { deal_ref: ref, events: [], note: 'No events for this deal in this campaign.' };
      return {
        deal_ref: ref,
        events: rows.map(r => ({
          id: cite('E' + r.id, r.kind), kind: r.kind, at: iso(r.at),
          ...(r.kind === 'conversation' ? { excerpt: r.body.slice(0, 600), length: r.body.length } : { fields: parse(r.fields, {}) }),
          ...(r.amount ? { amount: r.amount } : {})
        }))
      };
    },

    /** Keyword search over consented, scrubbed conversation notes. Any term may match. */
    search_transcripts({ query, deal_ref }) {
      const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(t => t.length > 1).slice(0, 8);
      if (!terms.length) return { matches: [], note: 'Give at least one search term.' };
      const ref = String(deal_ref ?? '').trim();
      const rows = ref
        ? db.all("SELECT id, ref, at, body FROM events WHERE campaign_id = ? AND kind = 'conversation' AND ref = ? ORDER BY at", cid, ref)
        : db.all("SELECT id, ref, at, body FROM events WHERE campaign_id = ? AND kind = 'conversation' ORDER BY at", cid);
      const hits = [];
      for (const r of rows) {
        const low = r.body.toLowerCase();
        const pos = terms.map(t => low.indexOf(t)).filter(p => p >= 0);
        if (!pos.length) continue;
        const at = Math.min(...pos);
        hits.push({ id: cite('E' + r.id, 'conversation'), deal_ref: r.ref, at: iso(r.at), matched: terms.filter(t => low.includes(t)),
          snippet: (at > 250 ? '…' : '') + r.body.slice(Math.max(0, at - 250), at + 350) + (at + 350 < r.body.length ? '…' : '') });
        if (hits.length >= 8) break;
      }
      return { searched_conversations: rows.length, matches: hits };
    },

    /** The same funnel for other campaigns with the same goal: a baseline to compare against. */
    get_reference_pattern() {
      const others = db.all("SELECT id, name, channel FROM campaigns WHERE id != ? AND goal_key = ? ORDER BY id", cid, campaign.goal_key);
      return {
        goal: campaign.goal_key,
        campaigns: others.map(o => ({ id: cite('REF:' + o.id, 'reference'), name: o.name, channel: o.channel, ...funnel(o.id) })),
        note: others.length ? null : 'No other campaign with the same goal yet.'
      };
    }
  };

  return { tools, handedOut };
}

/** Tool definitions for the Messages API. Strict schemas, all read-only. */
export const TOOL_DEFS = [
  { name: 'check_launch_chain', description: 'Level 1 results for this campaign: the six-step launch chain, live monitoring and every pause/start with its cause. Start here.', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  { name: 'get_campaign_funnel', description: 'Counts from form submission to won deal for this campaign (submissions, CRM records, MQL, goal, opportunities, won, lost), conversion rates and cost per step.', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  { name: 'get_loss_reasons', description: 'Lost deals of this campaign with the loss reason recorded in the CRM, and whether conversation notes exist for each deal.', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  { name: 'get_deal_timeline', description: 'All events for one deal in time order: form submission, CRM record, deal stage changes and conversation excerpts.', input_schema: { type: 'object', properties: { deal_ref: { type: 'string', description: 'The deal_ref from get_loss_reasons.' } }, required: ['deal_ref'], additionalProperties: false } },
  { name: 'search_transcripts', description: 'Keyword search in consented conversation notes of this campaign. Returns snippets. Any term may match; try synonyms and German terms (e.g. "Betriebsrat works council").', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Space-separated search terms.' }, deal_ref: { type: 'string', description: 'Limit to one deal, or empty string for all deals.' } }, required: ['query', 'deal_ref'], additionalProperties: false } },
  { name: 'get_reference_pattern', description: 'The same funnel for other campaigns with the same goal, as a baseline. Use it before calling anything unusual.', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } }
].map(t => ({ ...t, strict: true }));
