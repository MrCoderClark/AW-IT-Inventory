# Spec 34 v2a — Async Assist jobs + requester notifications

**Date**: 2026-10-20  
**Status**: Accepted (shipped on `main`) — [plan](./plan-v2a-async-assist.md)  
**Parent**: [index.md](./index.md)  
**Depends on**: Spec 34 v1 (merged), Spec 19 notifications

## Goal

Assist no longer holds an open HTTP request for the duration of the LLM call.
The technician can navigate anywhere in the app; when the job finishes they get
an immediate **toast** and a durable **bell** entry. The bell pulses only for
unread completions — never while a job is still queued/running.

## Locked decisions

| Topic | Choice |
|---|---|
| Slice | **A** — async Assist only (see parked follow-ons below) |
| Completion UX | Toast (immediacy) + Spec 19 bell (durability); flash/pulse when done |
| Notification audience | **Requester only** (no admin copy for Assist) |
| Bell visibility | **Any signed-in user**; ops broadcasts stay admin-filtered in the feed |
| Execution | **Same Next.js process** via `after()`; stuck-job reclaim on timeout |
| Approach | Extend `notifications` with audience; new `ai_assist_jobs` table |

## Parked Spec 34 follow-ons (not this slice)

- **B** — Fleet alert correlation  
- **C** — Recurring-issue / automation opportunity reports  
- **D** — On-prem provider profile + richer PII controls  
- **E** — Internal KB article hints (blocked until a KB exists)  
- ~~Retargeting collector worker jobs to requester notifications~~ →
  [v2b design](./design-v2b-requester-job-notifications.md) (slice F; scan-failed
  still out of scope)

## Architecture

```
POST /api/ai/assist
  → insert ai_assist_jobs (pending)
  → 202 { jobId }
  → after(() => processJob(jobId))

processJob
  → running → build pack → provider.complete → parse
  → succeeded|failed (store result/error)
  → ai_assist_events audit (hash)
  → createNotification(audience=user, recipient=actor)
  → SSE → toast + bell unread/pulse

GET /api/ai/assist/[jobId]
  → status + result (requester or admin)
```

No notification and no toast on enqueue.

## Data model

### `ai_assist_jobs` (new)

- `id` uuid PK  
- `actor_email` text not null  
- `asset_id` uuid null → assets (set null on delete)  
- `action` text not null  
- `script_run_job_id` uuid null (for `summarize_script_run`)  
- `user_prompt` text null  
- `status` text: `pending` | `running` | `succeeded` | `failed`  
- `result` jsonb null (AssistResult on success)  
- `error` text null (truncated)  
- `context_hash` text null  
- `provider` / `model` text null  
- `notification_id` uuid null → notifications  
- `created_at` / `started_at` / `finished_at` timestamptz  

Indexes: `(asset_id, created_at desc)`, `(status, started_at)` for reclaim.

### `notifications` (extend Spec 19)

- `audience` text not null default `'admins'`: `admins` | `user`  
- `recipient_email` text null — required when `audience = 'user'`  
- Types added: `ai-assist` | `ai-assist-failed`  

**Visibility filter** (list, unread, SSE fan-in to client):

```
(audience = 'admins' AND viewer has user:admin)
OR (audience = 'user' AND recipient_email = viewer.email)
```

Existing rows default to `admins` — behavior unchanged for ops alerts.

### `ai_assist_events`

Unchanged role: hash-only audit written when a job reaches a terminal state.

## API

| Surface | Behavior |
|---|---|
| `POST /api/ai/assist` | Same cookie auth + per-action perms as v1. Returns **202** `{ jobId }`. **503** if AI unconfigured (no job). |
| `GET /api/ai/assist/[jobId]` | Requester or `user:admin`. Returns status, result, error, timestamps. |
| Stuck reclaim | Mark `running` older than ~5–10 minutes as `failed` + notify requester (“Assist interrupted”). Opportunistic on enqueue and/or process start. |

## UI

### Assist panel (Monitoring → AI Assist)

- Action click → enqueue → brief “Queued…” then idle (no multi-minute spinner on the HTTP call).
- Prefer completing the in-view panel via SSE/toast-driven refresh (or light poll of `GET` while the tab is still open).
- Show a short **recent jobs** list for this asset (status + expand last result).
- Draft success still offers “Open in script editor” (sessionStorage handoff unchanged).
- Notification href → computer Monitoring → Assist, ideally highlighting that job.

### Bell + toast

- `NotificationBell` renders for **any** signed-in user (not only `user:admin`).
- On SSE `notification` event: show `toast.success` / `toast.error` from title/body; bump unread; **pulse** the bell while unread > 0 (or until that item is read).
- Non-admins never see `audience=admins` items in the panel or unread count.

## Errors

- Provider/parse failure → job `failed` + `ai-assist-failed` notification + toast.  
- Unconfigured → 503 on POST; Assist UI still hidden when noop.  
- `after()` lost on restart → reclaim → failed + notify.  
- Notification insert failure is best-effort (must not undo a succeeded job).

## Testing

- Audience filter unit tests (admin vs requester vs other user).  
- Job state machine + stuck reclaim.  
- POST → 202; GET authorization; completion creates user-targeted notification.  
- Bell visible for non-admin; Assist enqueue does not await provider in the request path.

## Out of scope

- Streaming tokens; storing full prompts/completions.  
- New RBAC permission.  
- Collector involvement / LLM keys on the worker.  
- Parked slices B–E and generalizing requester notifications to all worker jobs.

## Acceptance criteria (v2a)

- **AC-A1**: `POST /api/ai/assist` returns quickly with a `jobId`; LLM work runs after the response.  
- **AC-A2**: On success/failure, requester gets a Spec 19 notification (`audience=user`) and a live toast via SSE, regardless of current route.  
- **AC-A3**: No toast/bell entry while the job is pending/running.  
- **AC-A4**: Bell is available to any signed-in user; ops admin broadcasts remain admin-only in the feed.  
- **AC-A5**: Assist panel can show recent job results for the asset; deep-link from notification works.  
- **AC-A6**: Stuck `running` jobs are reclaimed to `failed` with requester notify.  
- **AC-A7**: Hash audit events still written on terminal state; secrets still redacted from packs.
