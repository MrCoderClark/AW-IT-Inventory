# OPUS — Progress Log

Status of the OPUS IT Inventory system. Newest first. Each item shipped to `main`
via a feature branch + PR.

**Legend:** ✅ done · 🚧 in progress · 🔜 planned

---

## In progress 🚧 — Remote printer install (spec 20)

Push-install a printer onto a managed computer from the UI (full spec in
`docs/specs/20-remote-printer-install/`). Reuses the outbound worker + atomic
claim/fenced-status machinery (spec 12) and the cut-out "pull bytes, do work,
post result" model (spec 18). Admin-set driver catalog is a **filesystem folder
of manifests** (no upload UI). v1 is single-computer; batch/uninstall are
follow-ups.

- **Code complete across web + aw-auth + collector; needs deps + db:push +
  seed_rbac + tests + live verify; not committed.**
  - **Schema:** `printer_install_jobs` (target asset + frozen package snapshot +
    connection + fenced status + result). **Needs `npm run db:push`.** New types
    `PrinterInstallConnection/Result/PackageSnapshot`.
  - **Catalog:** `web/src/lib/printer-packages.ts` reads/validates
    `PRINTER_DRIVERS_DIR` (default `web/drivers/`, gitignored; format +
    example in `web/drivers.example/`). Integrity is a **content hash over the
    package file tree** (not zip bytes), frozen per job. New dep **fflate**
    (zip the bundle) — **`npm install`**.
  - **Data layer:** `web/src/db/printer-install.ts` — atomic `claimNextInstallJob`,
    fenced `updateInstallJobStatus`, `enqueueInstall`, `cancelPendingInstall`,
    `listInstallJobsForAssetTag`, `resolveInstallTarget`, `getPrinterPrefillOptions`.
  - **API:** `POST /api/scan/printer-install/claim`, `GET
    /api/scan/printer-packages/[id]/bundle` (zip + `x-bundle-sha256`), `POST
    /api/scan/printer-install/[id]/status` — all service `scan:dequeue`.
    Server actions `printer-install-actions.ts` (`printer:install`).
  - **UI:** a **Printers** tab on the computer detail page
    (`printer-install-panel.tsx` + `printer-install-dialog.tsx`): pick a package,
    optionally prefill from a printer asset, set name/connection, queue; install
    history with per-step captured output, cancel, "waiting for collector".
  - **RBAC:** new `printer:install` permission in `seed_rbac.py`, granted to
    Owner/Admin. **Needs `manage.py seed_rbac`** (and users re-login).
  - **Collector:** `install_printer.py` (download bundle → verify content hash →
    resolve creds via `resolve_profiles` → open WinRM → stage the zip base64 →
    `Expand-Archive` → `pnputil`/`Add-PrinterDriver`/`Add-PrinterPort`/`Add-Printer`
    (idempotent) → verify `Get-Printer` → cleanup). Wired into the worker drain
    loop; config knobs `printer_install_poll_interval` / `install_temp_dir` /
    `install_smb_transfer`. (Transfer is base64-over-WinRM; SMB fast path is a
    documented follow-up.)
  - **Tests:** `printer-install-actions.test.ts` (gate/validation/enqueue),
    `test_install_printer.py` (tree hash + integrity gate).
  - **Next:** `cd web && npm install && npm run db:push && npm test && npx tsc
    --noEmit`; `cd aw-auth && uv run python manage.py seed_rbac && uv run python
    manage.py test`; `cd collector && uv run pytest -q`; drop a real driver
    package in `web/drivers/<id>/`, restart web + worker, install to a computer,
    watch the job go succeeded with Get-Printer output. Commit + PR.

---

## In progress 🚧 — User management (branch `feat/user-management`)

In-app user & role management, closing the `/admin` "powered by aw-auth in a
later phase" gap. Builds the admin/self endpoints spec 02 §4 designs but left
unbuilt. Email-free by design: admins set/reset passwords (shown once), users
change their own; no forgot-password email flow. Touches only `aw-auth` and
`web` — **no Drizzle change, no `db:push`, no RBAC reseed** (`user:admin` is
already seeded and held by Owner/Admin).

- **Code complete across aw-auth + web; needs `manage.py test accounts`,
  `npm test` + `tsc`, and live verify; not committed.**
  - **aw-auth:** new `HasAppPerm` permission class (`accounts/permissions.py`,
    gates on a `user:admin` RBAC code via `User.get_permission_codes()`). New
    serializers + views for admin user list/create/detail (name·active·roles)/
    delete, admin set-password, read-only roles list; self password-change,
    profile PATCH (on `MeView`), and session list/revoke/revoke-all over
    SimpleJWT's `OutstandingToken`/`BlacklistedToken`. Safety guards: can't
    deactivate/delete/de-admin yourself, and can't strip the last active admin.
    URLs under `/v1/auth/*` (admin at `/v1/auth/admin/users`). Tests in
    `accounts/tests.py` (gating, create+login, set/change password,
    role assign, deactivate-blocks-login, guards, sessions).
  - **web:** admin calls are forwarded with the caller's **own** access token
    (`src/lib/auth/admin.ts`), so aw-auth re-enforces RBAC — no privileged
    service account. Server actions `users-actions.ts` (user:admin) +
    `account-actions.ts` (self). Zod `src/lib/user-schema.ts`. Pages:
    `/admin/users` (table + create-with-generated-password dialog),
    `/admin/users/[id]` (roles, activate/deactivate, reset password, delete),
    `/admin/roles` (read-only), `/account` (change password, edit name,
    sessions). Nav: Users + Roles added to `NAV_MANAGE` + `ADMIN_ONLY_NAV`;
    top-bar menu "My account" → `/account`; login card notes "ask an admin to
    reset". Admin page copy updated + a Users & roles card. Vitest:
    `users-actions.test.ts`, `account-actions.test.ts`, `user-schema.test.ts`.
  - **People ↔ Users link (by email, no schema change).** People (staff who
    hold devices, inventory DB) and Users (logins, aw-auth) stay separate
    systems but are linked when their emails match — so the overlap (staff who
    are also operators) isn't maintained twice. `getPersonByEmail` (web db) and
    `getUserByEmail` (admin client, lists+filters — user set is tiny). Surfaces
    (all admin-only, since they read the admin API): a "Directory entry" card on
    the user detail page + a Directory column on `/admin/users`; an "OPUS access"
    panel on the person detail page (roles/active + "Manage login", or "Create
    login" which opens the user dialog prefilled with the person's email·name,
    email locked); a "Login" badge on `/people`. No `authUserId` column, no
    `db:push`.
  - Caveats surfaced in the UI: a role change takes effect on the user's next
    sign-in (perms ride the token), and a revoked session / deactivation takes
    full effect within one ≤15-min access-token TTL.
  - **Next:** `cd aw-auth && uv run python manage.py test accounts`;
    `cd web && npm test && npx tsc --noEmit`; start the 3 processes and walk the
    verification steps (create user → sign in; assign role → re-login; admin
    reset; deactivate/reactivate; self password change + sessions; guards).
    Commit + PR.

---

## In progress 🚧 — Dashboard redesign (branch `feat/update-dashboard-ui`)

Rebuilds `/dashboard` to match `docs/Design/mock-refactor-dashboard.png`, mapping
the mock's slots to real OPUS data (no fabricated trends, no geo map we can't fill).

- **Code complete, needs `npm test` + `tsc` + UI verify; not committed.**
  - Header: title + subtitle + a live date/time (`dashboard/live-clock.tsx`,
    client, hydration-safe).
  - KPI row: `dashboard/stat-card.tsx` — Total Assets / In Use / Maintenance /
    In Storage, each with a **real % of fleet** in place of the mock's fake
    "vs last 30 days" (OPUS keeps no history).
  - Charts: Asset Status donut (status breakdown, `DonutChart` gained `showValues`)
    + Assets by Type bar chart (new `charts/bar-chart.tsx`, dataviz mark specs,
    design-system tokens).
  - Recent Alerts (`dashboard/recent-alerts.tsx`): recent notifications for admins
    (spec 19), recent discovered devices otherwise.
  - Recent Assets table (`getRecentAssets`).
  - **Asset Locations map** (real, FOSS): Leaflet + Esri World Gray Canvas basemap
    (light/dark; genuinely free, no API key, attribution only — CARTO/Stadia now
    require a key) for the clean mock look.
    `locations` gains nullable `latitude`/`longitude`; a coordinates editor on the
    location detail page (`location-coordinates-form.tsx` + `setLocationCoordinates`
    action, `location:write`); `getLocationMapPoints` aggregates each geocoded
    location's whole-subtree device count; `dashboard/location-map.tsx` (client,
    lazy Leaflet, theme-aware tiles, teardrop count pins, styled controls/popups)
    plots them, with a fleet-status legend below. Pin popups reverse-geocode the
    coordinates to a street address on click via Nominatim (free, no key, cached).
    The map is an **admin-toggleable widget**: `dashboard_widgets` table (absent =
    on, like discovery toggles), `db/dashboard.ts` + `setDashboardWidgetAction`
    (`scan:write`), a "Dashboard widgets" card on `/admin`
    (`dashboard-widgets.tsx`). Off → the dashboard shows the location list instead
    of the map (no external tiles/geocoding). Falls back to the "Assets by
    Location" list (`getAssetsByLocation`) until a site is geocoded.
  - Removed the old all-types `AssetTable` + "Quick Actions" from the dashboard
    (per-type pages still have the full filterable tables); removed the fake
    "Collector online / Last scan…" footer from the sidebar as requested.
  - New queries: `getRecentAssets`, `getAssetsByLocation`, `getLocationMapPoints`
    (+ `RecentAsset`, `LocationCount`, `LocationMapPoint` types); `getLocationById`
    now returns coordinates. New dep: **leaflet** (+ `@types/leaflet`).
  - Tests: `location-schema.test.ts` (coordinates schema), `db/dashboard.test.ts`
    (widget toggles).
  - **Next: `cd web && npm install leaflet @types/leaflet`; `npm run db:push`
    (adds the lat/long columns + `dashboard_widgets` table); `npm test` +
    `npx tsc --noEmit`; set coordinates on a location, toggle the map widget on
    `/admin`, then eyeball `/dashboard` (map/list) in light + dark. Commit + PR.**

---

## In progress 🚧 — Printer page count in the list + export, printer-detail refactor (branch `feat/printer-page-count-ui`)

Surfaces the printer page (life) counter on `/printers` and in its CSV export, and
migrates `printer-detail.tsx` onto the shared `detail-ui` primitives.

- **Code complete, needs `npm test` + `tsc` + UI verify; not committed.**
  - Page count on the list: `Asset.pageCount` (spec 14 latest total); new
    `getPrinterCounterMap` (`queries.ts`, DISTINCT ON latest reading per printer,
    keyed by tag) attached to printer assets in `getAssetsByType` alongside
    reachability. New spec-11 **Pages** column (`table-columns.ts` catalog +
    defaults for `printer`; `COLUMN_REGISTRY` cell, sortable, "—" when no reading).
  - Export: `assetCsvValue` handles `pages`, so the CSV mirrors the visible column
    (Pages exports by default on the printers table).
  - Refactor: `printer-detail.tsx` now imports `fmtDate/fmtDateTime/fmtDay/
    fmtNumber/Panel/InfoField/StatusRow/Dot` from `detail-ui` (removed the
    byte-identical local copies); printer-specific `fmtDelta/StatePill/ProtocolRow`
    and the `PrinterActivityEvent` table stay local. (The detail page already
    showed the counter — unchanged.)
  - Tests: updated `table-columns.test.ts` (printer defaults) + `csv.test.ts`
    (pages value). **Next: `cd web && npm test` + `npx tsc --noEmit`; verify the
    Pages column on `/printers`, export a CSV, and walk the printer detail page.**

---

## In progress 🚧 — Ingest orphan cleanup (branch `fix/ingest-orphan-cleanup`)

Removes the stale weak-keyed (`ip`/`hostname`) `machines` shadow row left when an
earlier scan couldn't read a hardware id and a later scan keys the same device by
`hardware_uuid`/`serial`. The latest-scan query already hides it; this deletes it.

- **Code complete, needs `npm test`; not committed.**
  - `web/src/db/ingest.ts`: after the machine upsert, on the weak→strong matchKey
    transition, delete the shadow row — scoped to this host's current `ip`/`hostname`,
    excluding the just-upserted row, and never a row linked to a *different* asset
    (so a recycled DHCP IP now on another device is left alone).
  - Test: `web/src/db/ingest.test.ts` (reaps on a strong-key scan; no-op on a
    weak-id-only scan) + a `delete` mock in the harness.
  - **Next: `cd web && npm test`; commit + PR.**

---

## In progress 🚧 — Notifications (spec 19) (branch `feat/notifications`)

In-app, admin-facing notification center behind the top-bar bell, live over SSE.
Full spec at `docs/specs/19-notifications/`. Stacked on `feat/reports-page` +
`feat/csv-export` (reuses the Reports warranty logic).

- **Code complete across web + collector; needs `npm run db:push` + `npm test` +
  `tsc` + live verify; not committed.**
  - Schema: `notifications` (one row per event: type/severity/title/body/assetId/
    href/dedupeKey unique/meta) + `notification_reads` (per-user read state).
    **Needs `npm run db:push`.**
  - Data layer `web/src/db/notifications.ts`: `createNotification` (idempotent on
    `dedupeKey`, publishes to the bus, best-effort), `listNotifications` (keyset,
    read flag, unread filter), `getUnreadCount`, `markRead`/`markAllRead`,
    `notifyPrinterTransitions`, `sweepWarrantyNotifications`, `pruneNotifications`.
    In-process SSE bus `web/src/lib/notification-bus.ts`.
  - Generation hooks (all best-effort): reachability route (down/recovery, beside
    the existing email), `updateJobStatus`→failed (scan-failed), ingest reconcile
    new-machine branch (device-discovered), daily warranty sweep.
  - API: `GET /api/notifications` (admin), `GET /api/notifications/stream` (SSE,
    admin), `POST /api/scan/notifications/warranty-sweep` (service `scan:dequeue`);
    notification prune folded into the daily `reachability/prune`. Server actions
    `notification-actions.ts` (mark read / all, `user:admin`).
  - UI: `NotificationBell` (admin-only, badge + panel + live SSE) replaces the
    static bell in `top-bar.tsx`; `/notifications` page (`notifications-view.tsx`:
    All/Unread, load-more, mark-all); shared `lib/notification-ui.ts`; nav entry +
    `ADMIN_ONLY_NAV` gate in the sidebar.
  - Collector: `run_warranty_sweep` + `notification_sweep_times` config knob +
    worker cron (schedule line shows "warranty sweep …").
  - Tests: `notifications.test.ts`, `api/notifications/route.test.ts`,
    `warranty-sweep/route.test.ts`; updated the reachability route, prune route,
    and ingest tests for the new hooks/mocks.
  - **Next: `cd web && npm run db:push`; `npm test` + `npx tsc --noEmit`;
    `cd collector && uv run pytest -q`; restart web + worker; live-verify the five
    events, the live badge in a second admin tab, mark-all, and that a non-admin
    sees no bell. Commit + PR.**

---

## In progress 🚧 — Export (CSV) (branch `feat/csv-export`)

The **Export** button on every asset table used to only toast "Export started".
It now downloads a real CSV of the current view, built client-side from data
already loaded (no server round-trip).

- **Code complete, needs `npm test` + `tsc` + UI verify; not committed.**
  - New pure helper `web/src/lib/csv.ts`: `assetCsvValue` (one `ColumnId` → plain
    text, the export counterpart of each rendered cell) + `assetsToCsv`
    (RFC 4180: label header, CRLF rows, quote/escape commas·quotes·newlines,
    drops the `actions` column). Shared by the table and its tests.
  - `asset-table.tsx`: `exportCsv()` writes the **resolved columns** (spec 11) for
    `table.getSortedRowModel().rows` — i.e. the current search / status / vendor /
    model filters and sort, all matching rows (not just the visible page) — as a
    BOM-prefixed `text/csv` Blob downloaded as `opus-<view>-<YYYY-MM-DD>.csv`.
    Empty result → an error toast; success toast reports the row count.
  - Test: `web/src/lib/csv.test.ts` (value mapping, empty/unassigned, reachability
    labels, header + rows, RFC 4180 escaping, header-only when no rows).
  - **Next: `cd web && npm test` and `npx tsc --noEmit`; filter/sort a table, hit
    Export, open the CSV; commit + PR.**

---

## In progress 🚧 — Reports page (branch `feat/reports-page`)

Replaces the `/reports` `PagePlaceholder` with real reports built from existing
data — no new tables, no collector work. Backlog's "recommended next".

- **Code complete, needs `npm test` + `tsc` + UI verify; not committed.**
  - Data layer: new `web/src/db/reports.ts` (server-only) — `getWarrantyReport`
    (expired / ≤30 / ≤90 / covered / unknown buckets + an action list of every
    device expiring within 90 days, soonest first), `getAgingReport` (age bands
    <1 / 1–3 / 3–5 / 5+ yr from `purchaseDate` + the oldest 15 as refresh
    candidates), `getAssignmentSummary` (assigned vs. pool totals, per-type
    breakdown, top 10 device holders). Day math is relative to today's UTC
    calendar day; location paths resolve via `getLocationPathMap`. Software reuses
    `getSoftwareInventory` (spec 15).
  - UI: `/reports` rebuilt — `HeroHeader` + a four-tab layout (Warranty / Asset
    aging / Assignments / Software), each tab a row of summary stat tiles over a
    focused table, linking out to `/assets/[tag]`, `/people/[id]`, `/software/[id]`.
    `asset:read`-gated (viewing open to any asset viewer, like `/software`). The
    Reports nav entry already existed in `NAV_MANAGE`.
  - Tests: `web/src/db/reports.test.ts` (bucketing + ordering + pool math, against
    a frozen "today").
  - **Next: `cd web && npm test` and `npx tsc --noEmit`; restart dev, walk the
    four tabs; commit + PR.**

---

## Shipped ✅ — assets display the cut-out (toggle) (merged, `feat/asset-use-cutout`)

Per-image toggle so assets using a library image show the **cut-out** (transparent)
instead of the original, and back (spec 18 phase 3 follow-on).

- **Code complete, web tsc + 428 tests green; needs `db:push` + verify.**
  - Schema: `media.preferCutout` boolean (default false). **Needs `npm run db:push`.**
  - `media.ts` `setPreferCutout`; `setMediaPreferCutout` server action (`asset:write`,
    revalidates the media page + asset surfaces). The asset image route serves the
    `cutout` variant when `preferCutout` + a cut-out exist, else the original.
  - Cache-bust: the asset query joins `media` and emits an `imageVersion`
    (`imageId:[c<attempts>|o]`) threaded through `AssetImage`/`AssetImageUpload` and
    the table + three detail pages, so toggling actually updates the shown image
    instead of serving a stale cached one.
  - UI: a **Switch** ("Show cut-out on assets") on `/media/[id]` once a cut-out is done.
  - Tests: asset-image `route.test.ts` (prefers cut-out when toggled). **Next:
    `npm run db:push`; on a media image with a cut-out, toggle it and confirm the
    asset's photo flips to transparent and back; commit.**

---

## Shipped ✅ — spec 18 Phase 3: background removal (merged, `feat/media-cutout` + `fix/rembg-cpu-extra`)

rembg background removal for library images (spec 18, AC-9): request a cut-out, a
self-hosted worker produces a transparent PNG, the page shows it; failed/stuck jobs
retry. Async claim/result flow mirroring `scan_jobs`.

- **Code complete, web tsc + 426 tests green, collector 25 pass; needs db:push +
  rembg install + live verify.**
  - Schema: `media` gains `cutoutKey`, `cutoutStatus` (null|pending|processing|done|
    failed), `cutoutClaimedAt`, `cutoutWorkerId`, `cutoutAttempts` (+ partial pending
    index). **Needs `npm run db:push`.**
  - Web `media.ts`: `requestCutout` (enqueue/retry), `claimCutoutJob` (atomic claim +
    stale-reap, mirrors `claimNextJob`), `completeCutout` (fenced store). API:
    `POST /api/media/cutout/claim` (service `scan:dequeue`, returns original bytes
    base64) + `POST /api/media/cutout/[id]/result`; `requestCutoutAction` server
    action; `media-serve` now serves the `cutout` variant. UI: `media-cutout-control.tsx`
    on `/media/[id]` (request/retry, status, cut-out preview on a checkerboard,
    auto-poll while running).
  - Collector: `cutout_worker.py` (outbound-only claim→rembg→post); `rembg` is the
    opt-in `cutout` extra (lazy import). **Folded into the main `worker`**: when
    `rembg` is installed the worker also drains cut-out jobs (on `cutout_poll_interval`,
    default 60s), so the whole app is **3 processes** (aw-auth, web, worker). The
    standalone `main.py cutout` command remains for running it separately.
  - Tests: `media.test.ts` (requestCutout/completeCutout), the two cut-out route tests,
    `test_cutout_worker.py`. `CLAUDE.md` "Run it" documents the 3-process startup.

  **Activate:** `cd web && npm run db:push`; `cd collector && uv sync --extra cutout`,
  then just run the normal `uv run python main.py worker` (it prints "background
  removal on"). On a `/media/[id]` page click **Remove background** → the worker
  produces the cut-out → the page shows it. Commit.

---

## Shipped ✅ — scheduled computer sweep (merged, `feat/scheduled-computer-sweep`)

A recurring, targeted scan of the computers an admin **manually added** (a Computer
asset with an IP), on the worker's scheduler — not a subnet discovery.

- **Code complete, web tsc + tests green, collector 22 pass; needs live verify.**
  - Web: `listComputerScanTargets` (`queries.ts`, Computer assets with a
    `computer_details.ipAddress`) + `GET /api/scan/computers` (service `scan:dequeue`,
    mirrors `/api/scan/printers`) + route test.
  - Collector: `sweep.py` `run_computer_sweep` (fetch targets → WinRM-collect those
    IPs computers-only → ingest; **bypasses the discovery toggles** since the IPs are
    explicit); `computer_sweep_times` config knob; wired into the worker scheduler
    (`worker.py`) as a cron job per time; `config.example.yaml` documents it; tests in
    `test_sweep.py`.
  - Local `config.yaml` set to `computer_sweep_times: ["12:00"]` (daily). **Next:
    restart the worker (it logs "computer sweep 12:00" in the schedule line); it fires
    daily and scans every manually-added computer. Commit.**

---

## Shipped ✅ — scan overwrites asset fields (merged, `feat/scan-updates-asset`)

Make a collector scan authoritative over an asset's **technical** fields (user
request). On ingest, a matched asset's `serial` / `model` / `vendor` and (for a
Computer) `computer_details` `cpu` / `ramGb` / `operatingSystem` / `storage` are
overwritten from the scan — **only where the scan returned a value** (a field the
collector didn't read never blanks an existing one), and human/admin fields (name,
location, cost center, dates, assignee) are never touched. Implemented in
`web/src/db/ingest.ts` (`applyScanToAsset`, best-effort; `computer_details` upserted
since the 1:1 row may not exist yet). Test: `web/src/db/ingest.test.ts`. Type-check +
407 tests green. **Next: scan a machine, confirm its asset fields update; commit.**
Note: this was the fix for the earlier "0 reachable" report, which turned out to be a
DHCP/IP mismatch (the entered IP wasn't the machine) — no collector change needed for
that; this enrichment is the follow-on the user asked for.

---

## Shipped — spec 17 UI redesign complete (merged)

All five children merged to `main`: 01 design system, 02 image upload (later
superseded by spec 18 media), 03 printers, 04 computers (`feat/computers-redesign`,
PR #37), 05 monitors/phones/network (`feat/thin-categories-redesign`, PR #38). Every
asset type is on the new list layout + shared tabbed detail framework (`detail-ui.tsx`
/ `Tabs`). Follow-up: migrate `printer-detail.tsx` onto `detail-ui` (still has local
primitive copies).

---

## Earlier in progress — spec 17.05 thin categories (branch `feat/thin-categories-redesign`)

Finishing the spec 17 UI redesign: every asset type now on the new list layout +
shared tabbed detail framework.

- **17.05 monitors / phones / network 🚧 code complete, type-check + 403 tests green;
  needs UI verify.** New `web/src/components/thin-detail.tsx` (`ThinAssetDetail`) on
  the shared framework — Monitor/Phone → Overview / Assignment / Activity; Network →
  Overview / Network / Activity. Reusable pieces extracted to `detail-ui.tsx`
  (`ActivityTable`, `AssignmentTimeline`, `deriveActivity`) and a shared
  `assignment-controls.tsx`; `computer-detail.tsx` refactored onto them. Routing sends
  the three types to `ThinAssetDetail`; the superseded generic `asset-detail.tsx` (+
  test) was **removed** (all five types now have redesigned details). The three list
  pages got the new layout (hero, Status/Vendor/Model filters, "New <Type>"). Test:
  `thin-detail.test.tsx`. **Next: UI verify monitor/phone/network detail + lists;
  commit.**
- **17.04 computers ✅ committed (`feat/computers-redesign`).** Tabbed detail (Overview
  / Live scan / Software / Assignment / Activity) + new list layout; shared
  `detail-ui.tsx` framework introduced.
- **With 17.05, spec 17 (OPUS UI redesign) is complete** — design system, image
  upload, printers, computers, and the thin categories all on the new design.
  Remaining follow-up: migrate `printer-detail.tsx` onto `detail-ui` (it still uses
  local primitive copies; left untouched to avoid regressing the untested printers
  page). Spec 18 Phase 3 (rembg) is the only other open item.

---

## Shipped earlier — spec 18 media library UI redesign (branch `feat/media-ui`)

Shared, reusable asset images (spec 18, `docs/specs/18-media-library/`): one upload
reused across identical devices, deduped by content hash, with a `/media` library.
Supersedes spec 17.02's single-`imageKey` storage model.

- **Media UI redesign 🚧 code complete, needs verify.** Rebuilt `/media` to match
  `docs/Design/Media Library Dashboard Mockup.png`: `HeroHeader` + Upload Image,
  three stat cards (Total Images / Assets Using Images / Total Size via
  `getMediaStats`), toolbar with search + **All Types** filter + **Most Used/Recent**
  sort + grid/list view toggle, richer cards (used-by pill, type·size, ⋯ Edit/Delete
  menu) linking to a new **media detail page** `/media/[id]` (large preview, Details
  incl. dimensions/uploaded/by, "Used in Assets" list, Notes) with
  `media-detail-actions.tsx` (edit dialog + delete). Backend: `listMedia` gained
  type filter + sort + offset pagination (join+groupBy so "most used" sorts by
  count), `getMediaStats`, `getMediaDetail`; `GET /api/media` takes `type`/`sort`/
  `offset` → `nextOffset`. Replacing a shared file is intentionally out of scope
  (would change every asset using it). **Next: restart dev, walk `/media` + detail;
  `npm test`; commit.**
- **Phase 2 (image resizing, sharp) ✅ committed (`feat/media-resizing`).** On upload:
  cap the stored original to 2000px, bake EXIF orientation, record real `width`/
  `height`, generate a 400px WebP `thumbnail` (`web/src/lib/image.ts`), stored as a
  second object. Lists/table/picker render the thumbnail; dedup unchanged. Phase 3
  (rembg cut-out worker) 🔜.
- **Phase 1 (reuse core + library) ✅ built, backfilled, verified; `imageKey` dropped.**
  Reuse confirmed end to end (one upload used by two printers, counted correctly).
  Upload names default to the device **model**; `imageId` replaces `imageKey` (column
  dropped after backfill). Vitest green. One-time `backfill-media.ts`/`diag-media.ts`
  removed after use. Pending: commit + spec-18 follow-ups (scope enroll, AGENTS sync,
  note 17.02 superseded). Phases 2 (sharp resizing) / 3 (rembg cut-out worker) 🔜.
  - Schema: new `media` table (+ partial-unique `media_sha256_uq`), `assets.imageId`
    (FK→media, `restrict`); `assets.imageKey` kept temporarily, dropped after backfill.
  - Data layer `web/src/db/media.ts` (create-or-reuse-by-hash with 23505 dedup-race
    handling, list+usage, update, delete-unused with 23503→in-use); `asset-images.ts`
    reworked onto `imageId`.
  - API: `GET/POST /api/media`, `GET/PATCH/DELETE /api/media/[id]`, shared
    `web/src/lib/media-serve.ts`; `GET /api/assets/[tag]/image` reworked to resolve
    through media (POST/DELETE removed); `setAssetImage` server action
    (`web/src/app/(app)/media-actions.ts`).
  - UI: `/media` page + `media-library.tsx` (grid/search/upload/edit/delete),
    `media-picker-dialog.tsx`, asset photo control reworked (Upload new / Choose from
    library / Remove), `AssetImage` serves via `imageId`; Media nav entry.
  - Tests: `media.test.ts` (dedup race, delete guard, usage count, classifiers),
    asset-image `route.test.ts` rewritten for GET-only.

---

## Previously in progress 🚧 — spec 17 UI redesign (branch `feat/printers-ui-redesign`)

Umbrella program (spec 17, `docs/specs/17-ui-redesign/`): light-first + blue design
system, asset image upload, then rebuild printers / computers / thin categories.
Scope tracker: `docs/scope/scope.md` → "OPUS UI redesign". Build children in order.

- **Child 01 (design system) ✅ built, verified, tested, committed.** Blue tokens +
  light default (`globals.css`, `layout.tsx`), light sidebar with blue active item,
  `HeroHeader` + `Tabs` primitives, teal-literal guard (`scripts/check-no-teal.mjs` +
  `no-teal-literal.test.ts`), design doc rewritten. `/check verify` walked every page
  in light (pass); `/test` green. `HeroHeader`/`Tabs` are built but only mounted in
  child 03. Hero photo staged at `web/public/heroes/printers.png`.
- **Child 02 (asset image upload) 🚧 code complete + tested, NOT committed, NOT verified.**
  Decision changed mid-flight: **MinIO is archived (Feb 2026), so it is fully removed**
  from all specs; storage is now `@aws-sdk/client-s3` (installed, `forcePathStyle`)
  against a self-hosted S3-compatible store. Code: `assets.image_key` column (schema),
  `web/src/lib/storage.ts`, `web/src/db/asset-images.ts`, route
  `web/src/app/api/assets/[tag]/image/route.ts` (GET/POST/DELETE), UI
  `asset-image.tsx` + `asset-image-upload.tsx` wired into `asset-detail.tsx` +
  `asset-table.tsx`. Tests: `route.test.ts` + `storage.test.ts` (20 pass). `tsc` clean.

  **Resume child 02 here (in order):**
  1. Start Docker Desktop (installed at `C:\Program Files\Docker\Docker`; the engine
     was not running, which made `docker` commands hang — wait for "Engine running").
  2. `cd dev/seaweedfs && docker compose up -d` (local dev S3 store, SeaweedFS on
     `:8333`; creds in `dev/seaweedfs/s3.json` = `opusdev` / `opusdevsecret123`).
  3. Add to `web/.env`: `S3_ENDPOINT=http://localhost:8333`, `S3_REGION=us-east-1`,
     `S3_ACCESS_KEY_ID=opusdev`, `S3_SECRET_ACCESS_KEY=opusdevsecret123`,
     `S3_BUCKET=opus-assets` (bucket auto-created on first upload).
  4. `cd web && npm run db:push` to apply the `image_key` column.
  5. Restart the web dev server, upload a photo on an asset detail page, then
     `/check verify opus ui redesign`.
  6. Commit child 02 (code + tests + the MinIO-removal spec edits + `dev/seaweedfs/`).
- **Children 03 (printers) / 04 (computers) / 05 (thin categories) 🔜** — not started.

---

## Shipped

### Pipeline — end to end ✅ (2026-08-26)
Scan the fleet → authenticate as a service account → ingest → reconcile → live in the UI.

| Phase | Branch | What shipped |
|---|---|---|
| Collector ingest + live drawer | `feat/collector-ingest` | Collector `--ingest` posts runs (client-credentials token → `/api/ingest/scan`); detail drawer shows **real** OS/CPU/RAM/disk/uptime for matched assets |
| Ingest API | `feat/ingest-api` | `machines` table; `POST /api/ingest/scan` (verifies service token via JWKS + `ingest:write` scope), upsert + reconcile to assets by serial (matched vs discovered); `/api` excluded from auth proxy |
| Service accounts | `feat/auth-service-accounts` | `ServiceAccount` model, `POST /v1/auth/token/client` (client-credentials → RS256 service token w/ scopes), `create_service_account` CLI, admin |
| Production serving | `feat/auth-serving` | granian (WSGI) + WhiteNoise for static/admin; fixed logout to `AllowAny` (blacklists refresh token) |
| Inventory DB | `feat/inventory-db` | Drizzle + Postgres (`aw_it_inventory`); DB-backed dashboard/table/drawer/⌘K; `/api/assets`; seed; `db:push`/`db:seed`/`db:studio` |

### Collector ✅
| Phase | Branch | What shipped |
|---|---|---|
| Specific targets | `feat/collector-targets` | `--target` (repeatable/comma-separated IP or CIDR) + `--targets-file` |
| Agentless scanner | `feat/collector` | Python/uv: TCP-probe discovery + classify, credential resolution (subnet rules + fallback), WinRM/PowerShell hardware+health, SNMP printers, JSON run reports |

### Auth (`aw-auth`) ✅
| Phase | Branch | What shipped |
|---|---|---|
| Name claim | `feat/auth-name-claim` | `name` claim in tokens; `full_name` required for superusers; Base UI dropdown-group fix |
| Local verification | `feat/web-jwks-verify` | Web verifies tokens locally via `jose` + JWKS (no `/me` per request; `/me` fallback) |
| Web login | `feat/web-auth` | `/login`, httpOnly cookies, proxy token refresh, real user in top bar, RBAC-gated nav |
| RS256 + JWKS | `feat/auth-jwks` | RS256 signing, `generate_keys`, `/.well-known/jwks.json` + OIDC discovery, `kid` on tokens |
| Auth core | `feat/auth-service` | Standalone Django + DRF: email User (Argon2), RBAC (roles/permissions), register/login/refresh/logout/me, admin, OpenAPI |

### Web UI ✅
| Phase | Branch | What shipped |
|---|---|---|
| Add/edit/delete asset form | `feat/add-edit-asset-form` | Manual asset CRUD from the UI: one `AssetFormDialog` (create + edit) off a "New asset" button on the dashboard and all five category pages (type pre-filled) and Edit on `/assets/[id]`; `createAsset`/`updateAsset`/`deleteAsset` Server Actions gated on `asset:write`; one shared zod schema on client + server; `generateTag`/`TAG_PREFIX` shared with ingest; guarded in-app delete (machine returns to inbox); Vitest coverage |
| Category list views | `feat/category-list-views` | Real per-type tables (Computers/Monitors/Printers/Phones/Network) on one config-driven `AssetTable`; dedicated `/assets/[id]` detail page replaces the side drawer (`?asset=` retired); `asset:read`-gated; Vitest + Testing Library suite |
| Discovered-devices inbox | `feat/discovered-devices-inbox` | `/scans` inbox: lists unmatched machines with up-to-3 ranked asset suggestions; link / quick-create / ignore / restore via `asset:write`-gated Server Actions; one nullable `machines.ignoredAt` column (ignore survives re-scans) |
| Asset detail | `feat/asset-detail` | URL-driven side drawer (metadata, health, audit, actions); clickable rows + ⌘K deep-link |
| Dashboard | `feat/ui-dashboard` | Next.js + Tailwind v4 + shadcn (Nova); sidebar/top bar, ⌘K palette, theme toggle, KPI cards, TanStack table, charts |

### Specs & design ✅
- `docs/specs/` — plan, architecture, auth spec, data model, collector spec, frontend spec.
- `docs/Design/` — OPUS design system + interactive mockup (`opus-dashboard.html`).

---

## Next / backlog 🔜

### Web app — stubs & missing features (from the 2026-10-05 comb-through)

Surfaces that exist in the UI but aren't wired to anything real:

- **Reports page** (`/reports`) 🔜 — currently a `PagePlaceholder`. Build real reports
  from existing data: warranty expiry, asset aging, software/license, assignment
  summaries. *High value, buildable now.* (Recommended next.)
- **Export (CSV)** 🔜 — the **Export** button on every asset table only toasts
  "Export started"; no CSV is produced. Stream a real CSV of the current view.
  `web/src/components/asset-table.tsx` (~line 778). *Quick win.*
- **Notifications** 🔜 — the **bell icon** in the top nav is decorative. Wire it to
  real notifications: printer down/recovery (spec 12 already detects these), scan-job
  failures, warranty expiry, newly discovered devices. Needs a notifications store +
  a dropdown/panel; the bell shows an unread count.
- **Compliance page** (`/compliance`) 🔜 — placeholder. Intended: BitLocker, AV, patch
  level, local-admin exceptions. **Blocked on collector work** — the collector does not
  gather these yet (only hardware/health/software). Collector additions first, then the
  web view.
- **Scan QR** 🔜 — asset-table button toasts "coming later"; would be browser-camera
  QR → open the matching asset. *Niche.*
- **Print label** 🔜 — detail-page button toasts "coming later"; needs a label format /
  printer integration. *Niche.*

### Web app — small cleanups

- **`printer-detail.tsx` → `detail-ui`** — migrate it onto the shared primitives
  (spec 17.04 left it on local copies to avoid regressing the untested printers page).
- **Ingest orphan cleanup** — remove the stale IP-keyed `machines` row after a
  fail→success scan transition (the latest-scan query already hides it; this removes it).

### Collector / infra

- **Collector: report all profile failures** — not just the last tried (would shorten
  WinRM credential debugging).
- **WMI-over-DCOM fallback** — scan hosts that only expose SMB (no WinRM).
- **NSSM service wrappers** — package web + aw-auth + collector `worker` as Windows
  services for prod (the final deploy step; Docker Compose intentionally **not** used).

### aw-auth (not web-focused)

- **MFA (TOTP)**, **refresh-token reuse detection UI**, **DRF service-account CRUD**.

### Done since this list was written

- ~~Schedule the collector~~ ✅ — printer reachability schedule (spec 12) + scheduled
  computer sweep (`feat/scheduled-computer-sweep`).
