// How a pause reaches the ad platform, and how a human-approved (re)start does.
//
// The controller is handed `pause` and nothing else (see service.js). `resume` is only reachable
// from the human start/restart path, which checks role, personal login and a fresh GO first.
// Adapters never throw: a failed call is reported so a human can act manually.

export function createAdapter(config, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const type = config.adapter?.type ?? 'manual';

  if (type === 'demo') {
    // Simulated platform: the spend state lives in the campaigns table.
    return {
      type,
      pause: async () => ({ ok: true, mode: 'demo', spend: 'paused' }),
      resume: async () => ({ ok: true, mode: 'demo', spend: 'running' })
    };
  }

  if (type === 'webhook') {
    // e.g. an n8n workflow that receives this and calls the Google/Meta/LinkedIn Ads API.
    const call = async (action, campaign, why) => {
      try {
        const res = await fetchImpl(config.adapter.url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, campaign: { id: campaign.id, name: campaign.name, channel: campaign.channel, attribution_key: campaign.attribution_key }, why }),
          signal: AbortSignal.timeout(timeoutMs)
        });
        return res.ok
          ? { ok: true, mode: 'webhook', spend: action === 'pause' ? 'paused' : 'running', http: res.status }
          : { ok: false, mode: 'webhook', spend: 'unknown', http: res.status };
      } catch (e) {
        return { ok: false, mode: 'webhook', spend: 'unknown', error: e.name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE' };
      }
    };
    return { type, pause: (c, why) => call('pause', c, why), resume: (c, why) => call('resume', c, why) };
  }

  // manual: nothing is called; the owner gets a task to act in the ad platform.
  return {
    type: 'manual',
    pause: async () => ({ ok: false, mode: 'manual', spend: 'unknown', manual: true }),
    resume: async () => ({ ok: false, mode: 'manual', spend: 'unknown', manual: true })
  };
}

/** Fire-and-forget notification (Slack/Teams via n8n, or any webhook). Failures are logged, never thrown. */
export function createNotifier(config, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 5000, log = console } = {}) {
  const url = config.notify?.webhookUrl;
  return async payload => {
    if (!url) return { sent: false };
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
      return { sent: res.ok, http: res.status };
    } catch (e) {
      log.error?.(`Notification failed: ${e.message}`);
      return { sent: false };
    }
  };
}
