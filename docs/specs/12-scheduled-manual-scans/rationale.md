# 12. Scheduled and manual scans, rationale

The decision record for [index.md](index.md): why this shape was chosen, the options
weighed, and the forces behind them. `/develop` does not need this file.

## Context

> Premise note: this feature bundles three things that could each be their own decision,
> a manual scan queue, a scheduled printer reachability check, and printer down email
> alerting. They are kept in one spec because one long running worker carries all three
> and they share the queue, the ingest path, and the RBAC changes; splitting them would
> duplicate that shared spine. The alerting piece is the largest add (it pulls in email
> and a web to aw-auth call) and could be deferred, but the engineer explicitly asked for
> both the down flag and the email, so it is in v1. One prerequisite is called out below:
> web needs its own service account, which did not exist before.

Today the collector is an agentless command line scanner. An operator runs `main.py scan
--target ... --ingest` by hand; it discovers hosts, collects hardware and health over
WinRM (Windows) and SNMP (printers), and posts a run to the web app's `/api/ingest/scan`,
authenticating as a service account. The web app owns the inventory database and the UI.
The collector only ever reaches out; nothing connects into the fleet, which keeps scanned
hosts free of inbound firewall holes. The `machines` table already carries `lastSeenAt`
and `lastScanStatus`.

Two gaps drive this work. First, there is no way to start a scan from the product: every
scan is a terminal command, so a non operator cannot refresh a machine, and there is no
record of who asked for what. Second, printers are only seen when a full scan happens to
run, so there is no regular up or down signal and no notice when one goes offline. The
fleet is about 100 machines on a private network, all Windows, self hosted on premises.

The forces that shape the answer: the outbound only posture must hold (the web app cannot
be allowed to connect into the fleet); the manual feature needs a near real time response
(a queue that is only drained three times a day is not "Scan now"); the scheduled feature
needs a durable clock that survives reboots without a person at a terminal; and the whole
thing has to be operable by a small team on Windows, with a clean path to the planned
Docker Compose packaging. Not deciding leaves scanning as a manual chore and printer
outages invisible until someone notices a job did not print.

## Options considered

Two questions were settled: how manual scans are triggered, and where the schedule runs.
They collapse into one architecture choice because the trigger mechanism decides whether a
worker is already running.

### Manual trigger: how a scan starts

**Chosen: UI button plus a job queue the collector polls.** The web UI writes a
`scan_jobs` row; the collector pulls pending jobs, runs them, and posts results back.
Pros: keeps the outbound only posture (the collector reaches out, as it already does for
ingest), gives a real in product surface, and records who asked. Cons: the biggest build
(a table, worker endpoints, a poll loop, and a jobs UI).

**CLI only, made ergonomic.** Keep manual scans as `main.py scan --target`, just polished
and documented. Pros: almost no build. Cons: no product surface, no audit of who ran what,
and it does not meet the ask ("the ability to manually scan" from the UI).

**UI button calls the collector directly.** The collector runs an HTTP service the web app
connects into to start a scan. Pros: the simplest loop conceptually. Cons: it reverses the
network posture (the web app must reach into a fleet host), needs inbound firewall and port
setup, and breaks the one rule the current design holds to.

### Where the schedule runs

**Option 1: Windows Task Scheduler runs the collector CLI three times a day.** Pros: native
to Windows, no long running service for the schedule. Cons: it cannot serve "Scan now",
which needs frequent polling, so a polling worker is needed anyway; that leaves two
mechanisms (a scheduled task plus a worker) to install and watch.

**Option 2 (chosen): one long running collector worker.** A single `main.py worker` process
polls the queue for manual jobs and runs an in process scheduler (APScheduler cron triggers)
for the printer checks. Pros: one supervised process for both features, survives reboots when
installed as a Windows Service, no cron drift, and it becomes a `restart: unless-stopped`
container later with no rework. Cons: it must be installed and supervised (WinSW or NSSM),
and the schedule lives inside the process rather than in the OS.

**Option 3: web owns scheduling, collector polls.** Web enqueues recurring reachability jobs
on the same queue; the collector drains them. Pros: one mechanism (the queue) for everything.
Cons: Next.js has no built in cron, so web still needs an external clock (Task Scheduler or
similar) to create the recurring jobs, which just moves the scheduling problem without
removing it.

### Where alerting lives

**Chosen: aw-auth sends the mail.** Web detects the up or down transition (it holds the
history) and calls an aw-auth endpoint; aw-auth resolves the admin users and sends through
Resend. Pros: aw-auth already owns users and roles, so "admins" resolves correctly with no
second recipient list, and the engineer placed `RESEND_API_KEY` and `EMAIL_FROM` in
`aw-auth/.env`, so the credential already lives there. Cons: a new web to aw-auth call path
and a new `opus-web` service account.

**Web sends directly.** Web holds the Resend key and sends. Pros: no cross service call.
Cons: web would have to resolve which users are admins (it does not own users), and the
credential would have to move out of aw-auth where the engineer put it.

## Rationale

The manual trigger drove everything. Once "Scan now" has to feel immediate, the collector
must poll the web app on a short interval, which means it is already a long running process.
Given that, folding the three times a day printer schedule into the same process (Option 2)
is strictly simpler than standing up a second mechanism such as Task Scheduler (Option 1) or
pushing the clock into a web app that has no cron (Option 3). One process, one thing to
supervise, one place for logs. The queue is a plain database table drained by an atomic
claim, not a message broker; at about 100 machines a broker like Celery with Redis would be
operational overhead with no benefit, and the in process APScheduler needs no broker either.
This keeps the recommendation to boring, proven parts that a small team can run at 2am.

The outbound only posture is the hard constraint, and both the queue poll and the scheduler
respect it: the worker always reaches out to the web app and pushes results, exactly as the
existing ingest does, so no inbound path into the fleet is opened. That is why the "UI calls
the collector directly" option was rejected despite being conceptually simple; it would
require the web app to connect into a fleet host, the one thing this architecture avoids.

Alerting was placed in aw-auth because recipients are "admins", and admins are a role aw-auth
owns; resolving them anywhere else means duplicating identity. The engineer's own change
(putting the Resend credentials in `aw-auth/.env`) confirmed that home. The cost, a new
`opus-web` service account and a web to aw-auth call, is small and reuses the client
credentials grant the collector already uses.

The engineer chose "reachability each check plus a full SNMP once daily" and "re scan every
known device" for the global button; both are honored directly. The one place the design
adds beyond the literal ask is storing a small derived rollup (`printer_status`): correct
once only alerting needs a persisted last alerted state regardless, so computing consecutive
failures at read time would save nothing and complicate the transition logic. That tradeoff
is recorded in Consequences.
