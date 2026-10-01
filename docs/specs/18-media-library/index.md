# 18. Media library (reusable asset images)

**Date**: 2026-10-01
**Status**: Proposed

## Summary

OPUS today stores one uploaded photo per asset, tied to that asset alone (spec
17.02's `assets.imageKey`). When many identical devices need the same picture
(twenty of the same Canon printer, say), the photo has to be uploaded again for
each one. This spec replaces that with a shared media library: an image is
uploaded once, kept as its own record with a name and notes, and reused across
any number of assets. It is built in three phases: the reuse core first, then
automatic resizing, then optional background removal. Everything runs on your own
servers (no cloud image services).

## Requirements

**User stories**:
- As an IT admin, I want to reuse one photo across many identical assets, so I
  upload it once instead of once per device.
- As an IT admin, I want a library where I can browse, name, and manage the
  images, so I can find and reuse them.
- As an IT admin, I want images sized sensibly and, when I ask, the background
  removed, so they look clean and load fast.

**Acceptance criteria** (phase tagged; each is independently checkable):

Phase 1, reuse core and library:
- **AC-1**: A `media` table holds one row per image, and `assets.imageId` points
  at it (many assets to one media row). Existing `assets.imageKey` values are
  migrated into `media` and the `imageKey` column is dropped.
- **AC-2**: An `asset:write` user can set an asset's photo two ways: upload a new
  image (which is added to the library and assigned), or pick an existing library
  image. Viewing and picking are open to any `asset:read` user.
- **AC-3**: Uploading bytes whose SHA-256 already exists reuses the existing
  stored object and media row. No duplicate object is written and no duplicate
  row is created, even when two people upload the same file separately.
- **AC-4**: Uploads are validated for type (PNG, JPEG, WebP) and size (max 5 MB),
  the same limits as spec 17.02.
- **AC-5**: A `/media` page lists every image with its name, dimensions, and how
  many assets use it. An `asset:write` user can edit an image's name, alt text,
  and notes.
- **AC-6**: Deleting a library image that assets still use is blocked and reports
  the count. The delete succeeds only once no asset references it.
- **AC-7**: Image bytes reach the browser only through an app route that checks
  the session (the bucket stays private). An asset with no image renders the type
  icon, never a broken image.

Phase 2, resizing:
- **AC-8**: On upload a thumbnail is generated and the original is capped to a
  maximum dimension (via sharp), and the real width and height are recorded.
  Lists and pickers render the thumbnail, not the full image.

Phase 3, background removal:
- **AC-9**: An `asset:write` user can request background removal for a library
  image. A worker runs rembg and stores the cut out result as `cutoutKey`; the
  page reflects it on refresh, and a failed run can be retried.

## Decision

**Chosen option**: a first class media entity with a library surface, content
hash deduplication, and image processing added in later phases.

An image becomes its own record in a `media` table that many assets can point at,
replacing the one object per asset model from spec 17.02. Identical uploads are
collapsed by SHA-256. Resizing (phase 2) runs in the Next.js upload route with
sharp; background removal (phase 3) runs in a self hosted rembg worker that the
web app feeds through an enqueue and poll flow, reusing the collector's existing
service pattern. This spec supersedes spec 17.02's storage model (the single
`imageKey` column); the upload, validation, and private serving ideas from 17.02
carry forward.

## Feature design

**Data model sketch**:

`media` (new table, one row per distinct image):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, primary key | |
| `name` | text, not null | human title, used to find and pick |
| `altText` | text, null | accessibility text for `<img alt>` |
| `notes` | text, null | freeform description or source |
| `objectKey` | text, not null | stored image in S3, `media/{id}/image.{ext}` (capped to a max dimension in phase 2, so not always the exact uploaded bytes) |
| `thumbnailKey` | text, null | phase 2, `media/{id}/thumb.webp` |
| `cutoutKey` | text, null | phase 3, `media/{id}/cutout.png` |
| `contentType` | text, not null | `image/png` \| `image/jpeg` \| `image/webp` |
| `sizeBytes` | integer, not null | |
| `width` / `height` | integer, null | read via sharp in phase 2; null for legacy rows |
| `sha256` | text, null | dedup key; partial unique index where not null |
| `createdBy` | text, null | uploader email |
| `createdAt` / `updatedAt` | timestamptz, not null | |

`assets` change: drop `imageKey` (text), add `imageId` (uuid, null, foreign key
to `media.id`, `onDelete: restrict`). Relationship is many assets to one media
row, which is the reuse. Phase 3 adds a cut out job that follows the same claim
pattern `scan_jobs` already uses (atomic claim, worker id, retry), not a bare
status flag: `cutoutStatus` on `media` (`null` | `pending` | `processing` | `done`
| `failed`) for display, plus `cutoutClaimedAt`, `cutoutWorkerId`, and
`cutoutAttempts` so a worker claims a job atomically and a stuck job can be
requeued.

**State transitions** (phase 3 cut out job only):
`none → pending → processing → done`, with `processing → failed → pending` on a
retry. A worker claims a `pending` job atomically (an update that stamps
`cutoutClaimedAt`/`cutoutWorkerId` and returns the row, like the `scan_jobs`
claim), so two pollers never take the same job; a job stuck in `processing` past a
timeout is swept back to `pending` so a crashed worker never strands it. Phase 1
and phase 2 have no state machine.

**API surface**:

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/media` | GET | `q` (opt), `cursor` (opt) | list: id, name, thumb url, dims, usedBy | `asset:read` (cookie) | 401, 403 |
| `/api/media` | POST | `file` (multipart) | media row (id, name, ...) | `asset:write` | 413 too big, 415 bad type |
| `/api/media/[id]` | GET | `variant=thumb\|original\|cutout` | image bytes | `asset:read` | 404, 503 storage down |
| `/api/media/[id]` | PATCH | name, altText, notes | ok | `asset:write` | 404 |
| `/api/media/[id]` | DELETE | | ok | `asset:write` | 409 in use |
| `setAssetImage` (server action) | | tag, mediaId \| null | ok | `asset:write` | 404 |
| `requestCutout` (phase 3) | POST | mediaId | queued | `asset:write` | 404 |

The existing `GET /api/assets/[tag]/image` route is reworked to resolve the asset
to its media row and serve the right variant; its upload POST and delete are
replaced by the media upload plus `setAssetImage` flow.

**Variant fallback** (a media row can exist with a null variant key, for example a
legacy row before the phase 2 thumbnail backfill, or a cut out not yet made):
`thumb` falls back to `original` when `thumbnailKey` is null; `cutout` returns 404
when `cutoutKey` is null (the caller asks for it only when it exists); `original`
is always present. This fallback is about a missing variant on a real media row;
AC-7's "never a broken image" is the separate case of an asset with no `imageId`
at all, which renders the type icon.

**Key invariants**:
- At most one stored object per distinct SHA-256 (the partial unique index).
- An asset's `imageId` always references a real `media` row (foreign key with
  restrict), so a used image can never be deleted out from under an asset.
- "Used by N" is counted at read time (assets whose `imageId` equals a media id),
  never stored, so it can never go stale.
- Deleting a `media` row deletes its stored objects too, so no orphaned bytes
  remain in S3.
- The database guards are turned into clean results, never a raw 500: the dedup
  unique violation (23505) reuses the winning row, and the in use delete violation
  (23503) returns a 409.
- The bucket is never public; bytes reach a browser only through the app route.

**Security model**: managing media (upload, edit, delete, assign, request cut
out) needs `asset:write`; viewing and picking are open to any `asset:read` user.
No new permission is introduced; this reuses the gates from spec 17.02, people,
and software. Asset photos are not personal data, so no special compliance scope
applies.

**Configuration required**:
- Phase 1 and 2: none new. Reuse the `S3_*` settings from spec 17.02. `sharp` is
  a dependency with no configuration.
- Phase 3: the rembg worker authenticates like the collector (its own service
  account through aw-auth), so no new plaintext secret is added to the web app.

**Critical test scenarios** (each maps to an acceptance criterion above):
- Happy path: upload a new image on an asset, then assign the same image to a
  second asset from the picker; both render it and the library shows "used by 2",
  verifies **AC-2**, **AC-5**.
- Dedup: upload the identical file twice, including two uploads racing at once;
  exactly one object and one media row survive (the loser's object is cleaned up),
  verifies **AC-3**.
- Migration: existing `imageKey` assets come up pointing at migrated media rows
  with the same picture, verifies **AC-1**.
- Delete guard: deleting an in use image is blocked with the count; deleting an
  unused one succeeds, verifies **AC-6**.
- Auth: an `asset:read` user can view and pick but cannot upload, edit, delete,
  or request a cut out, verifies **AC-2**.

## Build plan

Ordered by phase; the data migration is task 1 (end to end slices per the
project default build approach, since the scope records none for this feature).

Phase 1, reuse core and library:
1. Migration: create `media` (with the partial unique index on `sha256`), add
   `assets.imageId`, backfill from `imageKey` (read each existing object, compute
   hash, size, and type, upsert deduped `media` rows, repoint `imageId`), then
   drop `assets.imageKey`. Satisfies **AC-1**.
2. Media data layer (`src/db/media.ts`, server only): create or reuse by hash,
   get one, list with the read time usage count, update metadata, delete only
   when unused. Three concurrency and cleanup rules the AC depend on:
   (a) **Dedup race**: two identical uploads can both miss the hash check and race
   on the partial unique `sha256` insert; catch the unique violation (the same
   way `isOpenAssignmentRace` in `assignments.ts` catches 23505), delete the
   loser's just written object, and return the winning row, so AC-3 holds under
   concurrency.
   (b) **Delete removes bytes**: deleting a `media` row also deletes its
   `objectKey`, `thumbnailKey`, and `cutoutKey` objects from S3, so no orphaned
   bytes leak.
   (c) **Delete race**: a concurrent assign can slip in between the "used by 0"
   check and the delete, so the restrict foreign key raises 23503; translate that
   into the same clean "in use" result (a 409), never a 500.
   Rework `asset-images.ts` to set and clear `assets.imageId` through media.
   Satisfies **AC-2**, **AC-3**, **AC-6**.
3. Media API: `GET`/`POST /api/media`, `GET`/`PATCH`/`DELETE /api/media/[id]`;
   rework `GET /api/assets/[tag]/image` to resolve through media; reuse the type
   and size validation from `storage.ts`. The `PATCH` here is the edit metadata
   endpoint behind AC-5 (the page in task 4 is its UI). Satisfies **AC-2**,
   **AC-3**, **AC-4**, **AC-5**, **AC-6**, **AC-7**.
4. UI: a `/media` library page (grid, search, usage count, edit, delete, blocked
   when in use) plus a reusable media picker dialog; rework the asset photo
   control to offer "Upload new" and "Choose from library", and have `AssetImage`
   serve from media. Satisfies **AC-5**, **AC-2**, **AC-7**.

Phase 2, resizing:
5. Add `sharp`; on upload generate a thumbnail and cap the original's max
   dimension, record `width`/`height` and `thumbnailKey`; render the thumbnail in
   lists and pickers. Satisfies **AC-8**.

Phase 3, background removal:
6. Migration: add `cutoutStatus`, `cutoutClaimedAt`, `cutoutWorkerId`, and
   `cutoutAttempts` to `media`. Stand up a rembg worker (in the collector's Python
   environment) that claims pending cut out jobs atomically through an app
   endpoint (reusing the `scan_jobs` claim and heartbeat pattern, with a stale job
   sweep requeuing anything stuck in `processing`), runs rembg, and posts back the
   result; a "Remove background" action enqueues, the worker stores `cutoutKey` and
   sets the status, the page reflects it on refresh, and a failed or stuck run is
   retryable. Satisfies **AC-9**.

## Consequences

**Positive**:
- One upload is reused across every identical device, which is the whole point.
- A real place to manage images (name, notes, see where each is used).
- Content hash dedup means the same photo is stored once no matter how it arrives.
- Phases 2 and 3 give cleaner, lighter images without blocking the core.

**Negative / tradeoffs**:
- Supersedes spec 17.02's simple single object model: a migration, a new table,
  and more code than one `imageKey` column.
- Phase 3 adds a Python worker and an async flow, so background removal is not
  instant.
- More moving parts overall (sharp, rembg, the picker, the library page).

**Neutral**:
- A new `/media` surface and nav entry.
- New dependencies: `sharp` (phase 2) and `rembg` (phase 3).
- Spec 17.02's storage model is superseded by this spec; its upload and private
  serving ideas carry forward.

## Migration plan

**Strategy**: phased, with a one time backfill.
**Phases**:
1. Create `media` and `assets.imageId`, backfill every `imageKey` into a deduped
   `media` row, repoint `imageId`, verify the images still render, then drop
   `imageKey`. Because the premise is that identical devices hold separately
   uploaded identical bytes, the backfill will collapse several old per asset
   objects into one `media` row; after `imageId` is repointed, delete the old
   duplicate objects that no longer back any media row, so the collapse does not
   leave orphaned bytes in S3.
2. and 3. are additive migrations (`thumbnailKey`/`width`/`height` already exist
   as nullable columns; phase 3 adds the cut out columns), so they carry no data
   risk.
**Rollback**: until phase 1 is verified, keep the old per asset objects (defer the
duplicate cleanup to a verified second pass), so reverting means pointing back at
the original key.
**Risks**: an existing object missing from S3 during backfill; handle by skipping
it with a logged warning and leaving that asset's `imageId` null (so it falls back
to the type icon), rather than failing the whole migration.

## Follow-up

- [x] Enroll a scope row for the media library (`docs/scope/scope.md`); phases 1
  and 2 marked done there.
- [ ] Pick the exact rembg model (U^2-Net vs BiRefNet) at phase 3 build time.
- [x] Record `sharp` + `src/db/media.ts`/`src/lib/image.ts`/`media-serve.ts` in
  `web/AGENTS.md`. (rembg + the collector cut-out worker get recorded at phase 3.)
- [x] Add a short note to spec 17.02 that its `imageKey` storage model is
  superseded by spec 18.
- [ ] A per asset gallery (multiple images per asset) is out of scope now; revisit
  if it is actually wanted.

## Rationale

See [rationale.md](rationale.md) for the problem context, the options weighed, and
why this approach was chosen.
