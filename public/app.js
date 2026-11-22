// ANTERA web UI. Plain DOM, no framework, no build step.
// All user-provided text is inserted with textContent (never innerHTML).
import { t, setLang, getLang, fmtDate, has } from './i18n.js';

const $ = sel => document.querySelector(sel);
const main = $('#main');
const S = { config: null, me: null };
const STAGES = ['click', 'form', 'crm', 'test', 'definition', 'deal'];

// ---------- helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || 'ERROR'); e.code = data.error; e.detail = data.detail; e.status = r.status; throw e; }
  return data;
}

let toastTimer;
function toast(msg, err = false) {
  const el = $('#toast'); el.textContent = msg; el.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = 'toast'; }, 4200);
}
function fail(e) {
  if (e.status === 401 && e.code === 'LOGIN_REQUIRED') { S.me = null; return render(); }
  if (!e.code) console.error(e); // a bug in the UI, not an API answer
  const key = 'e_' + e.code; const msg = has(key) ? t(key) : t('error') + (e.code ? ` (${e.code})` : '');
  const detail = Array.isArray(e.detail) ? ' ' + e.detail.map(d => (has('o_' + d) ? d : d)).join('; ') : '';
  toast(msg + detail, true);
}
async function act(btn, fn) {
  const label = btn?.textContent; if (btn) { btn.disabled = true; btn.replaceChildren(h('span', { class: 'spin' }), ' ', label); }
  try { return await fn(); } catch (e) { fail(e); } finally { if (btn?.isConnected) { btn.disabled = false; btn.textContent = label; } }
}
const formData = form => Object.fromEntries(new FormData(form).entries());
const badge = (status, prefix = 'st_') => status ? h('span', { class: `badge s-${status}`, text: t(prefix + status) }) : null;
const canStart = () => S.me && (S.me.role === 'admin' || S.me.role === 'approver');
const isAdmin = () => S.me?.role === 'admin';
const panel = (title, ...kids) => h('section', { class: 'panel stack' }, title && h('h2', { text: title }), ...kids);
const finding = (prefix, r) => (has(prefix + r.code) ? t(prefix + r.code, r.params) : null);
const mapToText = m => Object.entries(m ?? {}).map(([f, c]) => `${f} = ${c}`).join('\n');
const textToMap = s => Object.fromEntries(String(s).split('\n').map(l => l.split('=').map(x => x.trim())).filter(([f, c]) => f && c));

// ---------- shell ----------
function applyBranding() {
  const { org } = S.config;
  document.documentElement.style.setProperty('--accent', org.accent);
  $('#product').textContent = org.productName; $('#org').textContent = org.name;
  $('#logo').textContent = org.logoText || 'AN';
  document.title = org.productName;
}
function shell() {
  $('#top').hidden = !S.me;
  if (!S.me) return;
  const route = location.hash.split('/')[1] || '';
  $('#nav').replaceChildren(...[['', 'nav_campaigns'], ['definitions', 'nav_definitions'], ['tasks', 'nav_tasks'], ['audit', 'nav_audit'], ['settings', 'nav_settings']].map(([r, k]) =>
    h('a', { href: '#/' + r, 'aria-current': (route === r || (r === '' && route === 'c')) ? 'page' : false, text: t(k) })));
  $('#who').textContent = `${S.me.name} · ${t('role_' + S.me.role)}`;
  $('#logout').textContent = t('logout');
}
$('#lang').addEventListener('click', () => { setLang(getLang() === 'en' ? 'de' : 'en'); try { localStorage.setItem('antera.lang', getLang()); } catch {} render(); });
$('#logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); S.me = null; location.hash = '#/'; render(); });
window.addEventListener('hashchange', () => render());

async function render() {
  $('#lang').textContent = getLang() === 'en' ? 'DE' : 'EN';
  if (S.config.needsSetup) { shell(); return viewSetup(); }
  if (!S.me) { shell(); return viewLogin(); }
  shell();
  const [, route, id] = location.hash.split('/');
  try {
    if (route === 'c' && id) await viewCampaign(Number(id));
    else if (route === 'definitions') await viewDefinitions();
    else if (route === 'tasks') await viewTasks();
    else if (route === 'audit') await viewAudit();
    else if (route === 'settings') await viewSettings();
    else await viewCampaigns();
  } catch (e) { fail(e); }
  main.focus({ preventScroll: true });
}

// ---------- auth ----------
function authCard(title, sub, fields, submitLabel, onSubmit) {
  const form = h('form', { class: 'form' }, ...fields, h('button', { class: 'primary', type: 'submit', text: submitLabel }));
  form.addEventListener('submit', e => { e.preventDefault(); act(form.querySelector('button[type=submit]'), () => onSubmit(formData(form))); });
  main.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'panel stack' },
    h('div', { class: 'row' }, h('span', { class: 'logo', text: S.config.org.logoText || 'AN' }), h('span', { class: 'kicker', text: t('principle') })),
    h('h1', { text: title }), sub && h('p', { class: 'banner', text: sub }), form,
    h('button', { class: 'ghost small', type: 'button', onclick: () => $('#lang').click(), text: getLang() === 'en' ? 'Deutsch' : 'English' }))));
  form.querySelector('input')?.focus();
}
function field(name, labelKey, type = 'text', extra = {}) {
  return h('label', { class: 'f' }, t(labelKey), h('input', { name, type, required: extra.required !== false, autocomplete: extra.autocomplete, minlength: extra.minlength, value: extra.value, step: extra.step }), extra.hint && h('span', { class: 'small', text: extra.hint }));
}
function viewSetup() {
  authCard(t('setup_title', { product: S.config.org.productName }), t('setup_sub'), [
    field('name', 'name', 'text', { autocomplete: 'name' }), field('email', 'email', 'email', { autocomplete: 'email' }),
    field('password', 'password', 'password', { autocomplete: 'new-password', minlength: 10, hint: t('pw_hint') })
  ], t('create_admin'), async d => { const r = await api('/setup', { method: 'POST', body: d }); S.me = r.user; S.config.needsSetup = false; location.hash = '#/'; render(); });
}
function viewLogin() {
  authCard(t('login_title', { product: S.config.org.productName }), S.config.demo ? t('demo_banner') : null, [
    field('email', 'email', 'email', { autocomplete: 'username' }), field('password', 'password', 'password', { autocomplete: 'current-password' })
  ], t('login'), async d => { const r = await api('/login', { method: 'POST', body: d }); S.me = r.user; render(); });
}

// ---------- campaigns ----------
function campaignForm(c, defs, onSave, onCancel) {
  const keys = [...new Set(defs.filter(d => d.active).map(d => d.key))];
  const goal = h('select', { name: 'goal_key' }, ...keys.map(k => h('option', { value: k, selected: c.goal_key === k, text: k })));
  const form = h('form', { class: 'form' },
    h('div', { class: 'two' }, field('name', 'f_name', 'text', { value: c.name ?? '' }), field('channel', 'f_channel', 'text', { value: c.channel ?? '', required: false })),
    h('div', { class: 'two' }, h('label', { class: 'f' }, t('f_goal'), goal), field('attribution_key', 'f_attr', 'text', { value: c.attribution_key ?? '', required: false })),
    field('landing_url', 'f_url', 'url', { value: c.landing_url ?? '', required: false }),
    field('form_fields', 'f_form', 'text', { value: (c.form_fields ?? []).join(', '), required: false }),
    h('label', { class: 'f' }, t('f_map'), h('textarea', { name: 'crm_mapping', class: 'code', text: mapToText(c.crm_mapping) }), h('span', { class: 'small', text: t('f_map_hint', { fields: S.config.rules.crmComputedFields }) })),
    h('div', { class: 'two' }, field('consent_field', 'f_consent', 'text', { value: c.consent_field ?? '', required: false }), field('daily_budget', 'f_budget', 'number', { value: c.daily_budget ?? 0, required: false, step: 'any' })),
    h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit', text: t('save') }), h('button', { class: 'ghost', type: 'button', onclick: onCancel, text: t('cancel') })));
  form.addEventListener('submit', e => {
    e.preventDefault();
    const d = formData(form);
    act(form.querySelector('button[type=submit]'), () => onSave({ ...d, crm_mapping: textToMap(d.crm_mapping), daily_budget: Number(d.daily_budget || 0) }));
  });
  return form;
}

async function viewCampaigns() {
  const [list, defs] = await Promise.all([api('/campaigns'), api('/definitions')]);
  const slot = h('div');
  const newBtn = h('button', { class: 'primary', text: t('new_campaign'), onclick: () => {
    slot.replaceChildren(panel(t('new_campaign'), campaignForm({ goal_key: 'sql', consent_field: 'consent', form_fields: ['email', 'consent'], crm_mapping: { email: 'email', consent: 'consent' } }, defs,
      async d => { const r = await api('/campaigns', { method: 'POST', body: d }); location.hash = '#/c/' + r.campaign.id; },
      () => slot.replaceChildren())));
  } });
  main.replaceChildren(
    h('div', { class: 'row between' }, h('div', {}, h('span', { class: 'kicker', text: t('principle') }), h('h1', { text: t('camps_title') })), newBtn),
    h('p', { class: 'sub', text: t('camps_sub') }), slot,
    list.length ? h('div', { class: 'cards' }, ...list.map(c => h('a', { class: 'card', href: '#/c/' + c.id },
      h('div', { class: 'row between' }, h('span', { class: 'tag', text: c.channel || '—' }), h('div', { class: 'row' }, badge(c.state), c.state === 'draft' ? badge(c.launch_status) : badge(c.health))),
      h('h3', { text: c.name }),
      h('div', { class: 'small muted', text: `${t('owner')}: ${c.owner_name} · ${t('spend')}: ${t('spend_' + c.spend_state)}` }),
      c.open_tasks ? h('div', { class: 'small warn', text: `${c.open_tasks} ${t('open_tasks')}` }) : null))) : h('div', { class: 'empty', text: t('no_campaigns') }));
}

function chainView(results) {
  const by = new Map((results ?? []).map(r => [r.stage, r]));
  return h('div', { class: 'chain' }, ...STAGES.map((s, i) => {
    const r = by.get(s);
    const st = r?.status ?? 'none';
    return h('div', { class: 'cn r-' + st, title: r ? finding('o_', r) : '' },
      h('div', { class: 'dot', text: st === 'pass' ? '✓' : st === 'fail' ? '✕' : st === 'unknown' ? '?' : String(i + 1) }),
      h('span', { class: 'lbl', text: t('stage_' + s) }));
  }));
}

function findingsView(results) {
  const open = (results ?? []).filter(r => r.status !== 'pass');
  const passes = (results ?? []).filter(r => r.status === 'pass');
  return h('div', { class: 'stack' },
    open.length ? h('div', {}, ...open.map(r => h('div', { class: 'find' },
      h('div', { class: 'head' }, h('span', { class: 'tag ' + (r.status === 'fail' ? 'crit' : ''), text: r.status === 'fail' ? 'FAIL' : '?' }), h('b', { text: t('stage_' + r.stage) }), h('span', { class: 'mono muted', text: r.code })),
      h('dl', { class: 'oiv' },
        h('dt', { class: 'o', text: t('observed') }), h('dd', { text: finding('o_', r) ?? r.code }),
        finding('i_', r) && h('dt', { class: 'i', text: t('inferred') }), finding('i_', r) && h('dd', { text: finding('i_', r) }),
        finding('v_', r) && h('dt', { class: 'v', text: t('verify') }), finding('v_', r) && h('dd', { text: finding('v_', r) }))))) : null,
    passes.length ? h('details', { class: 'more', open: !open.length || undefined }, h('summary', { text: `${t('passed')} (${passes.length})` }),
      h('ul', { class: 'passes' }, ...passes.map(r => h('li', { text: finding('o_', r) ?? r.code })))) : null);
}

function reasonForm(labelKey, onConfirm) {
  const input = h('textarea', { name: 'reason', required: true, minlength: 5 });
  const form = h('form', { class: 'inline-form' }, h('label', { class: 'f' }, t('reason'), input),
    h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit', text: t(labelKey) }), h('button', { class: 'ghost', type: 'button', onclick: () => form.remove(), text: t('cancel') })));
  form.addEventListener('submit', e => { e.preventDefault(); act(form.querySelector('button[type=submit]'), () => onConfirm(input.value)); });
  setTimeout(() => input.focus(), 0);
  return form;
}

async function viewCampaign(id) {
  const d = await api('/campaigns/' + id);
  const c = d.campaign;
  const reload = () => viewCampaign(id);
  const lastPause = d.interventions.find(i => i.action === 'pause');

  // Headline
  let key = c.state === 'draft' ? `draft_${c.launch_status}` : c.state === 'live' ? `live_${c.health || 'HEALTHY'}` : c.state;
  let head = 'head_' + key, expl = 'expl_' + (c.state === 'live' && c.health === 'BROKEN' ? 'live_UNCLEAR' : key);
  if (c.state === 'paused' && lastPause?.by_kind === 'system') head = 'head_paused_sys';
  const heroCls = c.state === 'draft' ? `s-${c.launch_status}` : c.state === 'live' && c.health === 'UNCLEAR' ? 's-UNCLEAR' : `s-${c.state}`;
  const actionSlot = h('div');

  const startable = c.state === 'draft' || c.state === 'paused';
  const whyNot = c.launch_status !== 'GO' ? t('start_why_not_go') : !canStart() ? t('start_why_role') : (S.config.rules.fourEyes && c.owner_id === S.me.id) ? t('start_why_owner') : null;
  const startBtn = startable && h('button', { class: 'primary', disabled: !!whyNot, title: whyNot ?? '', text: t(c.state === 'draft' ? 'start' : 'restart'),
    onclick: () => actionSlot.replaceChildren(reasonForm(c.state === 'draft' ? 'start' : 'restart', async reason => { await api(`/campaigns/${id}/start`, { method: 'POST', body: { reason } }); toast(t('saved')); reload(); })) });

  const hero = h('section', { class: 'hero ' + heroCls },
    h('div', { class: 'row' }, badge(c.state), badge(c.launch_status), c.state !== 'draft' ? badge(c.health) : null, h('span', { class: 'small muted', text: `${t('spend')}: ${t('spend_' + c.spend_state)}` })),
    h('div', { class: 'big', text: t(head) }),
    h('p', { class: 'muted', text: t(expl) }),
    c.state === 'paused' && lastPause?.cause?.code ? h('p', { class: 'notice', text: `${t('cause')}: ${finding('o_', lastPause.cause) ?? lastPause.cause.code}` }) : null,
    startable ? h('div', { class: 'row' }, startBtn, whyNot ? h('span', { class: 'small muted', text: whyNot }) : null) : null,
    actionSlot);

  // Left column: chain + findings + monitoring + configuration
  const left = h('div', { class: 'stack' },
    panel(null, h('div', { class: 'row between' }, h('h2', { text: t('chain_title') }), h('span', { class: 'small muted', text: d.launch ? t('checked', { when: fmtDate(d.launch.ran_at) }) : t('never_checked') })),
      h('p', { class: 'small muted', text: t('chain_sub') }), chainView(d.launch?.results), findingsView(d.launch?.results)),
    (c.state === 'live' || c.state === 'paused') && d.monitor ? panel(null, h('div', { class: 'row between' }, h('h2', { text: t('mon_title') }), h('span', { class: 'small muted', text: t('checked', { when: fmtDate(d.monitor.ran_at) }) })),
      h('p', { class: 'small muted', text: t('mon_sub', { h: d.evidence.windowHours }) }), findingsView(d.monitor.results.filter(r => ['sync', 'complete', 'activity'].includes(r.id)))) : null,
    configPanel(d, reload),
    auditPanel(id));

  // Right column: actions, demo, evidence, tasks, interventions
  const right = h('div', { class: 'stack' },
    panel(null, h('div', { class: 'row' },
      c.state !== 'ended' && h('button', { class: 'ghost', text: t('run_checks'), onclick: e => act(e.currentTarget, async () => { await api(`/campaigns/${id}/check`, { method: 'POST' }); reload(); }) }),
      c.state === 'live' && h('button', { class: 'danger', text: t('pause'), onclick: () => actionSlot.replaceChildren(reasonForm('pause', async reason => { await api(`/campaigns/${id}/pause`, { method: 'POST', body: { reason } }); reload(); })) }),
      c.state !== 'ended' && h('button', { class: 'ghost small', text: t('end_c'), onclick: e => { if (confirm(t('end_c') + '?')) act(e.currentTarget, async () => { await api(`/campaigns/${id}/end`, { method: 'POST' }); reload(); }); } }))),
    S.config.demo && c.state !== 'ended' ? demoPanel(id, reload) : null,
    panel(t('evidence', { h: d.evidence.windowHours }), h('dl', { class: 'kv' },
      h('dt', { text: t('ev_subs') }), h('dd', { text: d.evidence.submissions }), h('dt', { text: t('ev_records') }), h('dd', { text: d.evidence.records }),
      h('dt', { text: t('ev_tests') }), h('dd', { text: d.evidence.tests }), h('dt', { text: t('ev_spend') }), h('dd', { text: d.evidence.spend }),
      h('dt', { text: t('ev_deals') }), h('dd', { text: d.evidence.deals }))),
    panel(t('tasks'), d.tasks.filter(x => !x.done_at).length ? h('div', {}, ...d.tasks.filter(x => !x.done_at).map(x => taskRow(x, reload, false))) : h('p', { class: 'small muted', text: t('no_tasks') })),
    panel(t('history'), d.interventions.length ? h('ul', { class: 'timeline' }, ...d.interventions.map(i => h('li', { class: i.by_kind },
      h('b', { text: t('act_' + i.action) }), ' · ', h('span', { class: 'small muted', text: fmtDate(i.at) }), h('br'),
      h('span', { class: 'small', text: i.by_kind === 'system' ? t('by_system', { rule: i.rule }) : t('by_human', { name: i.actor_name }) }),
      i.reason ? h('div', { class: 'small muted', text: '“' + i.reason + '”' }) : null,
      i.cause?.code ? h('div', { class: 'small muted', text: finding('o_', i.cause) ?? i.cause.code }) : null))) : h('p', { class: 'small muted', text: t('no_history') })));

  main.replaceChildren(
    h('a', { href: '#/', class: 'small muted', text: t('back') }),
    h('div', {}, h('span', { class: 'kicker', text: c.channel || '—' }), h('h1', { text: c.name }), h('p', { class: 'small muted', text: `${t('owner')}: ${c.owner_name} · rules ${d.rulesVersion} · ${d.controllerVersion}` })),
    hero, h('div', { class: 'grid2' }, left, right));
}

function configPanel(d, reload) {
  const c = d.campaign;
  const body = h('div');
  const show = () => body.replaceChildren(h('dl', { class: 'kv' },
    h('dt', { text: t('f_goal') }), h('dd', { text: c.goal_key || '—' }),
    h('dt', { text: t('f_attr') }), h('dd', { text: c.attribution_key || '—' }),
    h('dt', { text: t('f_url') }), h('dd', { text: c.landing_url || '—' }),
    h('dt', { text: t('f_form') }), h('dd', { text: c.form_fields.join(', ') || '—' }),
    h('dt', { text: t('f_map') }), h('dd', {}, h('pre', { text: mapToText(c.crm_mapping) || '—' })),
    h('dt', { text: t('f_consent') }), h('dd', { text: c.consent_field || '—' }),
    h('dt', { text: t('f_budget') }), h('dd', { text: c.daily_budget })),
    h('h3', { class: 'small muted', text: t('defs_used') }),
    h('ul', { class: 'passes' }, ...Object.values(d.definitions).map(def => h('li', { text: `${def.key} v${def.version}: ${def.criteria.map(crit).join(' · ')}` }))));
  show();
  const editBtn = c.state !== 'ended' && h('button', { class: 'ghost small', text: t('edit'), onclick: async () => {
    const defs = await api('/definitions');
    body.replaceChildren(campaignForm(c, defs, async data => { await api('/campaigns/' + c.id, { method: 'PATCH', body: data }); toast(t('saved')); reload(); }, show));
  } });
  return panel(null, h('div', { class: 'row between' }, h('h2', { text: t('config_title') }), editBtn), body);
}

function demoPanel(id, reload) {
  const b = (key, action) => h('button', { class: 'ghost small', text: t(key), onclick: e => act(e.currentTarget, async () => { await api('/demo/' + action, { method: 'POST', body: { campaignId: id } }); reload(); }) });
  return h('section', { class: 'demo' }, h('h2', { text: t('demo_title') }), h('p', { class: 'small muted', text: t('demo_sub') }),
    h('div', { class: 'row' }, b('demo_test', 'test-lead'), b('demo_test_broken', 'test-lead-broken')),
    h('div', { class: 'row' }, b('demo_traffic', 'traffic'), b('demo_traffic_broken', 'traffic-broken'), b('demo_spend', 'spend-only')));
}

function auditPanel(id) {
  const box = h('div');
  const det = h('details', { class: 'more' }, h('summary', { text: t('nav_audit') }), box);
  det.addEventListener('toggle', async () => { if (det.open && !box.childElementCount) { try { box.append(auditTable((await api(`/campaigns/${id}/audit`)).entries, false)); } catch (e) { fail(e); } } });
  return det;
}

// ---------- definitions ----------
function crit(c) {
  const v = Array.isArray(c.value) ? c.value.join(', ') : c.value;
  return t('op_' + c.op, { field: c.field, value: v });
}

async function viewDefinitions() {
  const defs = await api('/definitions');
  const groups = new Map();
  for (const d of defs) { if (!groups.has(d.key)) groups.set(d.key, []); groups.get(d.key).push(d); }
  const slot = h('div');
  const openForm = base => {
    const form = h('form', { class: 'form' },
      h('div', { class: 'two' }, field('key', 'key', 'text', { value: base?.key ?? '' }), field('label', 'label', 'text', { value: base?.label ?? '' })),
      h('label', { class: 'f' }, t('criteria_json'), h('textarea', { name: 'criteria', class: 'code', text: JSON.stringify(base?.criteria ?? [{ field: 'consent', op: 'eq', value: true }], null, 2) }), h('span', { class: 'small', text: t('criteria_help') })),
      h('label', { class: 'f' }, t('note'), h('input', { name: 'note', required: true })),
      h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit', text: t('create') }), h('button', { class: 'ghost', type: 'button', onclick: () => slot.replaceChildren(), text: t('cancel') })));
    form.addEventListener('submit', e => {
      e.preventDefault();
      const d = formData(form);
      act(form.querySelector('button[type=submit]'), async () => {
        let criteria; try { criteria = JSON.parse(d.criteria); } catch { throw Object.assign(new Error(), { code: 'INVALID_JSON' }); }
        await api('/definitions', { method: 'POST', body: { ...d, criteria } }); toast(t('saved')); viewDefinitions();
      });
    });
    slot.replaceChildren(panel(t('new_version'), form));
    slot.scrollIntoView({ behavior: 'smooth' });
  };
  main.replaceChildren(
    h('div', { class: 'row between' }, h('h1', { text: t('defs_title') }), isAdmin() ? h('button', { class: 'primary', text: t('new_version'), onclick: () => openForm(null) }) : h('span', { class: 'small muted', text: t('admin_only') })),
    h('p', { class: 'sub', text: t('defs_sub') }), slot,
    h('div', { class: 'cards' }, ...[...groups].map(([key, versions]) => {
      const cur = versions.find(v => v.active) ?? versions[0];
      return h('section', { class: 'panel defcard stack' },
        h('div', { class: 'row between' }, h('span', { class: 'kicker', text: key }), h('span', { class: 'tag', text: `${t('version')} ${cur.version} · ${t('active')}` })),
        h('h3', { text: cur.label }),
        h('ul', { class: 'crit' }, ...cur.criteria.map(c => h('li', { text: crit(c) }))),
        cur.note ? h('p', { class: 'small muted', text: '“' + cur.note + '”' }) : null,
        h('div', { class: 'small muted', text: t('by_on', { name: cur.created_by_name ?? '—', when: fmtDate(cur.created_at) }) }),
        versions.length > 1 ? h('details', { class: 'more' }, h('summary', { text: `${t('older')} (${versions.length - 1})` }),
          ...versions.filter(v => v !== cur).map(v => h('div', { class: 'small' }, h('b', { text: `v${v.version}` }), ' ', v.criteria.map(crit).join(' · '), v.note ? h('div', { class: 'muted', text: '“' + v.note + '”' }) : null))) : null,
        isAdmin() ? h('button', { class: 'ghost small', text: t('new_version'), onclick: () => openForm(cur) }) : null);
    })));
}

// ---------- tasks ----------
function taskRow(x, reload, withCampaign = true) {
  return h('div', { class: 'task' + (x.done_at ? ' done' : '') },
    h('div', { class: 'stack' }, withCampaign && x.campaign_id ? h('a', { href: '#/c/' + x.campaign_id, class: 'small', text: x.campaign_name }) : null,
      h('div', { text: t('task_' + x.code) }),
      x.cause?.code ? h('div', { class: 'small muted', text: finding('o_', x.cause) ?? x.cause.code }) : null,
      h('div', { class: 'small muted', text: `${fmtDate(x.created_at)}${x.rule ? ' · ' + x.rule : ''}` })),
    x.done_at ? h('span', { class: 'tag', text: t('done') }) : h('button', { class: 'ghost small', text: t('mark_done'), onclick: e => act(e.currentTarget, async () => { await api(`/tasks/${x.id}/done`, { method: 'POST' }); reload(); }) }));
}
let showDone = false;
async function viewTasks() {
  const list = await api('/tasks' + (showDone ? '?all=1' : ''));
  main.replaceChildren(
    h('div', { class: 'row between' }, h('h1', { text: t('tasks_title') }), h('button', { class: 'ghost small', text: t(showDone ? 'show_open' : 'show_done'), onclick: () => { showDone = !showDone; viewTasks(); } })),
    h('p', { class: 'sub', text: t('tasks_sub') }),
    list.length ? h('section', { class: 'panel' }, ...list.map(x => taskRow(x, viewTasks))) : h('div', { class: 'empty', text: t('no_tasks') }));
}

// ---------- audit ----------
function auditTable(entries, withCampaign = true) {
  return h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', { text: t('when') }), h('th', { text: t('who') }), h('th', { text: t('action') }), withCampaign && h('th', { text: t('campaign') }), h('th', { text: t('details') }))),
    h('tbody', {}, ...entries.map(e => h('tr', {},
      h('td', { class: 'mono', text: fmtDate(e.at) }), h('td', { text: e.actor_name ?? t('system') }), h('td', { class: 'mono', text: e.action }),
      withCampaign && h('td', {}, e.campaign_id ? h('a', { href: '#/c/' + e.campaign_id, text: '#' + e.campaign_id }) : '—'),
      h('td', { class: 'mono small muted', text: JSON.stringify(e.data).slice(0, 220) }))))));
}
async function viewAudit() {
  const { entries, integrity } = await api('/audit');
  main.replaceChildren(h('h1', { text: t('audit_title') }), h('p', { class: 'sub', text: t('audit_sub') }),
    h('p', { class: integrity.ok ? 'notice ok' : 'notice bad', text: integrity.ok ? t('audit_ok') : t('audit_broken', { id: integrity.brokenAt }) }),
    h('section', { class: 'panel' }, auditTable(entries)));
}

// ---------- settings ----------
async function viewSettings() {
  const [users, tokens] = await Promise.all([api('/users'), api('/tokens')]);
  const tokenSlot = h('div');
  const tokenForm = h('form', { class: 'row' }, h('input', { name: 'name', placeholder: t('token_name'), required: true }), h('button', { class: 'primary', type: 'submit', text: t('create_token') }));
  tokenForm.addEventListener('submit', e => { e.preventDefault(); act(tokenForm.querySelector('button'), async () => {
    const r = await api('/tokens', { method: 'POST', body: formData(tokenForm) });
    tokenSlot.replaceChildren(h('p', { class: 'small warn', text: t('token_once') }), h('div', { class: 'secret', text: r.token }));
  }); });
  const userForm = isAdmin() && h('form', { class: 'form' },
    h('div', { class: 'two' }, field('name', 'name'), field('email', 'email', 'email')),
    h('div', { class: 'two' }, field('password', 'password', 'password', { minlength: 10 }), h('label', { class: 'f' }, t('role'), h('select', { name: 'role' }, ...['member', 'approver', 'admin'].map(r => h('option', { value: r, text: t('role_' + r) }))))),
    h('button', { class: 'primary', type: 'submit', text: t('add_user') }));
  if (userForm) userForm.addEventListener('submit', e => { e.preventDefault(); act(userForm.querySelector('button[type=submit]'), async () => { await api('/users', { method: 'POST', body: formData(userForm) }); toast(t('saved')); viewSettings(); }); });
  const example = `curl -X POST ${location.origin}/api/ingest \\\n  -H "Authorization: Bearer ant_…" -H "Content-Type: application/json" \\\n  -d '{"events":[{"kind":"form_submit","utm_campaign":"webinar-ai-sales","email":"lead@example.com","fields":{"company_size":"50-249","consent":true}}],"recheck":true}'`;

  main.replaceChildren(h('h1', { text: t('settings_title') }),
    h('div', { class: 'grid2' },
      h('div', { class: 'stack' },
        panel(t('rules_title'), h('div', { class: 'rules' },
          h('div', {}, h('b', { class: 'ok', text: t('may') }), h('ul', {}, ...t('may_list').split('|').map(x => h('li', { text: x })))),
          h('div', {}, h('b', { class: 'bad', text: t('never') }), h('ul', {}, ...t('never_list').split('|').map(x => h('li', { text: x }))))),
          h('p', { class: 'small muted', text: `${t('adapter')}: ${t('adapter_' + S.config.adapter)}` })),
        panel(t('team'), h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, ...users.map(u => h('tr', {},
          h('td', { text: u.name }), h('td', { class: 'small muted', text: u.email }),
          h('td', {}, isAdmin() && u.id !== S.me.id
            ? h('select', { onchange: e => act(null, async () => { await api('/users/' + u.id, { method: 'PATCH', body: { role: e.target.value } }); toast(t('saved')); }) }, ...['member', 'approver', 'admin'].map(r => h('option', { value: r, selected: u.role === r, text: t('role_' + r) })))
            : t('role_' + u.role)),
          h('td', {}, isAdmin() && u.id !== S.me.id ? h('button', { class: 'ghost small', text: u.disabled ? t('enable') : t('disable'), onclick: e => act(e.currentTarget, async () => { await api('/users/' + u.id, { method: 'PATCH', body: { disabled: !u.disabled } }); viewSettings(); }) }) : null)))))),
          userForm || null)),
      h('div', { class: 'stack' },
        panel(t('tokens'), h('p', { class: 'small muted', text: t('tokens_sub') }), tokenForm, tokenSlot,
          tokens.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, ...tokens.map(tk => h('tr', {}, h('td', { text: tk.name }), h('td', { class: 'small muted', text: fmtDate(tk.last_used_at) }),
            h('td', {}, h('button', { class: 'ghost small', text: t('revoke'), onclick: e => act(e.currentTarget, async () => { await api('/tokens/' + tk.id, { method: 'DELETE' }); viewSettings(); }) }))))))) : null,
          h('h3', { text: t('ingest_example') }), h('pre', { text: example })))));
}

// ---------- boot ----------
(async () => {
  try { S.config = await api('/config'); } catch { main.textContent = 'Could not reach the server.'; return; }
  let saved = null; try { saved = localStorage.getItem('antera.lang'); } catch {}
  setLang(saved || S.config.language);
  applyBranding();
  if (!S.config.needsSetup) S.me = (await api('/me').catch(() => null))?.user ?? null;
  render();
})();
