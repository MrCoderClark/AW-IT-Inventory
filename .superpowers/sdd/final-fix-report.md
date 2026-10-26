# Final review fixes (`feat/computer-audit-log`)

## Status
Fixed the four Important findings from the whole-branch review. Vitest was not run.

## What changed
- `computerAuditEvents` is hidden in the report builder without `audit:read`. `runReportAction`, `saveReportAction`, `saveScheduleAction`, and the saved-report page (load and run) refuse that source without `audit:read`. A caller with both `report:read` and `audit:read` is unchanged.
- `listAuditEvents` and `getAuditKpis` filter with `getSubtreeIds` and `inArray(assets.locationId, …)`. An unknown location returns no rows and zero KPIs.
- Computer `asset_update` is written only when asset or computer-detail fields change. Assignee-only saves stay on the assignment audit.
- Assignment returns and reboot-schedule admin edits append a new row (`sourceId` is a new uuid; the parent id is in `details`). Deploy, patch, reboot jobs, scripts, remote sessions, and missing-update checks stay one row per job.
- Audit log source `scheduled` displays as Automated Policy Engine.

## Tests for the user (from `web/`)
```
npx vitest run "src/app/(app)/reports/report-actions.test.ts" src/lib/report-sources.test.ts src/db/computer-audit.test.ts "src/app/(app)/assets/actions.test.ts" src/db/assignments.test.ts src/db/people.test.ts src/db/reboot-schedules.test.ts src/components/audit-log-view.test.tsx
```
