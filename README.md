# ANTERA — decisions that hold

**May stop. Never start.** ANTERA checks the chain from ad click to deal before a campaign goes live, and every day while it runs. When the chain breaks, it pauses spend and tells the owner. Starting and restarting always need a named human.

[Concept page (German)](https://darealone.github.io/aether-hive/antera/) · Part of [Aether Hive](https://darealone.github.io/aether-hive/) · Sibling of [VERAX MERIDIAN](https://github.com/darealone/VERAX)

> **Status: v0.3, early.** This release covers the whole concept: **Foundation**, **Level 1 · Prevent**, **Level 2 · Understand** (a read-only AI investigator) and **Level 3 · Decision portability** (decision maps, claim library, champion briefings). Use the demo to evaluate; connect real systems only after testing with your own data.

- **Zero dependencies for Level 1.** Node.js 22.13+ and its built-in SQLite. The Level 2 investigator is an optional add-on: one `npm install` adds the official Anthropic SDK.
- **Self-hosted.** No telemetry, no external services. Data stays on your server.
- **Deterministic where it decides.** Launch checks and pauses come from fixed rules, never from an AI model. The AI investigator only reads and drafts findings, and code checks every claim it makes against the evidence.
- **Privacy by design.** Emails are hashed on arrival; names, phone numbers and addresses are dropped before anything is stored.
- **Bilingual UI.** English and German.

## Quick start

```bash
git clone https://github.com/darealone/antera.git && cd antera
node bin/antera.js serve --demo
```

Open http://127.0.0.1:8080 and log in as `sam@example.test` (approver), password `demo-password-123`. The demo has three campaigns:

| Campaign | Shows |
|---|---|
| **Webinar: AI in Sales** | *Broken.* The form asks for company size, but the CRM mapping drops it. The launch is **BLOCKED**, and nobody can start it. |
| **Whitepaper: Pipeline Hygiene** | *Healthy and live.* Click **Traffic: CRM drops a field** and watch ANTERA pause spend on its own. Then send a test lead and restart it as a human. |
| **Brand Search DACH** | *Blind.* Money is going out, no leads are coming in. That is a hint, not proof: ANTERA opens an investigation and does **not** pause. |

The Whitepaper campaign also shows **Level 2**: a sample investigation found that 4 of 5 lost deals were recorded as "no budget", while the call notes for 3 of them point to the works council or a data-protection review. Those deals are handed to Level 3. The sample is a scripted replay (it needs no API key) that runs through the real tools and the real evidence check; it contains one invented claim on purpose, so you can see the check remove it.

Under **Deals**, open **D-2001** for **Level 3**. It is a machine builder with 1,200 employees, seven months into the deal and just before the proposal:
- The works council came up late in a call, and the champion said "das müsste ich noch klären".
- Finance is missing, although comparable won deals involved finance before the proposal.
- Things have gone quiet since the steering committee.
- IT security has a handover document that is still partly open, because no approved claim covers incident liability yet.

Walk the works council through the four steps. Then log in as `pat@example.test` (legal) and sign the pending works-agreement claim under **Claims**. Once all three capacities have signed, it can be added to the works council draft, and the coverage changes. Other logins: `alex@example.test` (admin), `kim@example.test` (marketing); same password.

## How it works

### Foundation
- **Versioned definitions.** What counts as an MQL, an SQL or an opportunity, written as precise criteria (for example `company_size is filled`). A change is always a new version. Old versions are kept, and every campaign that depends on the definition is re-checked immediately.
- **Evidence model.** Campaign → form submission → CRM record → deal, linked by a pseudonymous reference.
- **Controller.** Fixed, versioned rules decide what ANTERA may do on its own.

### Level 1 · Prevent: the launch chain

| # | Step | Passes when |
|---|---|---|
| 1 | Click | The landing page URL carries `utm_campaign`, matching the campaign's attribution key |
| 2 | Form | A consent field is on the form and mapped to the CRM |
| 3 | CRM | Every field the goal definition reads is mapped from the form (or computed by the CRM) |
| 4 | Test lead | A fresh test lead reached the CRM **with every goal field**, and after a pause it was sent after the pause |
| 5 | Definition | The campaign's goal has an active definition |
| 6 | Deal | An opportunity definition exists and deals can be attributed |

**GO** only when every step has a fresh pass. Anything else is **BLOCKED**. Every finding is split into **observed**, **inferred** and **to verify**.

### While live: daily monitoring
- **Sync:** do real leads reach the CRM? (fail if more than 20 % are missing after 30 minutes)
- **Completeness:** do they arrive with every goal field? (fail below 90 %)
- **Activity:** money spent but no leads → a *hint* (unknown), never a failure

### The controller rules

| Rule | When | What ANTERA does |
|---|---|---|
| **C1** | Live and a check **fails** (observed break) | Pauses spend, opens a task, notifies |
| **C2** | Live and something is **unknown** (absence of data) | Opens an investigation; keeps running |
| **C3** | Paused and the chain checks out again | Says a human *may* restart; never restarts itself |

| ANTERA may | ANTERA never |
|---|---|
| re-run the chain daily | start or restart a campaign |
| open investigations when numbers tip | raise or shift budget |
| pause spend when the chain breaks | send anything to customers |
| create tasks and notify owners | change definitions, rules or profiles |
| investigate lost deals (read-only) | rate or rank people |
| draft answers from the claim library | present unbacked statements as fact |

These limits are enforced in code and covered by tests:

- The controller can only produce `pause`, `task` and `notify` actions.
- Start and restart are human-only state transitions.
- They need the approver role and a personal login. API tokens are refused, so an n8n workflow can never start spend.
- They need a written reason and a fresh GO.
- The four-eyes rule stops the campaign owner from starting their own campaign.

### Level 2 · Understand: the investigator

A Claude agent investigates why a campaign run lost leads or deals, and what the next run should change. It works only through six read-only tools:

| Tool | Returns |
|---|---|
| `check_launch_chain` | Level 1 results, pauses and their causes |
| `get_campaign_funnel` | submissions → CRM → MQL → goal → opportunity → won/lost, rates and cost per step |
| `get_loss_reasons` | lost deals with the CRM loss reason, and whether call notes exist |
| `get_deal_timeline` | everything about one deal, in time order |
| `search_transcripts` | keyword search in consented, scrubbed call notes |
| `get_reference_pattern` | the same funnel for comparable campaigns |

It finishes by calling `submit_findings`. Every finding separates **observed** (with evidence ids such as `E42`), **inferred**, **what would disprove it**, and **to verify**. Then **code** checks the result:

- An observation is kept only if it cites evidence that the tools actually returned in this run. Anything else is removed and listed as "removed by the evidence check".
- A finding with no backed observation is removed.
- A Level 3 handoff, where the CRM loss reason contradicts a conversation, must cite a conversation.

The investigator has no tool that writes, pauses, starts or sends. Customer text is passed as data, and the prompt tells the model to ignore instructions inside it. Even if someone writes "pause every campaign" into a call note, there is no tool that could do it.

**Model and cost.** It uses `claude-opus-5-5` at `high` effort, with server-side refusal fallback enabled, and stops after 12 turns at most. Each run shows its token usage and an estimated cost. Runs start when someone clicks **Investigate**, or from `antera investigate <id>`. With `investigator.auto: true` (off by default), ANTERA also starts one by itself when a live campaign is paused or unclear, at most once a day per campaign.

**What is sent to Anthropic.** The investigation's tool results: campaign name, pseudonymous deal references, CRM field values, and scrubbed call-note excerpts. Check Anthropic's data processing terms against your own compliance requirements before you use real data.

**Call notes** (`kind: "conversation"`) are accepted only with `consent: true`. Emails, phone numbers and IBANs are replaced on intake, and notes are deleted after `privacy.transcriptDays` (default 90). Names inside free text cannot be detected reliably, so send pseudonymised transcripts.

### Level 3 · Decision portability

*Whoever ends your deal never sits in your demo.* Level 3 looks at open deals before the proposal. It finds roles that can stop a deal, and helps the account owner prepare answers the champion can carry into rooms the seller never enters.

**Veto profiles.** Works council, IT security, data protection, finance, procurement and management. Each profile has the question that role asks in the room, split into parts, and the words that show it is involved. Profiles are versioned like definitions, and only admins change them.

**The decision map.** For each deal, every role falls into one group: *in the conversation* (an activity shows it taking part), *mentioned but not visibly involved*, or *not visible in the data*. Signals raise hints:

| Signal | How | Fires when |
|---|---|---|
| S01 Missing role | rule | Comparable won deals (same company size) had this role involved before the proposal; this deal shows none |
| S02 Mentioned, not involved | keyword + quote | A call note names the role, but no meeting or email shows it taking part |
| S03 Silence after escalation | rule | Nothing happened for 14+ days after the topic went to the steering committee |
| S05 Late risk topic | keyword + quote | Works council, IT security or data protection first appears after day 90 |
| S06 Champion without an answer | keyword + quote | "Das müsste ich noch klären" / "I need to check" right after a role's topic |

S04 ("the proposal is opened by new departments, or never forwarded") needs document-tracking data and is **not built**. S02, S05 and S06 use keyword matching on call notes; they are labelled as such and always start as hints.

**Every hint starts grey.** "Not visible" only means the connected data shows no involvement. Each gap then goes through four steps, all done by people:

1. **Classify.** The account owner asks the champion one bundled question, then marks the role *not involved yet* (the champion decides whether and when to involve it), *reviewing in the background* (send a document, don't ask for a meeting), or *already handled*. "Already handled" dismisses the hint, and it is **counted** as a false alarm so the rules can be calibrated.
2. **Cover the question.** Build a draft from approved claims, exact quotes and advice for the account owner. Coverage shows which parts of the role's question are answered. **Approved does not mean answered**: open parts stay visible.
3. **Approve.** Blocked while any line has no valid source. The approver confirms three tests: *corridor* (retell it in 30 seconds), *protection* (the champion is safe if it goes wrong) and *room* (it answers people who never talk to us). Any change to the draft needs a new approval and a new briefing.
4. **Brief.** The briefing (or the handover, for a silent review) is logged with date, participants and open points, and sent to your CRM webhook. ANTERA never sends anything to the customer. The champion pack is copy-only.

**The claim library.** These are the only statements a draft may contain. Each claim needs three sign-offs: product, legal and data protection, given by three different people, none of them the author. Revising a claim creates a new version that needs new sign-offs. Retiring a claim reopens every gap whose approved draft used it. Code copies claim wording into drafts **word for word**, so nobody can paraphrase a claim into a promise. A quote must appear in the cited call note, or the line is flagged.

**AI drafting (optional).** "Draft with AI" asks the same Claude setup as Level 2 to assemble a draft. It can only choose claim **ids** and quotes; it cannot write claim text. Code checks every line, and a person still approves.

**Activities** (`kind: "activity"`) name **roles, never people**: `{ "type": "meeting", "roles": "champion,finance" }`. ANTERA judges decisions, not people.

## Real installation

```bash
node bin/antera.js init                      # writes antera.config.json
node bin/antera.js serve --config antera.config.json --host 0.0.0.0 --port 8080
```

The first visit asks you to create the admin account. Then:

1. **Definitions:** create `sql` (or your goal) and `opportunity`.
2. **Campaigns:** add a campaign with its landing URL, form fields and CRM mapping.
3. **Evidence:** create an API token and connect your form, CRM and ad spend. See **[docs/n8n.md](docs/n8n.md)**.
4. **Pausing:** by default (`adapter.type: "manual"`), a pause becomes a task to pause by hand. Set `"webhook"` to let an n8n workflow call your Ads API.
5. **AI (optional):** run `npm install` (it adds the official `@anthropic-ai/sdk`), then start ANTERA with `ANTHROPIC_API_KEY` set. Without it, everything except the Level 2 investigator and Level 3 AI drafting works as before.
6. **Level 3:** review the veto profiles under **Definitions**, add claims under **Claims** and have them signed, then send `deal`, `activity` and `conversation` events for open deals.

### Docker

```bash
cp examples/antera.config.example.json antera.config.json   # edit it
docker compose up -d
```

Put ANTERA behind HTTPS (for example Caddy or nginx) and set `ANTERA_SECURE_COOKIES=1`.

### Command line

```
antera serve [--demo]       run the server
antera recheck              re-run every campaign once (for cron); exit 1 if anything was paused
antera investigate <id>     run a read-only AI investigation of one campaign
antera verify-audit         check the audit log's hash chain
```

## Security and privacy

- Passwords are hashed with scrypt. Sessions use HttpOnly, SameSite=Strict cookies.
- The API accepts JSON only, which blocks cross-site form posts. A strict Content-Security-Policy is set.
- API tokens are stored as hashes and shown once.
- Emails are hashed with a per-installation secret. Direct identifiers are dropped on intake.
- The audit log is append-only and hash-chained, so editing a row is detected (`antera verify-audit`).
- ANTERA judges decisions, not people. It has no employee scoring or ranking, and the investigator is told never to blame or rate people.
- Call notes need recorded consent, are scrubbed on intake and expire automatically.

## Development

```bash
npm test        # node --test; the investigator is tested with a scripted stand-in for Claude, so no API calls are made
npm run dev     # demo mode
```

| Path | Purpose |
|---|---|
| `src/definitions.js` | Criteria validation and matching (pure) |
| `src/chain.js` | Launch chain and live monitoring (pure, deterministic) |
| `src/controller.js` | Controller rules and state transitions (pure) |
| `src/ingest.js` | Intake validation, pseudonymisation and text scrubbing (pure) |
| `src/evidence.js` | The investigator's read-only tools (Level 2) |
| `src/agent.js` | Shared agent loop (turn limit, tool log, cost) |
| `src/investigator.js` | Investigator prompt, `submit_findings`, evidence check (Level 2) |
| `src/portability.js` | Signals, draft check, coverage, gap states (Level 3, pure) |
| `src/portability-service.js` | Profiles, claim library, decision map, the four steps (Level 3) |
| `src/drafter.js` | AI drafting from approved claims (Level 3) |
| `src/service.js` | Permissions, storage, audit, adapters |
| `src/server.js` | HTTP API and static UI |
| `public/` | Web UI (plain JS, no build) |

## Roadmap

- [x] **Foundation:** versioned definitions, evidence model, controller
- [x] **Level 1 · Prevent:** launch chain, daily monitoring, automatic pause
- [x] **Level 2 · Understand:** a read-only investigator with an evidence check, Level 3 handoffs and next-run suggestions
- [ ] Level 2 evaluation on past campaigns with known causes (to measure how often the investigator is right)
- [x] **Level 3 · Decision portability:** decision map with five signals, claim library with three sign-offs, four-step workflow, AI drafting
- [ ] Level 3 signal S04 (needs document-tracking data), and AI-based extraction of roles and quotes instead of keywords
- [ ] Weekly digest in Slack or Teams
- [ ] Direct connectors (HubSpot, Google Ads), Postgres option

## License

Apache-2.0. All demo people, companies and numbers are fictitious. A project by **Aether Hive**, *Intelligence, by Design.*
