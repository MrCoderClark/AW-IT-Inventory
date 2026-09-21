# 13. Discovery type toggles, rationale

The decision record for [index.md](index.md): the problem, the options weighed,
and why. `/develop` builds from `index.md` and skips this file.

## Context

The collector sweeps the configured subnets, classifies each reachable host as
windows (a computer), a printer, or unknown, then collects computers over WinRM
and printers over SNMP and posts them to the ingest API, where unmatched devices
land in the discovered devices inbox (spec 06). Today that sweep is all or
nothing per run: the only controls are the per run `--no-windows` and
`--no-printers` flags on the `scan` command, set by whoever runs it on the
collector host.

Admins want to stop the collector automatically finding and adding a whole device
type (for example printers) without editing files on a server, and they want the
control to live in the app where they already manage the fleet. The control has to
reach the collector, which is outbound only (it calls the web app, nothing calls
into it), so the collector must pull the setting rather than be pushed to.

Two related behaviors must stay correct while adding this. First, a manual scan an
admin explicitly starts (Scan now, Scan selected, Scan all) must still run even
when that type is switched off, because an explicit action should never be blocked
by a global default. Second, spec 12 adds scheduled printer reachability checks;
the admins asked that turning printers off also pause those, so one printer switch
governs all automatic printer activity.

Not deciding this leaves discovery all or nothing and host local, so an admin
cannot say "manage computers automatically, but not printers" from the app.

## Options considered

### Option 1: Web persisted settings the collector pulls before each run

Store the switches in the web database, edit them from the Admin page, expose a
small read endpoint, and have the collector fetch the switches before each
automatic sweep, caching the last good result. The switches map onto the existing
`no_windows` / `no_printers` levers.

**Pros**:
- Controlled from the app, shared by all admins, no host access needed.
- Reuses the collector's existing outbound token path and its existing per type
  collection levers, so the change is small.
- Caching plus fail open keeps a settings outage from stopping scanning.

**Cons**:
- Adds a web read the collector depends on before each sweep (mitigated by the
  cache).
- The cache can be briefly stale during a web outage.

### Option 2: Collector config file only

Add a `discover_types` list to `config.yaml` that the `scan` command and worker
honor. No web UI, no database, no endpoint.

**Pros**:
- Simplest to build: one config field and a filter, entirely inside the collector.
- No new web surface, no new endpoint, no auth to reason about.

**Cons**:
- Not controllable from the app, which is exactly what the admins asked for.
- Per host and file based: editing means server access, and two collector hosts
  can drift out of sync.

### Option 3: Environment variable or feature flag on the collector

Gate each type behind an environment variable (for example
`DISCOVER_PRINTERS=false`) read at startup.

**Pros**:
- Trivial to implement and familiar.

**Cons**:
- Changing a switch means restarting the collector, not a UI click.
- Still host local and invisible to admins, with the same drift problem as Option
  2, and worse ergonomics (a restart per change).

## Rationale

The load bearing force is where the control lives: the admins explicitly want it
in the app, shared and editable without touching the collector host, which rules
out Options 2 and 3 (both are host local and file or env based). Option 1 puts the
setting where the admins work and lets the outbound only collector pull it, which
fits the system's existing shape (the collector already pulls work and pushes
results in spec 12).

The main risk of Option 1 is depending on a web read before every sweep. Caching
the last good settings on the collector, then failing open to all on when nothing
was ever cached, keeps a web outage from silently stopping discovery, which for a
monitoring tool is the failure that matters. We accept a briefly stale cache
during an outage as the cost of that resilience.

The switches reuse the collector's existing `no_windows` / `no_printers` levers
rather than adding a new filtering path, so off means "not collected" at the point
the collector already decides what to collect. Manual queue jobs deliberately do
not read the switches, because an explicit admin action must never be blocked by a
global default. The database shape mirrors the existing `table_column_config`
table (one row per key, absent row means the default), so the pattern is already
familiar in this codebase and the default state needs no seed.
