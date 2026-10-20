# 34. AI-assisted IT operations — optional technician assist

> Optional AI layer for H2Tecs (roadmap decision **A**, single-org on-prem).
> Builds on inventory, metrics ([29](../29-metric-monitoring/index.md)), alerts
> ([30](../30-alert-rules/index.md)), patches ([31](../31-patch-management/index.md)),
> and scripts ([32](../32-script-library/index.md)). Ticketing remains
> [33](../28-rmm-roadmap/index.md) (not yet specified).

**Date**: 2026-10-20  
**Status**: Accepted (v1 + v2a shipped on `main` — [design](./design-v2-async-assist.md), [plan](./plan-v2a-async-assist.md); polish PR #106)

## Summary

H2Tecs gains an **optional AI assist** for technicians: summarize device health
and recent failures, explain likely causes, recommend troubleshooting steps,
**draft** PowerShell for human review, and summarize script run output. The app
stays fully useful when no AI provider is configured (Assist UI hidden).

AI never executes privileged actions. Draft scripts enter the existing library /
Run flow ([spec 32](../32-script-library/index.md)); a technician must explicitly
Save and Run. Credentials, tokens, and unnecessary PII are never sent to providers.

**v1 provider posture:** pluggable adapters; first concrete adapter is an
**OpenAI-compatible HTTP API** aimed at **free-tier cloud** hosts (e.g. Groq /
OpenRouter free models). Private/on-prem endpoints use the same adapter later.

## Principles

- **Modular / optional.** No API key → no Assist entry points; zero runtime errors
  on core RMM paths.
- **Facts ≠ hypotheses.** Responses are structured: **Observed** (from our DB),
  **Hypotheses**, **Suggested next steps**. The model must not present guesses as
  inventory facts.
- **Human approval for power.** No AI-triggered WinRM, deploy, patch install,
  reboot, or config change. Draft script ≠ run.
- **Minimize egress.** Server-side gateway only. Redacted **context packs**; no
  secrets, cookies, service tokens, or full credential profiles.
- **Reuse gates.** Summaries: `asset:read`. Saving/running drafts: `software:deploy`
  (same as scripts today). No new RBAC permission in v1.

## Requirements

**User stories**:
- As a tech, I want a plain-language summary of a computer’s health and recent
  failures without digging through tabs.
- As a tech, I want a **draft** remediation script I can edit, then run only if I
  choose (spec 32).
- As a security owner, I want AI off by default / when unconfigured, and no
  secrets leaving the building in prompts.

### Acceptance criteria (v1)

- **AC-1**: Pluggable `AiProvider` in **web** (`complete` / structured JSON).
  Implementations: `noop` (default when unset), `openai_compatible` (base URL +
  API key + model from env). Collector is not involved.
- **AC-2**: When provider is `noop` / unconfigured, Assist UI is **not rendered**;
  assist API returns **503** with a clear “AI not configured” code. Core pages
  unchanged.
- **AC-3**: Context pack builder (server-only) for a Computer: tag, name, type,
  location path, IP present/absent (not credential material), compliance
  posture summary, recent metric gauges, recent alert episodes, recent
  script/patch/deploy job outcomes (status + truncated output tails). Strip
  known secret patterns; cap pack size.
- **AC-4**: Assist actions (cookie auth):
  - `summarize_health` — `asset:read`
  - `explain_failures` — `asset:read`
  - `summarize_script_run` (job id) — `asset:read` on that asset
  - `draft_script` — `software:deploy` (returns draft body + name suggestion;
    does **not** insert into `scripts` until the user Saves)
- **AC-5**: Model response schema includes `observed[]`, `hypotheses[]`,
  `recommendations[]`, and for drafts `scriptDraft: { name?, body, notes? }`.
  UI renders sections separately (hypotheses visually distinct from observed).
- **AC-6**: Draft → opens script editor (or equivalent) prefilled; **Save** uses
  existing script CRUD; **Run** uses existing enqueue (soft in-flight, snapshot).
  No auto-enqueue from the assist response.
- **AC-7**: Audit: `ai_assist_events` (or equivalent) stores actor, asset id,
  action, provider/model id, created_at, and a **hash** of the redacted pack
  (not the raw pack / not API keys). Retention capped (e.g. 90 days) or prune job.
- **AC-8**: No credentials, refresh/access tokens, WinRM passwords, or package
  bytes in any provider payload. Assignee email / employee id omitted in v1 packs.
- **AC-9**: v1 does **not** correlate fleet-wide alerts, search an external KB,
  mine recurring issues across the org, or call any privileged mutator.

## Data model

```
ai_assist_events
  id uuid pk
  actor_email text not null
  asset_id uuid null → assets (set null on delete)
  action text not null  -- summarize_health | explain_failures | …
  provider text not null
  model text not null
  context_hash text not null  -- sha256 of redacted pack
  ok boolean not null
  error text null
  created_at timestamptz not null
```

No store of full prompts/completions in v1 (privacy + size). Optional later
under admin opt-in.

## Config (web `.env`, gitignored)

```
AI_PROVIDER=noop | openai_compatible
AI_BASE_URL=           # e.g. https://api.groq.com/openai/v1
AI_API_KEY=
AI_MODEL=              # free-tier model id
AI_TIMEOUT_MS=60000
```

`*.example` documents keys; empty/noop = AI off.

## API / surfaces

| Surface | Auth |
|---|---|
| `POST /api/ai/assist` (action + assetId / jobId + optional user prompt) | cookie; per-action perms (AC-4) |
| Computer detail **Assist** panel | `asset:read`; draft button needs `software:deploy` |
| Script editor prefill from draft | `software:deploy` |

Service accounts: **no** AI scopes in v1 (techs only).

## UI

- Computer detail **Monitoring** tab: Metrics | **AI Assist** sub-tabs (Assist
  hidden when AI is off) with action buttons + structured result view
  (Observed / Hypotheses / Recommendations).
- Draft script: primary CTA “Open in script editor” → existing New/Edit dialog
  with body filled; user must Save before it appears in the library.
- Global: if AI off, no nav noise (no dead “AI” menu).

## Phases

1. **v1 (this spec)** — AC-1–9: gateway, context pack, computer Assist,
   draft script handoff to spec 32, audit hash, free cloud OpenAI-compatible
   provider.
2. **v2a** — [async Assist jobs](./design-v2-async-assist.md) ([plan](./plan-v2a-async-assist.md)):
   shipped: enqueue + `after()` processing, requester toast + bell on completion,
   Spec 19 audience targeting, recent job history on the Assist panel.
3. **v2b** — [requester notifications for worker jobs](./design-v2b-requester-job-notifications.md)
   ([plan](./plan-v2b-requester-job-notifications.md)): shipped — script / patch /
   deploy / printer-install completion bells target the requester; schedule/system
   `requestedBy` stays admin broadcast.
4. **v2+ (parked)** — fleet alert correlation; recurring-issue / automation
   reports; on-prem provider profile + richer PII; internal KB article hints
   (when a KB exists).
5. **Later** — ticket draft assist (after [spec 33](../33-ticketing/index.md) v1);
   streaming UI; admin prompt retention opt-in.

## Out of scope / non-goals (v1)

- Autonomous remediation or “AI agent” that runs tools without a click.
- Further AI slices beyond v1 + v2a (see Phases).
- Sending full disk images, memory dumps, or entire event logs.
- Training on customer data.
- Replacing monitoring/alerting (29/30) with LLM polling.

## Related

- [28](../28-rmm-roadmap/index.md) · [29](../29-metric-monitoring/index.md) ·
  [30](../30-alert-rules/index.md) · [31](../31-patch-management/index.md) ·
  [32](../32-script-library/index.md) · [19](../19-notifications/index.md)
