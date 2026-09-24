# 14. Printer page counter and daily report, rationale

The decision record behind [index.md](index.md): the context, the options weighed,
and why the chosen path won. `/develop` builds from `index.md`; this file is for a
human who wants the reasoning.

## Context

The engineer asked to see a printer's page counter in the UI and to get a daily
email of it. The device in the fleet today is a Canon imageFORCE 520 at
192.168.70.202.

Current state, from reading the code:
- The collector already reads a page counter over SNMP: `collect_snmp.py` queries
  `prtMarkerLifeCount` (`1.3.6.1.2.1.43.10.2.1.4.1.1`) into `PrinterInfo.page_count`.
- That value already reaches the web app: `ingestScan` stores the whole printer
  object as `machines.printer` JSON, so `machines.printer.page_count` holds the
  latest read for a matched printer.
- But it is not surfaced: the detail page's "Live scan" panel is computer shaped
  (OS, CPU, RAM, disk) and never reads `machines.printer`. There is no history
  (each ingest overwrites the latest), and there is no email.
- Spec 12 just shipped the pieces a daily report needs: the collector `worker` runs
  an in-process APScheduler, and web can send mail through aw-auth's
  `/v1/notify/printer-alert` using the `opus-web` service account and Resend.

Two facts shaped the design. First, a day over day delta needs a day indexed
history, which does not exist yet. Second, the Canon question: the standard
Printer-MIB `prtMarkerLifeCount` is not reliably answered by Canon office and
production devices, which commonly expose counters through Canon's own enterprise
MIB (base `1.3.6.1.4.1.1602`). So the exact OID for the imageFORCE 520 is not
known from a desk and must be confirmed against the device.

## Options considered

**Counter source (how to read the number from a Canon):**
1. Standard OID only (`prtMarkerLifeCount`). Simplest, zero config. Risk: reads
   empty on the imageFORCE 520, and then there is nothing to show or email.
2. Configurable OID, standard default, verify the 520 by walking it (**chosen**).
   One config value; keeps the standard behavior for devices that answer it, and
   lets the real Canon OID be set once found. Robust for a mixed fleet.
3. Scrape the Canon "counter check" web page. Avoids the MIB hunt, but HTML scraping
   is fragile and breaks on firmware and UI changes, and it is a second collection
   path to maintain.

Chosen 2: it is the only option that is both robust across devices and honest about
the unknown (the real OID is pinned during the build, not guessed now).

**Counter history storage:**
1. Daily snapshot, one row per printer per day (**chosen**). Tiny data, a trivial
   day over day delta, a natural fit for a "daily" report, and idempotent within a
   day.
2. A full history row per SNMP read (like `printer_checks`). Finer trend, but more
   rows and a slightly harder delta (find the last read of each day). Overkill for a
   counter that meaningfully changes once a day.
3. Store only the last two readings. Smallest, but throws away all trend and any
   ability to back report.

Chosen 1: the report is daily, so a daily grain matches the need exactly, and the
prune keeps a year cheaply.

**Where the report is assembled and sent:**
1. Web assembles the total and delta (it holds the history) and asks aw-auth to send
   (**chosen**). Mirrors spec 12's alert path exactly: web detects, aw-auth (which
   owns identity and the Resend key) resolves recipients and sends.
2. The collector assembles and sends. Rejected: the collector does not hold the
   history or the recipient list, and it would duplicate the send path.

**What triggers the daily send:**
1. The collector worker's APScheduler fires it, hitting a web endpoint (**chosen**).
   Reuses the scheduler spec 12 already runs; consistent with the reachability and
   prune jobs. The manual button uses a `scan:write` server action that calls the
   same shared assembler, so both paths share one code path.
2. A web side cron. Rejected: Next.js has no built-in scheduler, and the worker is
   the project's established scheduler.

## Rationale

The feature is mostly reuse. The counter is already read and already arrives at the
web app; the missing parts are a day indexed history, a place to see it, and an
email. Adding one small snapshot table filled from the ingest the app already
receives, one detail-page panel, and a report that leans on spec 12's scheduler and
Resend path keeps the new surface small and consistent with what shipped last week.
The single real unknown, the Canon OID, is handled the honest way: make the OID
configurable, default it to the standard, and confirm the device's real OID during
the build rather than guess it into the spec.

Keeping the live meter separate from the manual `printer_details.pageCount` avoids a
data fight: the manual field is admin metadata, the snapshot is the live reading, and
neither clobbers the other.

## References

Level: none. This feature reuses the existing stack and spec 12's patterns; no new
tools or external decisions needed a web landscape check. The Canon counter OID is a
device fact to confirm by walking the real imageFORCE 520 (Canon enterprise MIB base
`1.3.6.1.4.1.1602`), not a citation.
