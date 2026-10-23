# Task 2 Report — Notify + API routes + cookie actions (Spec 31 v2)

**Branch:** `feat/spec-31-v2-scheduled-reboot`  
**Date:** 2026-10-22

## Delivered

| Area | Files |
|------|--------|
| Notifications | `notifyRebootResult` in `web/src/db/notifications.ts`; types `reboot` / `reboot-failed` in `data.ts`, `schema.ts`, `notification-ui.ts`, `tickets.ts` |
| Terminal notify hook | `updateRebootStatus` (succeeded/failed), `cancelRebootJob` (canceled) in `web/src/db/reboot.ts` |
| Service API | `POST /api/reboot/claim`, `POST /api/reboot/[id]/status` (`deploy:agent`) |
| Cookie actions | `requestRebootSchedule`, `requestCancelReboot` in `web/src/app/(app)/reboot-actions.ts` (`software:deploy`) |

## Tests

```powershell
cd web
npx vitest run src/db/reboot.test.ts src/db/notifications.test.ts src/app/api/reboot "src/app/(app)/reboot-actions.test.ts"
```

**Result:** 5 files, 49 tests passed.

## Notes / follow-ups

- Linked install auto-cancel (`syncLinkedRebootsForInstall`) does not emit notifications yet (bulk update); Task 3 may add if product wants it.
- User must run `npm run db:push` for notification type column (text union only — no migration required for new string values).
- Collector worker drain (Task 4) will consume the new claim/status routes.

## Commit

Message: `feat(spec 31): reboot claim/status API and schedule actions`

---

## Follow-up — reboot schedule action edge cases (2026-10-22)

Added four tests in `web/src/app/(app)/reboot-actions.test.ts`: past `scheduledAtIso` → `badrequest` (via enqueue `past-schedule`), invalid ISO → `badrequest`, `resolveDeployTarget` null → `badrequest`, enqueue `already-inflight` → `conflict`.

```powershell
cd web
npx vitest run "src/app/(app)/reboot-actions.test.ts"
```

**Result:** 1 file, 7 tests passed.

**Commit:** `test(spec 31): cover reboot schedule action edge cases`
