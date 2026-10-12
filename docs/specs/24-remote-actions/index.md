# 24. Remote Actions — interactive terminal session

**Date**: 2026-10-09
**Status**: Proposed

## Summary

OPUS gains a **Remote Actions** tab on a computer's detail page with a **live,
interactive PowerShell terminal** to that machine. An admin clicks **Start
session**; the always-on collector `worker` claims the session, opens a
PowerShell Remoting runspace into the target over the **same WinRM channel it
already uses to scan it**, and relays a live terminal to the browser. The admin
types commands; output streams back as it is produced; **End session** (or a
timeout) tears the runspace down.

It keeps the **outbound-only** posture that every other collector feature uses
(spec 12 scan jobs, spec 18 cut-out, spec 20 printer install): the web app never
connects into the fleet — the **collector dials out** to the web app for both
the work and the live relay, and initiates the connection into the target. The
session is **opened on demand** (only while a session is live) and is **arbitrary
remote code execution**, so it sits behind a new, deliberately narrow
`remote:shell` permission, records every byte for audit, and is owned by the one
admin who started it.

> **Honest scope note (read first).** Over WinRM/PowerShell Remoting you get a
> **streaming command REPL**, not a raw keystroke PTY: you submit a command line
> and its stdout/stderr stream back live (progress on long-running commands is
> visible). It is *not* a conpty/TTY, so full-screen interactive programs (a
> remote `vim`, arrow-key editing, pagers waiting on a TTY) do not work. A true
> PTY would require Windows OpenSSH (conpty) instead of WinRM — see Follow-up.
> This spec builds the command-streaming shell, which covers real admin use
> (services, scripts, diagnostics) and fits the existing WinRM channel.

## Requirements

**User stories**:
- As an IT admin, I want a live terminal to a specific managed computer from
  OPUS, so I can run diagnostics and fixes without manually remoting in.
- As an IT admin, I want to open the session on demand (not an always-on tunnel)
  and close it when done, so nothing is connected to the machine except while I
  am actively working.
- As an IT admin, I want to see command output stream live, so long-running
  commands show progress.
- As a security owner, I want every remote session fully gated and audited — who
  ran what, when, with the exact input and output — so remote shell access is
  accountable.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: An admin holding `remote:shell` can start a session from a Computer's
  detail **Remote Actions** tab. This creates a `remote_sessions` row with status
  `pending` and returns its id; the terminal UI opens and shows "waiting for
  collector".
- **AC-2**: The target must be a managed **Computer** asset with a resolvable IP
  (`computer_details.ipAddress`). Without one, the Start control is disabled and
  the server action refuses (422). WinRM reachability is proven by the worker when
  it opens the runspace, not at enqueue.
- **AC-3**: The worker claims exactly one pending session at a time atomically
  (`FOR UPDATE SKIP LOCKED`), fenced by `workerId` + `claimedAt` like scan jobs;
  it opens the runspace and moves the session to `active`. A session left in
  `claimed`/`active` with no heartbeat/activity past a timeout is reaped to
  `closed` (status `failed` if it never became active) so a crashed worker never
  strands a live runspace.
- **AC-4**: While `active`, the admin's typed input reaches the target and the
  target's stdout/stderr stream back to the browser **live** (append-only,
  ordered). The relay is collector-initiated end to end: the browser talks only to
  the web app; the collector pulls input from and pushes output to the web app.
- **AC-5**: The session is **owned** by the admin who started it. Only that user
  can view its stream or send input (a different admin opening the page sees the
  session as busy, not a hijackable stream). The input and status endpoints
  re-check ownership server-side.
- **AC-6**: **End session** closes it cleanly: status `closing` → the worker tears
  down the runspace → `closed`. An idle timeout, a max-duration cap, and losing
  the browser all also end the session (the worker stops relaying and disposes the
  runspace). A `closed`/`failed` session accepts no further input.
- **AC-7**: Every session is **audited**: an append-only `remote_session_events`
  log records each input line, each output chunk, and status transitions with a
  monotonic sequence and timestamps; the requesting user is on the session. The
  log also drives stream catch-up (resume from a last-seen sequence) and a
  retention prune.
- **AC-8**: Starting, sending input to, and ending a session are gated on the new
  `remote:shell` permission (seeded to `Owner` only by default; `Admin` is a
  documented opt-in). The worker relay endpoints require a service token carrying
  the new `remote:agent` scope. A user without `remote:shell` sees no Remote
  Actions controls and every server action / cookie endpoint refuses them.
- **AC-9**: **Bounded by construction.** At most one `active`/`pending` session per
  target computer at a time (a second Start returns "a session is already open");
  idle timeout, max session duration, and output back-pressure/size caps are
  enforced; the admin can always **kill** a session, which the worker honors on
  its next poll.
- **AC-10**: The session carries **no credentials**. Fleet admin creds live only
  in `collector/.env` (reused, resolved per subnet exactly as for scanning); the
  `remote_sessions` row and every relay payload are credential-free.

## Decision

**Chosen option**: Extend the existing collector `worker` with a new **remote
session** drain, reached over **WinRM / PowerShell Remoting (PSRP)** — a
persistent runspace per session held open only while the session is live. The
web↔collector relay is **plain HTTP, collector-initiated**: the collector
**long-polls** for input and **POSTs** output chunks; the browser receives output
over **Server-Sent Events (SSE)** and sends input via **POST**. One append-only
`remote_session_events` log is the relay buffer, the audit trail, and the
SSE/long-poll catch-up cursor. A new `remote:shell` RBAC permission gates the
trigger; a new `remote:agent` service scope gates the relay endpoints.

This keeps the outbound-only, no-new-infra posture: SSE and long-poll are ordinary
Next.js route handlers (this is self-hosted Node, so long-lived connections are
fine), so **no WebSocket server is introduced**. Command-level streaming tolerates
long-poll latency, so the UX is a responsive streaming REPL without a new always-on
socket layer. WebSocket (lower latency, true duplex) and OpenSSH (a real PTY) are
weighed and deferred in [rationale.md](rationale.md).

## Feature design

### Transport & relay (the core of this spec)

Three hops, **all initiated from the edges toward the web app** — the web app
never dials the collector or the fleet:

```
 Browser  ──SSE (GET, output+status)──►  Web app  ◄──long-poll (GET, input)──  Collector ──PSRP──► Target
    │                                        ▲                                      │
    └──POST input──────────────────────────►─┘                                      └──PSRP output
 (cookie, remote:shell, ownership)     one append-only remote_session_events    (service token, remote:agent)
```

1. **Browser → Web**: `POST /api/remote/sessions/{id}/input` with the typed line
   (cookie auth, `remote:shell`, ownership-checked). Appends an `input` event.
2. **Web → Browser**: `GET /api/remote/sessions/{id}/stream` is an **SSE** stream
   that replays events after the client's `Last-Event-ID` (or `?after=<seq>`) and
   then pushes new `output`/`system` events live, including status changes. On
   disconnect the browser reconnects and resumes from its last sequence (AC-7).
3. **Collector → Web (input pull)**: `GET /api/remote/sessions/{id}/agent/input?after=<seq>`
   long-polls (service token, `remote:agent`) and returns input events after the
   worker's cursor (or 204 on idle timeout, then the worker re-polls).
4. **Collector → Web (output push)**: `POST /api/remote/sessions/{id}/agent/output`
   appends `output` chunks (stdout/stderr) and status/system lines as the runspace
   produces them, fenced by `workerId` + `claimedAt`.

Everything flows through **one append-only log** keyed by a monotonic `seq`, so
the relay buffer, the audit trail, and the resume cursor are the same structure.
Both the SSE reader and the collector input long-poll are just "events after my
cursor" queries; the browser's output cursor and the collector's input cursor are
independent.

### Session lifecycle

- **Start** (`startRemoteSession` action, `remote:shell`): validate the target is
  a Computer with an IP, enforce "one open session per computer" (AC-9), insert
  `remote_sessions` (`pending`), return its id. The tab opens the terminal and the
  SSE stream.
- **Claim** (worker, `remote:agent`): `POST /api/remote/sessions/claim` atomically
  takes the oldest `pending` session (`FOR UPDATE SKIP LOCKED`), stamps
  `workerId`/`claimedAt`, status `claimed`.
- **Open**: the worker opens the PSRP runspace with the resolved target creds;
  success → `active` (+ a `system` event "connected"); failure → `failed` (+ the
  error), which the browser SSE surfaces.
- **Relay**: input pulled, output pushed, as above, while `active`. Each exchange
  bumps `lastActivityAt`; the worker heartbeats on the status endpoint.
- **End**: `endRemoteSession` action → `closing`; the worker sees it (status in the
  long-poll response or a dedicated check), disposes the runspace, posts `closed`.
  Idle timeout / max duration / lost browser likewise drive `closing`→`closed`.
- **Reap**: a `claimed`/`active` session with no activity past the timeout → the
  reaper closes it (like the spec-20 install reaper and spec-12 scan reaper).

### Data model (web DB `aw_it_inventory`, Drizzle; two new tables)

`remote_sessions`
- `id` uuid pk
- `assetId` uuid not null → `assets.id` on delete cascade (the target computer)
- `targetIp` text not null (snapshot of `computer_details.ipAddress` at enqueue)
- `shell` text not null default `powershell` (room for `cmd`/`pwsh` later)
- `status` text not null default `pending`: `pending` | `claimed` | `active` |
  `closing` | `closed` | `failed` | `canceled`
- `requestedBy` text not null (admin email from the access token; no FK — users
  live in aw-auth, like `scan_jobs.requestedBy`)
- `workerId` text null; `claimedAt`, `startedAt`, `endedAt`, `lastActivityAt`
  timestamptz null
- `error` text null (worker-level error when `status = failed`)
- `createdAt`, `updatedAt` timestamptz not null default now
- partial index on (`status`, `createdAt`) `WHERE status = 'pending'` (cheap claim
  poll, like `scan_jobs`); partial unique-ish guard for "one open per asset"
  enforced in the action + a partial index on `assetId WHERE status IN
  ('pending','claimed','active')`.

`remote_session_events` (append-only; relay buffer + audit + cursor)
- `id` uuid pk
- `sessionId` uuid not null → `remote_sessions.id` on delete cascade
- `seq` bigint not null — monotonic per session (DB sequence or `max(seq)+1` in the
  append tx); unique (`sessionId`, `seq`)
- `direction` text not null: `input` | `output` | `system`
- `channel` text null: `stdout` | `stderr` | `status` (for output/system)
- `data` text not null (the line/chunk, or a status token like `connected`)
- `createdAt` timestamptz not null default now
- index (`sessionId`, `seq`) for the "after cursor" reads

aw-auth DB: no new tables. `seed_rbac.py` gains **`remote:shell`** (granted to
`Owner`; `Admin` opt-in) and the collector service account gains the
**`remote:agent`** scope (alongside `ingest:write` / `scan:dequeue`).

### API surface

| Endpoint / action | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `startRemoteSession` (action) | action | assetTag | session id | cookie + `remote:shell` | 403, 422 no IP / not a Computer, 409 session already open |
| `endRemoteSession` / `killRemoteSession` (action) | action | session id | ok | cookie + `remote:shell` (+ owner) | 403, 404 |
| `/api/remote/sessions/{id}/input` | POST | text line | ok | cookie + `remote:shell` + owner | 403, 404, 409 not active |
| `/api/remote/sessions/{id}/stream` | GET (SSE) | `after` / `Last-Event-ID` | event stream (output, status) | cookie + `remote:shell` + owner | 403, 404 |
| `/api/remote/sessions/claim` | POST | workerId, version | one pending session (id, assetTag, targetIp, shell, workerId, claimedAt) or 204 | service `remote:agent` | 401, 403 |
| `/api/remote/sessions/{id}/agent/input` | GET (long-poll) | workerId, claimedAt, after | input events after cursor, session status | service `remote:agent` | 403, 404, 409 stale claim |
| `/api/remote/sessions/{id}/agent/output` | POST | workerId, claimedAt, events[] / status | ok | service `remote:agent` | 403, 404, 409 stale claim |

Session history/list for the tab (past sessions, who/when/duration) reads straight
from the DB in a server component gated `remote:shell` — no extra read endpoint,
like spec 12's jobs view.

### Collector flow (new module `remote_session.py` + a worker drain hook)

Folded into the worker loop like the cut-out / printer-install drains: when no
scan/install job is queued, poll `/api/remote/sessions/claim`. On a claimed
session:
1. Mark `active` under the claim fence (stop if lost, 409). Resolve target creds
   with the existing `resolve_profiles(targetIp, config)`.
2. Open a **persistent PSRP runspace** to the target (pwsh/WinRM). Post a `system`
   `connected` event; on failure post `failed` + the error and stop.
3. Loop while `active`:
   - long-poll `/agent/input`; for each input line, run it in the runspace and
     **stream** the output stream back via `/agent/output` as chunks arrive
     (stdout and error streams mapped to `stdout`/`stderr`), with periodic
     heartbeats (updates `lastActivityAt`).
   - honor `closing`/`canceled` (seen in the long-poll/status response) and the
     idle/duration caps → break.
4. Dispose the runspace (always, even on error), post the final `closed`/`failed`
   status.

### Key invariants

- **Outbound-only**: the collector initiates all three hops toward the web and the
  one hop into the target; the web app never connects into the fleet (AC-4).
- **Atomic claim + fenced relay**, identical to spec 12/20: one worker per session;
  a stale worker's output/status post gets 409.
- **Ownership**: only `requestedBy` may stream or send input; rechecked on every
  cookie endpoint (AC-5). One open session per target (AC-9).
- **On demand**: a runspace exists only between `active` and `closed`; nothing is
  connected to the target otherwise (AC-6). Idle timeout + max duration + kill
  bound every session (AC-9).
- **Append-only audit**: events are never mutated or deleted except by the
  retention prune; `seq` is monotonic so the browser and collector cursors are
  stable across reconnects (AC-7).
- **Credential-free rows/payloads**: creds only in `collector/.env` (AC-10).

### Security

- **This is arbitrary remote code execution** on an endpoint — the most powerful
  action in OPUS. It is therefore a **separate, narrower** permission than printer
  install: **`remote:shell`**, seeded to **`Owner` only** by default (Admin is a
  documented opt-in, not automatic). It rides the access-token `perms` claim like
  `scan:write`/`printer:install` (a newly granted role takes effect on next
  sign-in). The UI hides the tab's controls without it; every action and cookie
  endpoint rechecks it **and** session ownership.
- It does **not** widen the trust boundary: the collector already holds admin WinRM
  into these hosts to scan them; this uses that same channel. But it *does* raise
  what the UI can cause, so the mitigations are deliberate: owner-only perm,
  per-session ownership (no hijack), one-session-per-target, idle/duration caps,
  kill switch, and **full input+output audit** retained for review.
- The worker relay endpoints verify a dedicated **`remote:agent`** service scope
  (not `scan:dequeue`) via the existing JWKS path, so remote-shell relay is
  least-privilege-separated from scanning.
- The WinRM/UAC caveats from the collector AGENTS apply: a local admin on a
  domain-joined host needs `LocalAccountTokenFilterPolicy=1` (GPO) or a domain
  account in local Administrators, else WinRM returns "Access is denied".
- **Audit retention**: `remote_session_events` is pruned on the existing daily
  retention job (like reachability/counters); the retention window is configurable.
  Consider shipping session transcripts to the notification/audit surface later.

### Configuration required

- **web**: session caps — `REMOTE_SESSION_IDLE_TIMEOUT` (default 5 min),
  `REMOTE_SESSION_MAX_DURATION` (default 30 min), `REMOTE_SESSION_EVENT_RETENTION`
  (default 30 days), output chunk/size caps. SSE/long-poll need the Node runtime
  (`runtime = "nodejs"`) and streaming responses (not static).
- **aw-auth**: add `remote:shell` to `seed_rbac.py` (grant `Owner`; Admin opt-in),
  add the `remote:agent` scope to the collector service account, then
  `manage.py seed_rbac` / re-issue the service account.
- **collector**: `remote_session_poll_interval`, `remote_input_longpoll_timeout`
  (e.g. 25s), the stuck-session reaper timeout, and a PSRP library (e.g.
  `pypsrp`/`psrpcore`) dependency. Existing web base URL and fleet creds are reused.

### Critical test scenarios (each maps to an AC)

- **Happy path** (AC-1, AC-4): start → worker claims → runspace opens → a typed
  `Get-Date` streams output back → shown live. Collector test mocks the PSRP
  runspace; web tests cover the append/stream/cursor logic.
- **On-demand lifecycle** (AC-6): End session disposes the runspace and no further
  input is accepted; idle timeout and max duration both close an active session.
- **Ownership** (AC-5): a second admin cannot stream or send input to someone
  else's session (403); the control shows "a session is already open".
- **One per target / bounds** (AC-9): a second Start on the same computer → 409;
  kill closes an active session on the next worker poll.
- **No IP / not a Computer** (AC-2): control disabled, action 422.
- **Auth** (AC-8): no `remote:shell` → no controls and every endpoint refuses; a
  service token without `remote:agent` → 401/403 at the relay endpoints.
- **Resilience** (AC-3): two workers poll → one claims; a worker crash mid-session
  → the reaper closes it; a stale worker's output/status post → 409; the browser
  reconnects the SSE and resumes from its last `seq` with no gaps/dupes (AC-7).
- **Audit** (AC-7): every input and output is recorded in order; the transcript
  reconstructs the session; the prune drops events past the retention window.

## Build plan

Tracer-bullet slices — a thin live thread end to end first, then thicken.

1. **Foundations.** Add `remote_sessions` + `remote_session_events` (with the
   indexes) to `web/src/db/schema.ts` and `db:push`. Add `remote:shell` to
   `seed_rbac.py` (Owner) and the `remote:agent` service scope; reseed / re-issue.
   The `server-only` `src/db/remote-sessions.ts` module (create, claim, append
   event, read-after-cursor, status transitions, ownership checks, reaper, prune).
   Satisfies **AC-2/3/8** foundation.
2. **Relay thread (no target yet).** The cookie endpoints (`input` POST, `stream`
   SSE) and the agent endpoints (`claim`, `agent/input` long-poll, `agent/output`),
   plus `startRemoteSession`/`endRemoteSession` actions and the Remote Actions tab
   with an xterm.js terminal. Prove the loop with a **stub worker** that echoes
   input. Satisfies **AC-1/4/5/7** (relay), ownership, resume.
3. **Worker PSRP path.** `collector/remote_session.py`: open/dispose a runspace,
   run input lines, stream output, heartbeat, honor close/kill. Wire into the
   worker drain. Real end-to-end terminal to a computer. Satisfies **AC-4/6/10**.
4. **Bounds + resilience.** Idle/duration caps, one-per-target guard, kill, the
   reaper, "waiting for collector" via the heartbeat, and the retention prune.
   Satisfies **AC-3/6/9**.
5. **History + hardening + tests.** Session history on the tab, output size/back-
   pressure caps, transcript view; collector tests (mocked PSRP) and web tests
   (action gate, ownership, claim/relay fence, SSE cursor/resume).

## Consequences

**Positive**:
- A real, on-demand live terminal to any managed computer from the inventory, with
  no manual remoting — reusing the outbound worker, the atomic-claim/fenced machinery,
  and the **existing WinRM credentials and channel** used for scanning.
- No new inbound exposure and **no WebSocket infrastructure**: SSE + long-poll are
  ordinary route handlers on the self-hosted Node server.
- Every session is owned and **fully audited** (input + output), so the most
  powerful action in OPUS is also the most accountable.

**Negative / tradeoffs**:
- **Arbitrary RCE is now a first-class, web-triggered capability.** Bounded by an
  owner-only permission, per-session ownership, caps, a kill switch, and full
  audit — but a real increase in what the UI can cause on an endpoint.
- **Not a true PTY**: command-streaming REPL over WinRM, so full-screen/TTY
  programs don't work (OpenSSH/conpty is the path to a real PTY — Follow-up).
- Long-poll + SSE hold connections open; fine on self-hosted Node, but it is a
  longer-lived connection model than the rest of the app and needs the Node runtime
  and sane timeouts/caps.
- A new collector dependency (a PSRP library) and a new poll cadence.

**Neutral**:
- A new collector module and drain, two new tables, new env/config knobs, and an
  xterm.js dependency in web — all additive to the existing worker and UI.

## Follow-up

- [ ] **True PTY via Windows OpenSSH (conpty)** — an alternative transport for
  full-screen interactive programs, selectable per target when SSH is available.
- [ ] **WebSocket relay** — swap long-poll/SSE for a single duplex socket (lower
  latency) if a WS server is introduced for OPUS.
- [ ] **Canned/role-scoped actions** — a palette of vetted one-click actions
  (restart service, flush DNS, gather logs) for admins who shouldn't have a full
  shell, as a lower rung than `remote:shell`.
- [ ] **Session recording export** — ship transcripts to the audit log / email,
  and a signed, immutable transcript store.
- [ ] **File transfer** in-session (upload/download via the same channel).
- [ ] **Multi-target broadcast** — run one command across several computers.
- [ ] **Dedicated bastion/relay process** if long-lived connections on the Next.js
  server prove operationally awkward.

## Rationale

The options weighed (transport, PTY vs REPL, permission model), and the full
context: see [rationale.md](rationale.md).
