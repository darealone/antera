// Team configuration: branding, language, rule settings, the ad platform adapter and notifications.
// Loaded from antera.config.json (path via --config or ANTERA_CONFIG). Everything is optional.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SETTINGS } from './chain.js';

export const DEFAULTS = Object.freeze({
  org: { name: 'Your team', productName: 'ANTERA', accent: '#70c8bc', logoText: 'AN' },
  language: 'en',
  rules: { ...SETTINGS, fourEyes: true },
  scheduler: { recheckMinutes: 1440 },
  // How a pause reaches the ad platform. "manual": ANTERA records it and creates a task.
  // "webhook": POST to adapter.url (e.g. an n8n workflow that calls the Ads API). "demo": simulated.
  adapter: { type: 'manual', url: '' },
  notify: { webhookUrl: '' },
  // Conversations (call notes, transcripts) are deleted after this many days.
  privacy: { transcriptDays: 90 },
  // Level 2: the read-only AI investigator. Needs the optional @anthropic-ai/sdk package and an API key.
  // `auto`: start an investigation by itself when a live campaign is paused or unclear (at most once a day each).
  investigator: { enabled: true, model: 'claude-opus-5-5', effort: 'high', maxTurns: 12, auto: false }
});

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

const isHttpUrl = s => { try { return ['http:', 'https:'].includes(new URL(s).protocol); } catch { return false; } };

export function loadConfig(path, overrides = {}) {
  const file = path ? resolve(path) : null;
  let user = {};
  if (file && existsSync(file)) {
    try { user = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Could not parse ${file}: ${e.message}`); }
  }
  const cfg = merge(merge(DEFAULTS, user), overrides);
  const p = [];
  if (!['en', 'de'].includes(cfg.language)) p.push('language must be "en" or "de"');
  if (!/^#[0-9a-f]{6}$/i.test(cfg.org.accent)) p.push('org.accent must be a hex colour like #70c8bc');
  for (const n of ['maxTestAgeHours', 'syncGraceMinutes', 'monitorWindowHours', 'minSample']) {
    if (!(Number(cfg.rules[n]) > 0)) p.push(`rules.${n} must be a positive number`);
  }
  for (const n of ['completenessThreshold', 'maxUnsyncedShare']) {
    if (!(cfg.rules[n] >= 0 && cfg.rules[n] <= 1)) p.push(`rules.${n} must be between 0 and 1`);
  }
  if (!Array.isArray(cfg.rules.crmComputedFields)) p.push('rules.crmComputedFields must be a list');
  if (!['manual', 'webhook', 'demo'].includes(cfg.adapter.type)) p.push('adapter.type must be "manual", "webhook" or "demo"');
  if (cfg.adapter.type === 'webhook' && !isHttpUrl(cfg.adapter.url)) p.push('adapter.url must be an http(s) URL when adapter.type is "webhook"');
  if (cfg.notify.webhookUrl && !isHttpUrl(cfg.notify.webhookUrl)) p.push('notify.webhookUrl must be an http(s) URL');
  if (!(Number(cfg.scheduler.recheckMinutes) >= 0)) p.push('scheduler.recheckMinutes must be 0 (off) or more');
  if (!(Number(cfg.privacy.transcriptDays) >= 1)) p.push('privacy.transcriptDays must be 1 or more');
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(cfg.investigator.effort)) p.push('investigator.effort must be low, medium, high, xhigh or max');
  if (!(Number.isInteger(cfg.investigator.maxTurns) && cfg.investigator.maxTurns >= 2 && cfg.investigator.maxTurns <= 40)) p.push('investigator.maxTurns must be an integer from 2 to 40');
  if (p.length) throw new Error('Invalid configuration:\n  - ' + p.join('\n  - '));
  return { ...cfg, file: file && existsSync(file) ? file : null };
}

/** The part of the configuration the browser may see (no webhook URLs). */
export function publicConfig(cfg) {
  return { org: cfg.org, language: cfg.language, rules: cfg.rules, adapter: cfg.adapter.type, privacy: cfg.privacy };
}
