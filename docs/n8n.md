# Connecting ANTERA with n8n

ANTERA does not talk to your ad platforms or CRM directly. Connectors send it **evidence**, and ANTERA sends **pause requests** back. n8n is a good fit for both directions: each one is a small workflow.

```
 Form tool ─┐                                   ┌─► n8n "pause" workflow ─► Google / Meta / LinkedIn Ads API
 CRM ───────┼─► n8n "evidence" workflow ─► ANTERA ─┤
 Ads spend ─┘        POST /api/ingest              └─► n8n "notify" workflow ─► Slack / Teams
```

## 1. Evidence in: `POST /api/ingest`

Create an API token in ANTERA under **Settings → API tokens**. In n8n, add an **HTTP Request** node:

- Method: `POST`
- URL: `https://your-antera/api/ingest`
- Authentication: Header `Authorization: Bearer ant_…`
- Body (JSON):

```json
{
  "events": [
    { "kind": "form_submit", "utm_campaign": "webinar-ai-sales", "email": "{{ $json.email }}", "at": "{{ $json.submitted_at }}",
      "fields": { "company_size": "{{ $json.company_size }}", "consent": true } },
    { "kind": "crm_record", "utm_campaign": "webinar-ai-sales", "email": "{{ $json.email }}",
      "fields": { "company_size": "{{ $json.properties.company_size }}", "lifecycle_stage": "{{ $json.properties.lifecyclestage }}", "consent": true } }
  ],
  "recheck": true
}
```

| Field | Meaning |
|---|---|
| `kind` | `form_submit`, `crm_record`, `spend` or `deal` |
| `campaign` or `utm_campaign` | ANTERA campaign id, or its attribution key |
| `email` or `ref` | Links the form submission to its CRM record. Emails are hashed on arrival and never stored. |
| `test` | `true` for test leads (used for the launch check, ignored by live monitoring) |
| `fields` | CRM field values. Names, emails, phone numbers and addresses are dropped automatically. |
| `amount` | For `spend` and `deal` events |
| `at` | ISO time or epoch ms. Defaults to "now". |
| `recheck` | `true` re-runs the chain for affected campaigns right away |

Typical workflows:

- **Form → ANTERA:** a webhook trigger from your form tool, then one `form_submit` event.
- **CRM → ANTERA:** a HubSpot/Salesforce trigger "contact created/updated", then one `crm_record` event with the fields your definitions read.
- **Ads spend → ANTERA:** a daily schedule, a call to the Ads reporting API, then one `spend` event per campaign.

## 2. Pause out: the webhook adapter

In `antera.config.json`:

```json
{ "adapter": { "type": "webhook", "url": "https://your-n8n/webhook/antera-ads" } }
```

When the chain breaks, ANTERA POSTs:

```json
{ "action": "pause", "campaign": { "id": 2, "name": "Whitepaper", "channel": "Google Ads", "attribution_key": "whitepaper-pipeline" },
  "why": { "rule": "C1_PAUSE_ON_BROKEN_CHAIN", "cause": { "check": "complete", "code": "MON_FIELDS_DROPPED", "params": { "pct": 53, "fields": ["company_size"] } } } }
```

Build the n8n workflow as: **Webhook trigger → Switch on `action` → Ads API node** (e.g. set the campaign status to `PAUSED`). Respond with HTTP 200 only when the pause actually worked. If n8n answers with an error or does not answer within 8 seconds, ANTERA marks the spend state as *unknown* and creates the task "pause by hand".

The same workflow receives `"action": "resume"`, but **only** after a named approver restarted the campaign in ANTERA with a reason and a fresh GO. ANTERA never sends `resume` on its own.

> Tip: give the n8n Ads credentials only the permissions they need. If your Ads API allows it, use a credential that can pause but not raise budgets.

## 3. Notifications: `notify.webhookUrl`

```json
{ "notify": { "webhookUrl": "https://your-n8n/webhook/antera-notify" } }
```

ANTERA sends `campaign.paused` and `campaign.restart_possible` events. Forward them to Slack or Teams with an n8n Slack/Teams node.

## 4. Daily re-check

The server re-checks every campaign once a day by default (`scheduler.recheckMinutes: 1440`). You can also run it from cron or an n8n schedule:

```bash
antera recheck --data /data/antera.db   # exit code 1 if anything was paused
```
