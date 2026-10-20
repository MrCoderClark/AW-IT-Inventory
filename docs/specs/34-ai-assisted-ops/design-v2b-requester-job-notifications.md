# Spec 34 v2b — Requester notifications for worker jobs

**Date**: 2026-10-20  
**Status**: Accepted (shipped on `main`) — [plan](./plan-v2b-requester-job-notifications.md)  
**Parent**: [index.md](./index.md)  
**Depends on**: Spec 34 v2a (audience + SSE toast), Spec 19 notifications  
**Slice**: **F** from the v2a parked list (generalize requester notify beyond Assist)

## Goal

Script run, patch install, software deploy, and printer install already raise
in-app notifications on terminal status — but they use the default
**`audience=admins`** broadcast. After Assist v2a, technicians expect the same
**requester-only** toast + bell for work they kicked off.

Retarget those four helpers so a human requester is the only recipient. Keep
copy, types, deep links, dedupe keys, and success+fail timing unchanged. No
schema migration.

## Locked decisions

| Topic | Choice |
|---|---|
| Audience | **Requester only** when `requestedBy` looks like an email |
| Non-email `requestedBy` | Fall back to **`admins`** (e.g. `schedule:<id>`) |
| Job types | Script run, patch install, software deploy, printer install |
| Scan failed | Out of scope (stays admin-only) |
| Approach | Shared `resolveJobNotificationAudience(requestedBy)` + pass `requestedBy` into existing `notify*` helpers |
| UI / SSE | Unchanged — Spec 19 already filters by audience |
| New notification types | None |
| Email delivery | Unchanged (in-app only for these helpers) |

## Audience policy

```
resolveJobNotificationAudience(requestedBy: string)
  trimmed = requestedBy.trim()
  if trimmed includes "@" and is non-empty:
    → { audience: "user", recipientEmail: trimmed }
  else:
    → { audience: "admins", recipientEmail: null }
```

Heuristic is intentionally simple: every human enqueue today stores an email in
`requestedBy`; scheduled script materialization stores `schedule:<uuid>`. No DB
lookup of schedule `createdBy` in this slice.

## Architecture

```
status updater (script / patch / deploy / printer)
  → terminal succeeded|failed
  → returning includes requestedBy
  → notify*(…, requestedBy)
       → resolveJobNotificationAudience(requestedBy)
       → createNotification({ …existing fields, audience, recipientEmail })
       → SSE → toast + bell (viewer filter already shipped)
```

Assist (`notifyAiAssistResult`) stays as-is; it already sets `audience=user`.

## Code touch points

| Area | Change |
|---|---|
| `web/src/db/notifications.ts` | Add `resolveJobNotificationAudience`; thread `requestedBy` through `notifyScriptRunResult`, `notifyPatchInstallResult`, `notifyDeployResult`, `notifyInstallResult` |
| `web/src/db/script-runs.ts` | Return `requestedBy` from status update; pass to notify |
| `web/src/db/patch-install.ts` | Same |
| `web/src/db/software-deploy.ts` | Same |
| `web/src/db/printer-install.ts` | Same |
| Tests | Resolver unit tests; each `notify*` asserts audience args; status-updater mocks receive `requestedBy` |
| Spec index | Move slice F out of “parked” once shipped |

No collector, aw-auth, or schema changes. No `db:push`.

## Error handling

- `createNotification` remains best-effort (never fails the status update).
- If `audience=user` were ever passed without email, existing guard logs and
  skips insert — the resolver must not produce that case.
- Idempotency: existing `dedupeKey` per job+status unchanged.

## Out of scope

- `scan-failed` retargeting  
- Notifying schedule `createdBy` instead of admin fallback  
- Dual-write (requester + admin copy)  
- Fleet correlation / reports / on-prem AI / KB (slices B–E)  
- Changing toast copy or deep-link targets  

## Acceptance criteria (v2b)

- **AC-F1**: Manual script / patch / deploy / printer job requested by email X →
  notification has `audience=user`, `recipientEmail=X`; only X sees toast/bell.  
- **AC-F2**: Job with `requestedBy` like `schedule:…` → notification stays
  `audience=admins` (all admins see it; non-admins do not).  
- **AC-F3**: Types, titles/bodies, hrefs, and dedupe keys for the four helpers
  are unchanged aside from audience fields.  
- **AC-F4**: Terminal success and failure both still notify (same as today).  
- **AC-F5**: Unit tests cover the resolver and audience args on all four helpers.

## Manual verify

1. Non-admin tech runs a script on a computer → only that tech gets toast/bell.  
2. Another admin does **not** see that completion in their feed.  
3. A schedule-fired script run still appears for admins.
