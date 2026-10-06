# 19. Notifications — rationale

Why the four forks landed where they did, and what was weighed against them.

## Where the store lives: web (`aw_it_inventory`), not aw-auth

The events are inventory events — a printer OPUS tracks going down, a scan OPUS
ran failing, a device OPUS discovered, a warranty OPUS holds the date for. The web
app already detects every one of them and owns the data they reference. Putting the
tables in aw-auth would mean shipping asset context across the service boundary and
teaching the identity provider about inventory concerns. aw-auth stays a portable,
general-purpose identity service (its whole selling point); notifications are an
OPUS concern, so they live with OPUS. The one thing aw-auth is still best at —
sending email to resolved admins via Resend — is left exactly as spec 12/14 built
it.

## Audience: admin-only broadcast + per-user read state

Three models were on the table:

1. **Broadcast to all asset viewers, per-user read.** Simplest, but these are
   operational IT-ops events (scan failures, discovery, warranty) that a read-only
   asset viewer has no action to take on. Showing them to everyone is noise.
2. **Admin-only broadcast, per-user read (chosen).** One row per event, visible to
   every `user:admin`, with a `notification_reads` table so each admin's read state
   is independent. No per-user fan-out of the events themselves — the row count
   tracks events, not events×admins. Correct for a handful of admins and trivial to
   query (unread = events with no read row for me).
3. **Per-user targeted rows + preferences.** Maximum flexibility (mute, per-type
   opt-out, non-admin targeting), but it multiplies rows by recipients and front-
   loads a preferences system for an audience of a few people. Deferred to future
   work; the chosen model is a clean subset to grow from.

The gate is the **existing** `user:admin` permission (already used to show
`/admin`), so there is no aw-auth reseed and no new permission to propagate.

## Realtime: Server-Sent Events over polling

Polling an unread-count endpoint every 30–60s would have been the least code and is
a legitimate on-prem choice. SSE was chosen for a genuinely live count with one
long-lived GET per open admin session instead of a steady drip of requests, and
without the bidirectional machinery (and connection bookkeeping) of websockets —
the feed is one-directional (server → bell), which is exactly SSE's shape. The cost
is a long-lived connection and an in-process pub/sub bus.

Two robustness details close the usual SSE gaps:
- **Re-sync on connect.** The client treats the stream as a *hint to refresh*, not
  the source of truth: on every (re)connect it pulls the count from REST, so a
  missed event while disconnected self-heals. `EventSource` reconnects on its own.
- **Heartbeat.** A `:` comment every ~25s keeps intermediaries from killing an idle
  connection.

The **in-process bus** is the one real constraint: it reaches only streams in the
same Node process. OPUS web runs as a single process on-prem (NSSM / `next start`),
where every creator (route handlers, server actions, the ingest API, the worker-
called sweep) and the SSE route share that process, so the bus reaches all open
bells. A multi-process web deployment would need a shared channel
(Postgres `LISTEN/NOTIFY` or Redis pub/sub) — called out as future work rather than
built speculatively.

## Email scope: unchanged (printer alerts only)

The spec 12 down/recovery emails and the spec 14 counter report are the only emails,
and they stay exactly as they are. Adding email for scan failures and warranty would
mean new aw-auth notify endpoints and more Resend wiring for events whose natural
home is the in-app feed an admin is already watching. v1 keeps the blast radius
small: the in-app center is the new surface; the proven email path is left alone.

## Idempotency as a first-class key, not a flag

Every creation path can re-fire — a re-scan re-discovers the same device, the daily
sweep re-evaluates the same warranty, a flapping printer re-enters the same episode.
Rather than each call site reasoning about "have I already notified?", a single
`dedupeKey` with a unique index makes `createNotification` idempotent by
construction (`onConflictDoNothing`), mirroring the "one email per episode" rule
spec 12 already enforces via `lastAlertState`. The key encodes the episode/date so a
*new* episode or a *changed* warranty date legitimately produces a fresh item.
