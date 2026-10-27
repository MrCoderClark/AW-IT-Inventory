# Device groups consumers — alerts + fleet OS install

**Date**: 2026-10-26  
**Status**: Accepted (implementing on `feat/device-groups-consumers`)  
**Parent**: [Device groups v1](./2026-10-26-device-groups-design.md)  
**Branch**: `feat/device-groups-consumers`

## Goal

Consume existing dynamic device groups outside Scripts:

1. **Spec 30** — optional `alert_rules.device_group_id`; evaluate only matching assets.
2. **Spec 31** — fleet **Install OS updates** can target a device group (resolve → tags → existing enqueue).

## Locked decisions

| Topic | Choice |
|---|---|
| Alert match | Membership **without** IP gate (metrics ≠ WinRM) |
| Patch match | `resolveDeviceGroup` **with** IP (same as scripts) |
| Null group on rule | Fleet-wide (unchanged default) |
| Fleet UX | Group dropdown + “Install for group…” (alongside checkbox multi-select) |
| Cap | Same `FLEET_OS_INSTALL_TAG_CAP` after resolve |
| Out of scope | Filter-only table mode, patch schedules by group |

## Shared helper

`matchDeviceGroupComputers(rules)` → `{ assetId, tag, ip }[]` before IP split.  
Alerts use asset ids; scripts/patches keep `splitByIp`.

## Acceptance

- [x] Alert rule with a group only fires for members of that group
- [x] Fleet Install for group enqueues OS installs for group hosts with IPs
- [x] Checkbox multi-select path unchanged
- [ ] `npm run db:push` for `alert_rules.device_group_id` (user runs)
