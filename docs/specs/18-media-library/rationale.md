# 18. Media library, decision record

The reasoning behind [index.md](index.md). `/develop` does not read this file.

## Context

OPUS stores an asset photo as one object per asset: spec 17.02 put an `imageKey`
text column on `assets` pointing at a single object in S3 compatible storage. That
model has no idea two assets could share a picture. The fleet has many identical
devices (for example twenty of the same Canon printer), so an admin re uploads the
same photo for every one of them. There is also no way to name an image, see where
it is used, or reuse one deliberately.

The forces that shape the fix:
- **Reuse is the real need.** The same image must attach to many assets, which a
  per asset key cannot express cleanly.
- **Runs on your own servers.** OPUS is on prem by design, so any image processing
  (resizing, background removal) has to run locally, not on a cloud image API.
- **Background removal is a segmentation task, not a language model task.** An
  early idea was to use an Ollama model. Ollama serves text and vision language
  models; it does not produce segmentation masks. The right local tool is rembg
  (U^2-Net or BiRefNet ONNX models).
- **Keep the web process light.** Running a heavy ONNX model inside the Next.js
  server would bloat it; the collector already has a Python environment and an
  enqueue and poll pattern that fits async work.
- **Do not break existing photos.** Whatever replaces `imageKey` has to migrate
  the images already uploaded.

Not deciding means the duplicate uploads continue and every later image feature
(library, metadata, processing) has nowhere to hang.

## Options considered

### Option 1: Content hash dedup only, keep `imageKey`

Keep the single `imageKey` per asset, but key stored objects by their SHA-256 so
identical uploads share bytes.

**Pros**:
- Smallest change; no new table, no library UI.

**Cons**:
- No management surface, no name or notes, no deliberate "pick an existing image".
- Reuse is invisible and accidental; an admin still uploads per asset.
- No home for resizing or background removal to attach to.

### Option 2 (chosen): First class `media` entity, library, dedup, phased processing

An image becomes a `media` row that many assets reference, with a `/media` library
to browse and manage it, SHA-256 dedup on upload, and image processing added in
later phases.

**Pros**:
- Expresses reuse directly (many assets to one media row).
- Gives a real management surface and a place for metadata and processing.
- Phased, so the valuable core ships without waiting on resizing or rembg.

**Cons**:
- A migration off `imageKey`, a new table, and more code.
- Phase 3 adds a Python worker and an async flow.

### Option 3: Multiple images per asset (gallery) from the start

Model images as a join table so each asset can hold several.

**Pros**:
- Most flexible; supports a gallery per device later.

**Cons**:
- More UI and data model than the current one photo design and the mock need.
- The reuse problem does not require it. Rejected in favor of one primary image
  per asset now, with a gallery left as a possible later addition.

## Rationale

The real need is reuse, and reuse needs a shared thing to point at, which a per
asset `imageKey` cannot be (Option 1), so a first class `media` entity is the only
option that solves the stated problem rather than a corner of it. Content hash
dedup rides on top of that entity, so the same photo is stored once whether it is
picked from the library or uploaded again by someone who did not know it existed.

The on prem constraint drives the processing choices directly. Background removal
stays local with rembg rather than a cloud API, and it runs in the collector's
existing Python environment through the same enqueue and poll flow OPUS already
uses for scans, which keeps the heavy model off the web process and reuses a proven
pattern. The lighter alternative was a small synchronous rembg service the web
calls directly with no database job state; the enqueue and poll flow was chosen
instead so the web request stays fast and the work rides the existing scan job
machinery, at the cost of more plumbing. That machinery is the point: phase 3
reuses the `scan_jobs` atomic claim, worker id, and stale job sweep rather than a
bare status flag, so a crashed worker never strands a job and two pollers never
take the same one. Resizing is lighter and synchronous, so sharp in the upload
route is the simpler fit for phase 2 and needs no worker.

Blocking deletion of an in use image, and counting usage at read time rather than
storing it, both come from the same instinct: never let an asset silently lose its
photo, and never let a stored count drift from the truth. One primary image per
asset (not a gallery) matches the current UI and the mock; a gallery is real work
with no current demand, so it is deferred rather than built on spec.
