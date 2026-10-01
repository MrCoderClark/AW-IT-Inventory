# OPUS — Progress Log

Status of the OPUS IT Inventory system. Newest first. Each item shipped to `main`
via a feature branch + PR.

**Legend:** ✅ done · 🚧 in progress · 🔜 planned

---

## In progress 🚧 — spec 18 media library, phase 1 (branch `feat/media-library`)

Shared, reusable asset images (spec 18, `docs/specs/18-media-library/`): one upload
reused across identical devices, deduped by content hash, with a `/media` library.
Supersedes spec 17.02's single-`imageKey` storage model.

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

- **Docker Compose** — package web + aw-auth + collector for on-prem deploy.
- **Schedule the collector** — periodic scans.
- **WMI-over-DCOM fallback** — scan hosts that only expose SMB (no WinRM).
- **MFA (TOTP)**, **refresh-token reuse detection UI**, **DRF service-account CRUD**, **reports/compliance views**.
