# 30. Alert rules engine — threshold alerts on device metrics

> Second RMM-core spec after the [roadmap](../28-rmm-roadmap/index.md) (decision **A**).
> It consumes [spec 29](../29-metric-monitoring/index.md) metric history and fires
> through the existing [spec 19](../19-notifications/index.md) bell + aw-auth email
> path. Printer reachability (spec 12) and compliance (spec 21) alerts stay as they
> are in v1; folding them into this engine is phase 2.

## Summary

Spec 29 stores CPU / RAM / disk / uptime samples. Nothing *watches* them. An admin
still has to open a computer's Monitoring card to notice a disk that's been at 97%
all morning. This spec adds **configurable threshold rules**: a signal, a condition,
an optional duration (consecutive samples), a severity, and the existing admin
notify path. When a rule starts firing for a device, one in-app notification (and
one email) go out; when it recovers, one recovery; nothing in between.

Scope v1: **Computer metric gauges** (`cpu_pct`, `mem_pct`, `disk_pct`,
`uptime_sec`) against the `device_metrics` table. Evaluation runs in **web at metric
ingest** — no new collector loop, no new service scope.

## Principles

- **Rules, not one-off ifs.** One evaluator, one state machine, many rows. Adding
  "disk > 90%" is data, not a new code path.
- **Reuse notify.** In-app = spec 19 (`createNotification` + SSE). Email = aw-auth
  `notify:send` (same `h2tecs-web` account as printer / compliance). Recipients in v1
  are **all `user:admin`**, not a per-rule picker.
- **Same episode machine as printer/compliance.** Fire on enter, recover on exit,
  advance `alertedState` **only after a successful in-app write**. Email is
  best-effort and never gates the episode. No spam while it stays firing.
- **Gaps are not zeros.** A missing / null gauge for a tick neither trips the rule
  nor counts as recovery (spec 29 AC-3). Consecutive-breach counters stay put.
- **Don't rewrite working alerts.** Printer down and compliance at-risk keep their
  own evaluators. This spec is the *new* thing (metric thresholds) plus the engine
  those two can join later.

## Requirements

- **AC-1**: An admin (`user:admin`) can create, edit, enable/disable, and delete
  **alert rules**. A rule is: name, signal (`cpu_pct` | `mem_pct` | `disk_pct` |
  `uptime_sec`), operator (`gt` | `gte` | `lt` | `lte`), threshold (number),
  consecutive samples (integer ≥ 1, default 1), severity (`info` | `warning` |
  `critical`), enabled flag. Viewing and mutating rules is `user:admin` only;
  `asset:read` users never see the rules UI.
- **AC-2**: After each successful `POST /api/ingest/metrics` batch, web evaluates
  every **enabled** rule against the assets in that batch. Evaluation is
  **best-effort** and never fails the ingest (same contract as
  `evaluateComplianceAlert`).
- **AC-3**: A rule **fires** for an asset when the last *N* readable samples (N =
  `consecutive`) all satisfy the condition. It **recovers** when the latest
  readable sample does not. Null / missing samples are skipped (AC-4). One firing
  notification per episode, one recovery, no extras while it stays firing.
- **AC-4**: A tick with a **null** gauge for that signal does not increment the
  consecutive-breach counter and does not reset it. The episode stays in whatever
  state it was.
- **AC-5**: Firing and recovery each create a spec-19 notification
  (`metric-threshold` / `metric-recovered`), deep-linked to the computer's
  Monitoring card, with the rule name, current value, and threshold in the body.
  Severity on the firing notification is the rule's severity; recovery is `info`.
- **AC-6**: Firing and recovery each **attempt** an aw-auth email to the admins
  (`notify:send`). A failed email is logged and does **not** roll back the in-app
  notification or the episode state (in-app is the durable record, matching
  spec 21 v2).
- **AC-7**: Three **default rules** are seeded (enabled): CPU ≥ 90% for 2 samples,
  memory ≥ 90% for 2 samples, disk ≥ 90% for 1 sample. Admins can disable or edit
  them. Consecutive = 2 at a 15-minute cadence is ~30 minutes; disk fires on the
  first hot sample because a full disk stays full.
- **AC-8**: Duration is **consecutive samples, not wall-clock minutes.** The UI
  shows an approximate duration (`N × metric_sample_interval_minutes`) so "for 10
  minutes" at a 15-minute cadence is honestly "1 sample (~15 min)". No sub-cadence
  alerting — that's spec 29's agentless limit.

## Decision

**Evaluate in web on metric ingest, store rules + per-(rule, asset) episode state
in the inventory DB.** Not a collector-side rules file (web owns inventory identity
and notify). Not a new worker job (samples already arrive on a cadence). Concretely:

- **`alert_rules`** — the configurable rows (AC-1, AC-7).
- **`alert_rule_states`** — `(ruleId, assetId) → { consecutive, alertedState }`,
  the episode machine (AC-3). `alertedState` is `ok` | `firing` | null, advanced
  only after the in-app notification write succeeds.
- **Pure evaluator** `evaluateMetricRule(samples, rule) → 'firing' | 'ok' | 'skip'`
  in `web/src/lib/alert-rules.ts` (testable without DB). `skip` = no readable
  sample this tick.
- **Hook:** `evaluateMetricAlerts(assetIds)` from the ingest route after
  `recordMetrics`, mirroring `evaluateComplianceAlert` after posture upsert.
- **UI:** `/admin/alert-rules` (card on `/admin` + its own page), `user:admin`.
- **Email:** new aw-auth `POST /v1/notify/alert-rule` (same `notify:send` + admin
  resolution as compliance). Web `sendAlertRuleEmail()` in `notify.ts`.

**Not in v1:** per-rule recipient lists, location/asset scoping, folding
printer/compliance into this table, a fleet "what's firing" dashboard (the bell
is that list), webhook destinations.

## Default rules (AC-7)

| Name | Signal | Op | Threshold | Consecutive | Severity |
|---|---|---|---:|---:|---|
| CPU high | `cpu_pct` | `gte` | 90 | 2 | warning |
| Memory high | `mem_pct` | `gte` | 90 | 2 | warning |
| Disk almost full | `disk_pct` | `gte` | 90 | 1 | critical |

Seeded once (insert-if-empty or a stable id); subsequent deploys must not
re-enable a rule an admin turned off.

## Data model (web DB `aw_it_inventory_web`, Drizzle)

```
alert_rules
  id             uuid pk
  name           text not null
  signal         text not null   -- cpu_pct | mem_pct | disk_pct | uptime_sec
  op             text not null   -- gt | gte | lt | lte
  threshold      real not null
  consecutive    int  not null default 1   -- ≥ 1
  severity       text not null   -- info | warning | critical
  enabled        bool not null default true
  ticket_auto_create text not null default 'inherit'  -- inherit | on | off (Spec 33 v2)
  created_at     timestamptz
  updated_at     timestamptz

alert_rule_states
  rule_id        uuid → alert_rules.id (cascade)
  asset_id       uuid → assets.id (cascade)
  consecutive    int  not null default 0   -- current streak of breaching samples
  alerted_state  text                     -- ok | firing | null
  updated_at     timestamptz
  primary key (rule_id, asset_id)
```

Notification types (additive on the existing text union, spec 19):
`metric-threshold`, `metric-recovered`. `dedupeKey` is **not** the episode lock —
the state row is. Keys can be `metric-threshold:<ruleId>:<assetId>:<firedAtIso>`
so a later episode of the same rule is a new notification.

## Evaluation (AC-2, AC-3, AC-4)

On each ingest batch, for each `(enabled rule, asset in batch)`:

1. Read the latest `consecutive` samples for that asset+signal (nulls dropped from
   the window; if fewer than 1 readable sample this tick → **skip**, leave state).
2. Latest readable sample matches the predicate? If yes, `state.consecutive += 1`,
   else `state.consecutive = 0`.
3. Desired episode: `consecutive >= rule.consecutive` → `firing`, else `ok`.
4. Compare to `alertedState` (null counts as `ok`):
   - `ok → firing`: write notification + attempt email; on in-app success set
     `alertedState = firing`.
   - `firing → ok`: write recovery notification + attempt email; on in-app success
     set `alertedState = ok`.
   - otherwise: persist the streak only.

A disabled or deleted rule leaves stale state rows; they are ignored at evaluate
and cascade-deleted with the rule.

## API

No public ingest API — evaluation is a side effect of `POST /api/ingest/metrics`.

Admin mutations are **Server Actions** on `/admin/alert-rules` (`user:admin`),
same pattern as discovery toggles / tracked software. No new RBAC permission.

## UI

- **`/admin`**: an "Alert rules" card with a Manage button (next to Users & roles).
- **`/admin/alert-rules`**: table of rules (name, signal, condition as readable
  text e.g. `CPU ≥ 90% for 2 samples (~30 min)`, severity, enabled switch,
  **Ticket auto-create** Inherit / On / Off) + New / Edit dialog. Empty copy
  explains they watch spec-29 samples. Per-rule override resolves against the
  global Spec 33 notification-type matrix when set to Inherit.
- **Bell / `/notifications`**: new types in the existing type filter.
- **Computer Monitoring card**: no extra chrome in v1 (the notification deep-link
  is enough). Optional "N rules firing" chip is phase 2.

## Collector

**No collector changes.** Cadence stays `metric_sample_interval_minutes`. The UI
may read that value from nowhere in v1 and assume 15 when rendering "~30 min";
hard-coding 15 in the copy is acceptable (the worker default). A later polish can
surface the configured cadence.

## Phases / build plan

1. **Engine + ingest hook + in-app notify + default rules.** Schema, pure
   evaluator tests, `evaluateMetricAlerts`, notification types, seed defaults.
   **AC-2–5, AC-7, AC-8.** *(Needs `db:push`.)* No UI yet — verify via tests + a
   posted sample batch.
2. **Admin UI** — `/admin/alert-rules` CRUD + enable switch. **AC-1.**
3. **Email** — aw-auth `v1/notify/alert-rule` + `sendAlertRuleEmail`. **AC-6.**
4. **Later:** fold printer/compliance into `alert_rules` as built-in rows;
   location/asset scope; fleet "firing now" view; per-rule recipients.

## Consequences

- Alert latency is the metric cadence (default 15 min), not seconds. That's
  inherited from spec 29 and is an accepted v1 limit (AC-8).
- Three extra tables/rows of state per (rule × computer) — fine at hundreds of
  devices × a handful of rules.
- aw-auth gains one more notify template (phase 3); phase 1 is useful without it.

## Open questions

- **Cooldown after recovery?** v1 re-fires on the next N-sample breach with no
  extra quiet period. Add a cooldown column later if flapping shows up.
- **Uptime rules:** `uptime_sec lt 600` ("just rebooted") is allowed by the
  model but not seeded. Keep it as a signal admins can use.
- **Phase 2 migration of printer/compliance:** treat them as system rules
  (`readonly` flag, not deletable) rather than deleting the old evaluators
  until the engine has run in production.

## Related

- [28](../28-rmm-roadmap/index.md) roadmap · [29](../29-metric-monitoring/index.md)
  metrics · [19](../19-notifications/index.md) bell · [21](../21-compliance/index.md)
  compliance alerts · [12](../12-scheduled-manual-scans/index.md) printer alerts
