# 29. Metric monitoring & history — device telemetry over time

> First RMM-core spec after the [roadmap](../28-rmm-roadmap/index.md) (decision **A**,
> internal-IT RMM). It lays the **time-series foundation** that alerting (spec 30) and
> trend reporting build on.

## Summary

Compliance/health (spec 21) is **current-state only** — the last scan's BitLocker,
disk %, etc. There is no *history*: you can't see a device's CPU/RAM/disk trend, spot
a machine that's been pegged for an hour, or alert on "disk > 90% for 10 minutes."
This spec adds **lightweight, agentless telemetry sampled on a cadence** and stored as
a retention-pruned time series, surfaced as sparklines on the device, and consumed by
spec 30's alert engine.

Scope v1: **Computer** assets (CPU %, memory %, system-disk %, uptime) over WinRM —
the same round-trip family as the health collect, but cheaper and more frequent.
Printers already have reachability + page counters (specs 12/14); phones are later.

## Principles

- **Agentless, reuse the collector.** No new agent — the worker samples over WinRM on
  a schedule (like the reachability/computer sweeps). Cadence is minutes, not seconds;
  true real-time would need an agent (a deliberate non-goal — see Open questions).
- **Cheap, fixed-shape samples.** One small PowerShell call returns a handful of
  gauges; one wide row per sample. The fleet is ~hundreds of devices, so this stays
  well within the in-DB, no-rollup regime (rollups are a later scale step).
- **Retention-pruned.** Raw samples are kept a bounded window (default 30 days) and
  pruned daily, exactly like `printer_checks`/`printer_counters`.
- **Separate from the full scan.** A full scan is heavy (discovery + collect + ingest);
  metrics ride a **dedicated lightweight path** so they can run every few minutes
  without re-discovering or re-ingesting the whole machine.

## Requirements

- **AC-1**: The worker samples each **manually-entered / known Computer** at a
  configurable cadence (default every 15 min) over WinRM: **cpu %, memory %,
  system-disk %, uptime (seconds)** — best-effort, a sample failure never crashes the
  scheduler.
- **AC-2**: Samples are posted to a dedicated service endpoint and stored one **wide
  row per (asset, timestamp)** in a new `device_metrics` table; the device reconciles
  by the same identity path as the scan (serial / asset IP), never creating a duplicate.
- **AC-3**: A device whose sample couldn't be read records **nothing** for that tick
  (a gap), not a zero — gaps read as "no data," never as 0% load.
- **AC-4**: Raw samples older than the retention window are **pruned daily** (reuse the
  spec-12 prune job); the window is configurable.
- **AC-5**: The computer detail page shows **sparklines** (CPU/RAM/disk, last 24 h) +
  the latest value; empty state when a device has no samples yet.
- **AC-6**: Viewing is open to `asset:read`; posting uses the collector's existing
  service scope (`scan:dequeue` or a new `metrics:write` — see Decision). No user can
  post metrics.
- **AC-7**: Metrics are **read-only telemetry** — sampling never writes to a device.

## Decision

**A dedicated, lightweight metrics loop on the existing worker + one time-series
table.** Not folded into the full scan (too heavy for a minutes cadence), not a new
agent (agentless is the product's model). Concretely:

- **Collector:** a new `metrics` scheduled job in `worker.py` (`IntervalTrigger`,
  `metric_sample_interval_minutes`, 0 = off) that, for each known Computer target,
  runs a small `PS_METRICS` WinRM call and posts a batch. Reuses the credential
  profiles + `_run_ps_timeout` from the health collect.
- **Web:** `POST /api/ingest/metrics` (service-scoped) stores the batch; one
  `server-only` `src/db/metrics.ts` owns the table, the insert, the read helpers
  (`getDeviceMetrics(tag, window)` for sparklines), and the prune.
- **Scope of signals (v1):** cpu/mem/disk/uptime for Computers. The table is generic
  (`metric` columns) so adding a signal or a type later is additive.

**Service scope:** reuse **`scan:dequeue`** (the collector already holds it; no aw-auth
reseed) rather than minting `metrics:write`, unless we want metrics isolated from the
scan token later.

## Signals collected (how + what we store)

| Source (one WinRM call, `PS_METRICS`) | Field | Notes |
|---|---|---|
| `Get-CimInstance Win32_Processor` LoadPercentage (avg) | `cpu_pct` | 0–100 |
| `Win32_OperatingSystem` Free/Total visible memory | `mem_pct` | used % |
| `Win32_LogicalDisk` system drive used/size | `disk_pct` | system drive |
| `Win32_OperatingSystem` LastBootUpTime → now | `uptime_sec` | seconds |

All best-effort; an unreadable gauge is `null` (a gap, AC-3).

## Data model (web DB `aw_it_inventory_web`, Drizzle; one new table)

```
device_metrics
  id           uuid pk
  asset_id     uuid  → assets.id (cascade)   -- indexed
  sampled_at   timestamptz                    -- indexed (asset_id, sampled_at)
  cpu_pct      real | null
  mem_pct      real | null
  disk_pct     real | null
  uptime_sec   bigint | null
```

One row per sample. Index `(asset_id, sampled_at desc)` serves the sparkline read and
the prune. No rollup table in v1 (hundreds of devices × 15-min × 30 days is modest).

## API / ingest

- `POST /api/ingest/metrics` (service, `scan:dequeue`) — body `{ samples: [{ matchKey,
  sampled_at, cpu_pct, mem_pct, disk_pct, uptime_sec }] }`; reconcile each to an asset
  by the existing key, insert rows, skip unmatched. `runtime = nodejs` not needed.
- `GET` is internal (server components call `getDeviceMetrics` directly).
- The daily prune endpoint (spec 12 `/api/scan/reachability/prune`) also prunes
  `device_metrics` past the window.

## Collector

- `config.yaml`: `metric_sample_interval_minutes: 15` (0 = off), `metric_targets`
  source = the same Computers the computer-sweep uses.
- `collect_metrics.py` (new): `PS_METRICS` + `sample_metrics(config, token)` →
  POST batch. Reuses `creds.py` + `_run_ps_timeout`.
- `worker.py` `_build_scheduler`: a `metrics` `IntervalTrigger` job + the schedule
  summary line.

## UI

- **Computer detail**: a **Monitoring** card/tab — three sparklines (CPU/RAM/disk,
  24 h) with the latest value + a small "uptime" stat. Reuse the spec-26 chart
  primitives (`src/components/charts/*`) or a thin sparkline. Empty state until samples
  land.
- (Phase 2) a **fleet monitoring** view: top talkers (highest CPU/disk right now),
  reusing the compliance-fleet table pattern.

## Phases / build plan

1. **Collect + store + prune + device sparklines.** `collect_metrics` + the worker
   job; `device_metrics` + `src/db/metrics.ts` + the ingest route + the prune;
   Monitoring card on the computer detail. **AC-1–7.** *(Needs `db:push` + the worker
   config knob.)*
2. **Fleet monitoring view** + optional hourly rollups if raw-sample reads get heavy.
3. **Feeds spec 30** (alerting): the alert engine reads `device_metrics` for threshold
   + duration rules ("cpu_pct > 90 for ≥ 10 min").

## Consequences

- First time-series data in the app — pick the retention window deliberately; the
  prune must keep the table bounded.
- A new higher-frequency collector loop — keep `PS_METRICS` tiny (one call, short
  timeout) so a 15-min cadence over the fleet stays cheap.
- Agentless sampling can't go sub-minute; that's an accepted v1 limit.

## Open questions

- **Cadence vs. retention vs. storage:** 15 min × 30 days × N devices — confirm the
  window; if it grows, add hourly rollups (phase 2) rather than widening raw retention.
- **Agent later?** Richer/real-time monitoring (process lists, event-driven) may
  eventually justify a light agent. Out of scope for v1; revisit if the minutes cadence
  proves insufficient.
- **Printers/phones:** printers have reachability + counters already; do we want
  generic up/down + SNMP gauges in this same table later? (Additive — the table is
  type-agnostic.)
- **Service scope:** reuse `scan:dequeue` (no reseed) vs. a dedicated `metrics:write`.
