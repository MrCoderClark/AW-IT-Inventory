# OPUS — Progress Log

Status of the OPUS IT Inventory system. Newest first. Each item shipped to `main`
via a feature branch + PR.

**Legend:** ✅ done · 🚧 in progress · 🔜 planned

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
