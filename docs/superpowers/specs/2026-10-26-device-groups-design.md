# Device groups v1 — dynamic groups → scripts

**Date**: 2026-10-26  
**Status**: Shipped (merged #126)  
**Parent**: [Spec 32 script library](../../specs/32-script-library/index.md) · [Spec 28 RMM roadmap](../../specs/28-rmm-roadmap/index.md)  
**Branch**: `feat/device-groups`

## Goal

Named **dynamic** device groups: filter rules (location subtree, OS contains,
compliance at-risk/ok) recomputed on each resolve. First consumer: Spec 32
**Run on…** and script schedules via `ScriptTargetSpec` mode `group`.

## Locked decisions

| Topic | Choice |
|---|---|
| Membership | Dynamic only (no static member table) |
| Filters (AND) | Optional location subtree, OS contains (`machines.os_name`), compliance `any` \| `at-risk` \| `ok` |
| Compliance | Existing `scoreCompliance` + `isAtRisk` (hard security fails) |
| Empty rules | Reject save |
| Consumer v1 | Scripts only (`mode: "group"`) |
| Permission | `software:deploy` |
| Out of scope | Patches, alert scoping, static lists, nested groups |

## Data model

`device_groups`: `id`, `name` (unique lower), `description`, `rules` jsonb,
`created_by`, `updated_by`, timestamps.

```ts
type DeviceGroupRules = {
  locationId?: string | null;
  osContains?: string | null;
  compliance?: "any" | "at-risk" | "ok";
};
```

## Resolve

`resolveDeviceGroup` → Computers matching rules → `splitByIp`.
`resolveScriptTargets({ mode: "group", groupId })` loads the group and resolves.
Missing group → empty result.

## UI

- `/device-groups` — CRUD + member preview count/sample tags
- Scripts Run on… / schedules — Device group radio alongside computers/location

## Acceptance

- [x] Create group with location + OS + compliance
- [x] Run on… / schedule using group enqueues current IP matches
- [x] Membership changes after scans without editing the group
- [x] Tags/location targeting unchanged

**Deploy:** `cd web; npm run db:push`
