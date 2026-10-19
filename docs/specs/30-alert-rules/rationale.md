# 30. Alert rules — rationale

## Why not fold printer + compliance into v1?

Those evaluators already have tests, episode state, and email. Rewriting them onto
a generic rule row is the right *destination* (roadmap: "generalizes the
spec-21/spec-12 one-off alerts") but it is not what unblocks "disk has been at 97%
for half an hour." v1 ships the missing capability (metric thresholds) on a
generic engine those two can join as built-in rules later, without a risky
cutover of alerts that already page admins.

## Why consecutive samples instead of wall-clock duration?

Spec 29 samples every 15 minutes (configurable). "CPU > 90% for 10 minutes" cannot
be observed more finely than one sample. Expressing duration as consecutive
readable samples is honest; the UI approximates minutes as `N × cadence`. A future
agent could add a minutes column; the evaluator stays the same shape.

## Why evaluate in web on ingest, not a collector job?

Identity, rules, and notify all live in web. The collector already POSTs a metrics
batch; running the engine as a side effect of that write (like compliance at
ingest) avoids a second poll loop and a new service endpoint. A failed evaluation
must never fail the ingest.

## Why no new RBAC permission / no per-rule recipients?

The existing admin-only broadcast (spec 19) is the right size for a single-org
on-prem team. `user:admin` already gates the bell and `/admin`. A recipient picker
and a new `alert:write` perm are MSP-shaped (fork B) and can wait.

## Why email is phase 3

In-app + SSE is the durable, already-built path. Email needs an aw-auth template
and is best-effort anyway (spec 21 v2). Phase 1 is testable and useful without
touching Django.
