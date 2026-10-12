# 24. Remote Actions — rationale

Context and the options weighed for [index.md](index.md).

## The hard constraint

OPUS's architecture rule is **the web app never connects into the fleet; the
collector pulls work and pushes results** (spec 01; realized in spec 12 scan jobs,
spec 18 cut-out, spec 20 printer install). A live terminal wants a low-latency
bidirectional stream into a target, which naively wants the web app to hold a
socket into the fleet. Everything below is about getting a live terminal **without
breaking that rule** — the collector must initiate every connection.

## Option: transport (how browser ↔ web ↔ collector stream)

- **A. SSE (browser output) + POST (browser input) + collector long-poll/POST
  (chosen).** All ordinary Next.js route handlers; no new server. The collector
  dials out (long-poll for input, POST for output), preserving outbound-only. SSE
  gives real server-push to the browser with built-in reconnect/`Last-Event-ID`
  resume. Cost: long-poll adds ~poll-interval latency and holds connections open —
  acceptable because PSRP is command-level (see PTY option) and this is self-hosted
  Node (long-lived connections are fine), not serverless.
- **B. WebSocket relay.** One duplex socket per hop — lowest latency, cleanest
  duplex. But Next.js App Router route handlers don't do WS upgrades; it needs a
  custom server or a separate WS process — **new infrastructure** for the whole
  app. Deferred to Follow-up: adopt if/when OPUS gains a WS layer, or if long-poll
  latency proves inadequate.
- **C. A dedicated bastion/relay service** (its own process holding the sockets).
  Most operationally robust for heavy use, but the biggest surface to build and
  run. Overkill for v1; noted in Follow-up.

Chosen **A** because it delivers a responsive streaming terminal with **zero new
infrastructure** and keeps the exact outbound-only posture every other collector
feature uses.

## Option: one append-only event log vs separate queues

Using a single `remote_session_events` append-only log (monotonic `seq`) as the
relay buffer **and** the audit trail **and** the resume cursor means: the SSE
reader and the collector input long-poll are both just "events after my cursor",
reconnects resume by `seq` with no gaps/dupes, and the full transcript falls out
for free (AC-7). The alternative — a transient in-memory/queue relay plus a
separate audit write — is faster but loses durability across a web restart, makes
resume bespoke, and double-writes. The log's cost (a row per chunk) is bounded by
output caps + the retention prune, and matches the "history is the source of
truth" pattern used for reachability/counters.

## Option: PTY vs command-streaming REPL (WinRM vs OpenSSH)

The user asked for an **interactive streaming shell**. Over **WinRM/PSRP** you get
a persistent runspace where you submit a command line and its output streams back
live — a **streaming REPL**, not a raw TTY. Full-screen/TTY programs (remote `vim`,
arrow-key line editing, TTY-gated pagers) need a **conpty/PTY**, which on Windows
means **OpenSSH**, not WinRM.

- **Chosen: PSRP streaming REPL over the existing WinRM channel.** Zero new access
  path — it reuses the exact credentials and channel the collector already uses to
  scan these hosts (no new trust boundary), and covers the real admin use cases
  (services, scripts, diagnostics, log gathering) with live output.
- **Deferred: OpenSSH PTY.** A true terminal, but it requires OpenSSH enabled and a
  separate credential/trust path on every target, and a different relay (raw byte
  stream, not PSRP output objects). Added as a per-target Follow-up transport once
  the session machinery exists.

This limit is called out at the top of the spec so it is a conscious choice, not a
surprise.

## Option: permission model

Remote shell is **arbitrary RCE**, strictly more powerful than spec 20's
catalog-only printer install. So it gets its **own** permission, **`remote:shell`**,
seeded to **`Owner` only** (Admin is a documented opt-in, not automatic) — the only
permission in OPUS more restricted than `printer:install`. The worker relay gets a
**dedicated `remote:agent` service scope** rather than reusing `scan:dequeue`, so
remote-shell relay is least-privilege-separated from scanning. Combined with
per-session ownership (no hijack, even by another admin), one-session-per-target,
idle/duration caps, a kill switch, and full input+output audit, the blast radius is
deliberately small and every use is accountable.

## Option: on-demand vs persistent channel

Per the user's note, the runspace is opened **only when Start session is clicked**
and torn down on End/idle/duration/lost-browser — nothing is connected to the
target between sessions. This is both safer (no standing tunnel) and simpler (no
reconnect/keepalive of an idle channel). The reaper guarantees a crashed worker
never leaves a runspace or a "live" session stranded.

## Why reuse the worker (not a new agent)

A per-endpoint agent would give the lowest-latency, most capable terminal, but OPUS
is deliberately **agentless** (spec 04) and the whole point is to avoid deploying
software to 100+ machines. Extending the existing always-on collector `worker` with
a new drain — exactly as spec 18 (cut-out) and spec 20 (printer install) did —
keeps the agentless posture and reuses the claim/fence/heartbeat/reaper machinery
already proven in spec 12.
