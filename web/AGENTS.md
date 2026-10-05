<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Web app conventions

## Configurable table columns (spec 11)

Every asset table column has a stable string id. The code owns three things,
kept in one pure module `src/lib/table-columns.ts` (imported by both the server
and the client): the per view catalog (what a view may show), the per view
defaults (today's hardcoded columns), and the render rule `resolveColumns`
(a saved layout wins over defaults, is filtered back through the catalog, and
always forces Name first and Actions last). Column cells are registered by id in
`COLUMN_REGISTRY` in `src/components/asset-table.tsx`; `AssetTable` takes a
`view` plus a `columnOrder` and resolves the columns from them. To add a column:
add its id and `ColumnDef` to the registry, then add the id to the right
`catalogFor` / `defaultsFor` entries.

Editing a shared layout is gated on the `columns:write` permission; reading is
open to any `asset:read` viewer (there is one shared layout per view). The write
path is `src/app/(app)/columns-actions.ts` (`saveColumnConfig` /
`resetColumnConfig`), which re-validates the submitted ids against the catalog
before writing. Layouts persist in the `table_column_config` table, one row per
view. Gotcha: a newly seeded aw-auth permission only reaches a user after they
sign in again, because permissions ride the access token's `perms` claim
(restarting servers or clearing the browser cache does not refresh it).

## Discovery type toggles (spec 13)

Per type on/off switches for what the collector automatically discovers
(Computers, Printers). The code owns the settings in one `server-only` module
`src/db/discovery.ts`: `getDiscoverySettings()` reads the `discovery_settings`
table and coalesces a missing type to `true`, so an absent row means on and the
empty table means "discover everything" (no seeding). `setDiscoveryToggle()`
upserts one row. The device type union and the `isDiscoveryType` guard live here
too; add a new toggleable type by extending both plus the table's `$type`.

Two callers, two auth gates. Admins edit from `/admin` through the
`setDiscoveryToggleAction` server action in `src/app/(app)/discovery-actions.ts`,
gated on `scan:write` (the switches render read only for a `scan:read` viewer who
lacks it). The collector reads the switches through `GET /api/scan/discovery-settings`,
gated on the service `scan:dequeue` scope, same token path as the other
`/api/scan/*` routes. The switches govern only the automatic sweep; manual scan
jobs never read them.

The `Switch` UI primitive (`src/components/ui/switch.tsx`) is the Base UI toggle
in the shadcn Nova style. Note for tests: it renders a `role="switch"` element
and uses `aria-disabled`, not the native `disabled` attribute, when disabled.

## Printer reachability + alerting (spec 12)

The collector `worker` runs an in-process APScheduler that checks every
manually-entered printer three times a day (a TCP probe, plus a full SNMP collect
on the first check) and posts the results to the web app. Three service endpoints
serve it, all gated on the service `scan:dequeue` scope (same token path as the
other `/api/scan/*` routes): `GET /api/scan/printers` (the targets to probe),
`POST /api/scan/reachability` (record checks), `POST /api/scan/reachability/prune`
(retention). The web app never connects into the fleet; the worker pulls and pushes.

The reachability engine is one `server-only` module `src/db/reachability.ts`. A
printer is "down" exactly when `printer_status.consecutiveFailures >= 2`.
`recordChecks` writes each check and the rollup in a transaction and returns the
up/down transitions to alert on; the route then fires the email and calls
`markAlertSent`. Key rule: `lastAlertState` is advanced only AFTER a successful
send, so a failed send leaves the transition pending and the next check retries it
(one down email per episode, one recovery email, no duplicates while down). The
UI read helpers (`getPrinterReachabilityMap`, `getPrinterReachability`) live in
`src/db/queries.ts`.

Alerting is the one web -> aw-auth call in the app: web detects the transition (it
holds the history) and `src/lib/notify.ts` posts to aw-auth's
`/v1/notify/printer-alert` with the `opus-web` service account (client-credentials,
scope `notify:send`; creds in `web/.env` as `OPUS_WEB_CLIENT_ID` /
`OPUS_WEB_CLIENT_SECRET`). Gotcha: aw-auth returns HTTP 200 with a `{ sent }` body
even when the underlying Resend send failed, so `notify.ts` keys success on
`sent === true`, not the status code (otherwise a failed delivery is silently
dropped instead of retried).

The printers table gains a `reachability` column (a normal spec-11 catalog +
defaults entry) rendered by `ReachabilityBadge`; the printer detail page shows the
badge plus recent check history.

## Printer page counter (spec 14)

Each network printer's total page (life) counter is read over SNMP and kept as a
daily snapshot: one row per printer per calendar day (`printer_counters`, the
latest read of the day winning). It rides the existing ingest, no new scan path:
on `/api/ingest/scan`, a matched printer with a numeric `page_count` upserts
today's snapshot via `upsertPrinterCounter` (best effort, a counter write never
fails the machine ingest). Everything else is computed from this history in one
`server-only` module `src/db/counters.ts`: `getPrinterCounters` (detail panel:
latest total, today's delta, recent daily history), `assembleCounterReport` (the
email rows), and `pruneCounters` (retention). This live SNMP meter is a printer's
only page count; the old manual `printer_details.pageCount` field was removed.

Delta rule: today's delta = today's total minus the most recent prior day's
total. No prior day reads "first reading" (no number); a drop reads "counter
reset" (never a negative); a printer with no snapshot that day reads "no reading"
in the report. So a printer's first ever day always shows "first reading".

Daily report + manual send. One shared `server-only` `sendCounterReport()`
(`src/lib/counter-report.ts`) assembles the rows and posts them through
`src/lib/notify.ts` (`sendCounterReportEmail`) to aw-auth's
`/v1/notify/printer-counter-report`, reusing the same `opus-web` service account
(`notify:send`) and Resend path as the spec-12 alerts; aw-auth renders the HTML
table email (name, serial, location, ip, total, today) and resolves the admins.
Two triggers: the worker's daily job hits `POST /api/scan/counter-report/send`
(service `scan:dequeue`); an admin hits the "Send counter report now" button on
`/admin`, which calls the `sendCounterReportNow` server action (cookie +
`scan:write`). Success keys on aw-auth's `sent === true`, like the alert path.

The report's location column reuses `getLocationPathMap`, now exported from
`src/db/queries.ts`. The daily retention prune
(`POST /api/scan/reachability/prune`, service `scan:dequeue`) now prunes
`printer_counters` as well as `printer_checks`.

## Software inventory (spec 15)

An admin-managed watchlist of software titles (`tracked_software`, unique on
`lower(name)`) and the tracked matches per Computer asset (`installed_software`,
current state, keyed on `assetId` like `printer_counters`, no history). One
`server-only` module `src/db/software.ts` owns it all: the watchlist read/add/remove,
`replaceInstalledSoftware` (the ingest-time filter), and the read paths
(`getSoftwareInventory` aggregate, `getSoftwareTitleDetail` drill-down,
`getInstalledSoftware` panel).

Match rule: a tracked title matches a program when the title is a case-insensitive
substring of the program's DisplayName, so one program can count under more than one
title. The collector sends every installed program; the filter runs web-side at
ingest. On `/api/ingest/scan`, a matched **Computer** asset with a `software` array
fully replaces its `installed_software` rows in a transaction (best effort, a software
write never fails the machine ingest). `software == null` means the collector didn't
read it (non-Windows or a read failure), so the prior set is left intact; a
non-Computer or unmatched machine stores nothing.

Managing the watchlist needs `scan:write` (reused, no new permission), through
`addTrackedSoftwareAction` / `removeTrackedSoftwareAction`
(`src/app/(app)/software-actions.ts`) and the Admin "Tracked software" card. Viewing is
open to any `asset:read` user: `/software` (every title, distinct-Computer count with 0
shown, distinct versions) and `/software/[trackedId]` (the machines that have a title),
plus a tracked-software panel on the computer detail page.

## People directory and device assignments (spec 16)

A managed directory of the staff who use the fleet, plus a full device custody
history. People live in the inventory DB (`people`, extended with department,
job title, phone, employee id, office location, and a `people_status` enum) with
NO link to aw-auth: they are employees, not login accounts, so the two databases
stay separate. `initials` is always derived from `name` on write (never entered).
Email and employee id are unique when present (email case-insensitively, via
partial unique indexes); a blank never collides.

The assignment engine `src/db/assignments.ts` is the single writer of
`assets.assigneeId`. Each hand out opens a row in `asset_assignments` and each
return closes it (`unassignedAt` null = the current holder); the engine keeps
`assigneeId` in step with the open assignment inside one transaction, so the two
never drift (AC-11). The partial unique index `asset_assignments_open_uq` enforces
at most one open assignment per device; a lost double-assign race surfaces as
SQLSTATE 23505 and is turned into a clean `already-assigned` result by
`isOpenAssignmentRace`, not a raw throw. The engine exposes transaction-aware
cores (`assignAssetTx` / `returnAssetTx`) so the asset form's assignee change
shares the asset create/update transaction: **the asset form never writes
`assigneeId` directly, it routes through the engine** (`assets/actions.ts`). Any
new code that sets `assigneeId` outside the engine breaks the invariant.

The directory + lifecycle live in one `server-only` module `src/db/people.ts`
(list/search/count, get one, create/update, archive/restore, delete only when the
person has no history, `deriveInitials`, `escapeLike` for search). Directory
search escapes LIKE wildcards. Archiving closes all of a person's open assignments
and returns those devices to the pool in one transaction. Managing people and
assigning devices both reuse `asset:write` (no new permission, no aw-auth reseed),
gated in `src/app/(app)/people-actions.ts`; viewing is open to any `asset:read`
user. The assignee picker (`getPeople` in `queries.ts`) lists **active people
only**. Surfaces: `/people` (directory: search, active/archived filter, device
count, pagination), `/people/[id]` (profile, current devices, history,
assign/return/archive/restore/delete), and an Assignment panel on the asset detail
page (assign/return + real custody history, replacing the old audit timeline).
Form validation is `src/lib/person-schema.ts` (zod, same client + server pattern
as `asset-schema.ts`; the client always submits a full `PersonFormValues`).

## Media library (spec 18)

Shared, reusable asset images: an image is uploaded once, stored once (content-hash
dedup), and reused across any number of assets. Supersedes spec 17.02's one-object-
per-asset `imageKey` model — assets now carry `imageId` (FK → `media`, `onDelete:
restrict`); the `imageKey` column was dropped after a backfill.

One `server-only` module `src/db/media.ts` owns the `media` table: `createOrReuseMedia`
(the SHA-256 of the **uploaded** bytes is the dedup key, so identical uploads collapse
to one row/object; a lost insert race on the partial-unique `media_sha256_uq` is caught
like `isOpenAssignmentRace` and returns the winning row), `listMedia` (name/notes
search + asset-type filter + sort by recent/most-used + offset pagination; usage is
counted in-query via a left join + `groupBy` — a correlated count subquery in the
`select` reads 0 in Drizzle, so don't use one), `getMediaStats`, `getMediaDetail`,
`getMediaUsageCount`, `updateMediaMeta`, and `deleteMedia` (blocked while any asset
uses it; the `restrict` FK's 23503 becomes a clean "in use" result, and deleting a row
also removes its S3 objects). `src/db/asset-images.ts` is the single writer of
`assets.imageId` (`getAssetMedia` resolves an asset tag → its media row for serving).

Image processing is `src/lib/image.ts` (`processImage`, **sharp**): on upload the
stored original is capped to 2000px (EXIF orientation baked in), real `width`/`height`
are recorded, and a 400px WebP `thumbnail` is stored as a second object. Dedup is on
the uploaded bytes, before processing. Bytes reach the browser only through
authenticated app routes via `src/lib/media-serve.ts` (`serveMediaVariant`, with a
thumb→original fallback); the bucket stays private. `sharp` is a dependency, so the
media/asset-image routes are `runtime = "nodejs"`.

API: `GET`/`POST /api/media`, `GET`/`PATCH`/`DELETE /api/media/[id]`;
`GET /api/assets/[tag]/image` resolves an asset through media and serves a variant (its
old upload POST/DELETE are gone — upload via `POST /api/media`, then assign with the
`setAssetImage` server action in `src/app/(app)/media-actions.ts`). Managing media
reuses `asset:write`; viewing/picking is open to any `asset:read` user (no new
permission). Surfaces: `/media` (dashboard: hero, stat cards, search / type filter /
sort, grid-or-list, upload/edit/delete) and `/media/[id]` (preview, details incl.
dimensions, "used in assets", notes); plus the asset photo control
(`asset-image-upload.tsx`: upload new / choose from library / remove) and
`media-picker-dialog.tsx`. Upload defaults the library name to the device **model**.
Legacy rows predating the resize phase have null dimensions and fall back to serving
the original; a media row's bytes are immutable (replacing a shared file is deliberately
not offered, since it would change every asset using it).

Background removal (spec 18 phase 3) is a cut-out job on the `media` row following
the `scan_jobs` claim pattern, not a bare flag: `requestCutout` enqueues (`pending`),
`claimCutoutJob` atomically takes the oldest pending row (`FOR UPDATE SKIP LOCKED`,
stamping `processing`/worker/attempts and reclaiming jobs stuck past a timeout, like
`claimNextJob`), `completeCutout` stores the PNG as `cutoutKey` (`done`) or marks
`failed`, **fenced** by the worker id so a reclaimed job's late result is dropped.
The collector's `cutout` worker (opt-in `rembg`) pulls `POST /api/media/cutout/claim`
(returns the original bytes base64 — the outbound worker never touches S3), runs
rembg, and posts the cut-out to `POST /api/media/cutout/[id]/result`. `media-serve`
serves the `cutout` variant; `/media/[id]` has the request/status/preview control
(`media-cutout-control.tsx`) and auto-polls while a job runs.

## Testing note: `server-only` under Vitest

`vitest.config.mts` aliases `server-only` to a no-op stub
(`src/test/empty-module.ts`) so a server module (a `src/db/*` helper) can be
imported directly in a test. Mock its real boundary (`@/db/index`, the auth
session, `next/cache`) as the existing action and db tests do.
