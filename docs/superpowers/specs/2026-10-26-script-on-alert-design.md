# Spec 32 — Script on alert (remediation)

**Date**: 2026-10-26  
**Status**: Accepted (implementing on `feat/script-on-alert`)  
**Parent**: [Spec 32 script library](../../specs/32-script-library/index.md) · [Spec 30 alert rules](../../specs/30-alert-rules/index.md)  
**Branch**: `feat/script-on-alert`

## Goal

When a Spec 30 metric alert rule **enters** a firing episode, optionally enqueue
one library script on the alerting computer via the existing Spec 32
`script_run_jobs` path.

## Locked decisions

| Topic | Choice |
|---|---|
| Trigger | **Fire only** (episode enter). Not recover / not hold. |
| Target | The **alerting asset** only |
| Config | Nullable `alert_rules.remediation_script_id` → `scripts.id` (null = off) |
| Job model | Existing `enqueueScriptRun` (freeze snapshot at enqueue) |
| Failure policy | Best-effort **after** successful in-app notify; never fail ingest or block `alertedState` |
| Skip reasons | No IP, archived/missing script, `already-inflight` → log/skip |
| Actor | `requestedBy = alert-rule:{ruleId}`; audit `source = scheduled` |
| Permission | Rules UI stays `user:admin`; auto-enqueue skips cookie `software:deploy` (same as schedules) |
| Out of scope | Device groups, parameters, run-on-recover, printer/compliance rules, new RBAC |

## Behavior

1. Admin sets optional **Run script on fire** on an alert rule (active scripts only).
2. On metric ingest, `evaluateMetricAlerts` fires as today (notify → email → state).
3. After a successful fire notification, if `remediationScriptId` is set:
   - Load script (skip if missing/archived).
   - Resolve Computer IP via `resolveDeployTarget(tag)` (skip if no IP).
   - `enqueueScriptRun` with frozen snapshot; `scheduled: true`.
4. Skips and enqueue errors are logged; they must not throw out of evaluation.

## Acceptance

- [x] Rule with remediation script fires → one `script_run_jobs` row (or skip).
- [x] No re-enqueue while the episode stays firing.
- [x] Notify + episode state unchanged if enqueue fails.
- [x] `/audit` shows `script_run` with operator `alert-rule:…` when enqueue succeeds.
- [x] Archived script rejected on save; FK set-null on script delete.

**Deploy:** from `web/`, run `npm run db:push` so `alert_rules.remediation_script_id` exists.

## Consequences

- Remediations are per-host and soft one-in-flight (existing script run guard).
- Device groups and alert→batch fan-out remain later work.
