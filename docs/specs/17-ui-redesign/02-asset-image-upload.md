# 17.02 Asset image upload (MinIO object storage)

Child of the [spec 17 umbrella](index.md).

## Summary

Let an admin upload a product photo for any asset. Images are stored in self hosted
object storage (MinIO, an S3 compatible service OPUS runs on prem), referenced by a
key on the asset row, and shown on the asset's detail page and list rows. A generic
type icon shows when an asset has no image.

## Requirements

**User stories**:
- As an IT admin, I want to upload a photo for an asset so it is easy to recognize.
- As any `asset:read` user, I want to see an asset's photo without being able to
  change it.

**Acceptance criteria**:
- **AC-2.1**: An `asset:write` user can upload an image (PNG, JPEG, or WebP, at most
  5 MB) for any asset; it is stored in MinIO and the asset's `imageKey` is set.
- **AC-2.2**: The image shows on the asset detail page and on list rows; an asset
  with no image shows the generic type icon (no broken image).
- **AC-2.3**: A non image file, a file over the limit, or an upload by a user without
  `asset:write` is rejected with a clear error and nothing is stored.
- **AC-2.4**: An `asset:write` user can remove an asset's image; the object is
  deleted from MinIO and `imageKey` is cleared.
- **AC-2.5**: Viewing an image is open to any `asset:read` user; the bucket is not
  public (images are served through the app, never a public MinIO URL).

## Decision

**Chosen option**: MinIO for storage, a route handler for upload and a route handler
that streams the object for viewing (bucket private), an `imageKey` column on
`assets`. Applies to all asset types.

**Implementation skills**: none required; use the S3 compatible `minio` JS client
(recommended over `@aws-sdk/client-s3` for a MinIO only target; runner up is the AWS
SDK if S3 elsewhere is ever wanted).

**Rationale (inline)**: MinIO matches OPUS's on prem, self hosted posture and keeps
image bytes out of the inventory DB and its backups (the engineer's choice over
local disk and Postgres bytea). Streaming through the app keeps the bucket private
and reuses the existing cookie auth, so no public object URLs leak and `asset:read`
gates viewing.

## Feature design

**Data model sketch**:

`assets` (extend):
| Column | Type | Null | Notes |
|---|---|---|---|
| imageKey | text | yes | MinIO object key, e.g. `assets/<uuid>/<rand>.webp`; null = no image |

The object key, not a URL, is stored, so the endpoint and bucket can change without
rewriting rows.

**API surface**:
| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/assets/[tag]/image` | POST | multipart file | ok, imageKey | cookie + `asset:write` | 403, 413 too large, 415 wrong type, 404 no asset |
| `/api/assets/[tag]/image` | DELETE | — | ok | cookie + `asset:write` | 403, 404 |
| `/api/assets/[tag]/image` | GET | — | image bytes (streamed) | cookie + `asset:read` | 404 no image |

Upload validates type (PNG/JPEG/WebP) and size (<= 5 MB) on the server, puts to
MinIO under a random key, then sets `assets.imageKey` in one step (delete the old
object first if replacing). GET streams the object from MinIO with the right
content type and a cache header; it 404s when `imageKey` is null.

**Key invariants**:
- `imageKey` points at an object that exists, or is null; replacing an image deletes
  the superseded object so MinIO does not accumulate orphans.
- The bucket is private; images are only reachable through the authenticated GET
  route.
- The GET response sets `Cache-Control: private` (never a shared/public cache),
  because the bytes are behind an `asset:read` cookie; a shared proxy must never
  serve one session's image to another.

**Security model**: upload and delete require `asset:write`; viewing requires
`asset:read` (the app's normal cookie session). No public bucket, no public URLs.

**Configuration required**:
- `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_USE_SSL`: the MinIO server.
- `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`: credentials (gitignored `.env`).
- `MINIO_BUCKET`: the bucket for asset images (created on first use if missing).

**Critical test scenarios**:
- Happy path: upload a PNG, it stores and shows on detail + list, verifies
  **AC-2.1**, **AC-2.2**.
- Failure: a 10 MB file and a `.txt` are both rejected, nothing stored, verifies
  **AC-2.3**.
- Auth: an `asset:read` user cannot upload or delete (403) but can view, verifies
  **AC-2.3**, **AC-2.5**.
- Replace + delete: replacing removes the old object; delete clears `imageKey`,
  verifies **AC-2.4**.

## Build plan

1. Migration: add `assets.imageKey` (nullable). Satisfies **AC-2.1** (data).
2. MinIO client + config: a `server-only` `src/lib/storage.ts` wrapping the `minio`
   client (put, get stream, remove, ensure bucket) from the env config. Satisfies
   **AC-2.1**, **AC-2.5**.
3. Upload + delete route (`POST`/`DELETE /api/assets/[tag]/image`), gated on
   `asset:write`, with type + size validation and old object cleanup. Satisfies
   **AC-2.1**, **AC-2.3**, **AC-2.4**.
4. View route (`GET /api/assets/[tag]/image`), gated on `asset:read`, streams from
   MinIO or 404s. Satisfies **AC-2.2**, **AC-2.5**.
5. UI: an image upload control on the asset form / detail (drop or pick, preview,
   remove) and an image slot on detail + list rows with the type icon fallback.
   Satisfies **AC-2.2**.
6. Tests: validation (type/size), the `asset:write` gate both ways, replace/delete
   object cleanup. Satisfies **AC-2.1**, **AC-2.3**, **AC-2.4**.

## Consequences

**Positive**: real product photos across the inventory; bytes stay out of Postgres;
a reusable storage helper for any future upload.

**Negative / tradeoffs**: MinIO is a new service to deploy, secure, and back up;
streaming images through the app adds load versus a CDN (acceptable at fleet scale).

**Neutral**: a first use of object storage in OPUS; env and deploy docs need the
MinIO settings.
