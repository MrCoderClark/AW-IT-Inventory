# 08. Add / edit / delete asset form — rationale

Decision record for [index.md](./index.md). This is the WHY; `/develop` builds from
`index.md` and can skip this file.

## Context

Assets enter `aw_it_inventory` two ways today: the Drizzle seed (`db/seed.ts`) and the
collector ingest path (a scan matched to a serial, or an inbox quick-create). There is
no way for an IT admin to add, correct, or remove an asset from the UI. The asset detail
page (`/assets/[id]`, spec 07) already anticipates this: its "Edit", "Reassign", and
"Print label" buttons are placeholder toasts, and spec 07 explicitly deferred the form
to "a later Add/Edit form". This is the top backlog item.

The forces at play:
- **Reuse over invention.** The write path already has a settled shape: Server Actions
  in `scans/actions.ts` returning a shared `ActionResult`, gated by a `requireWrite()`
  helper on `asset:write`, revalidating with `revalidatePath`, and a client dialog
  (`LinkDialog`) driven by `useTransition` + `sonner`. Tag generation
  (`generateTag` / `TAG_PREFIX`) already exists there too. A new form should extend these
  patterns, not add parallel ones.
- **No schema pressure.** The `assets` table already carries every field a form would
  edit. This is a UI + write-path feature, not a data-model change.
- **The stack has no form library.** There is no `react-hook-form` and no `zod`; forms
  so far are hand-rolled. A create/edit form has ~12 fields and a real trust boundary
  (the Server Action), so validation strategy is a genuine choice, not a given.
- **Small internal team.** A handful of IT admins on an on-prem tool, ~100 machines. This
  sets the bar for concurrency handling and delete safety: correctness and simplicity
  over multi-writer machinery.
- **A matched machine points at its asset.** `machines.assetId` is a FK with
  `onDelete: set null`, so deleting an asset must not orphan or corrupt a scan row; the
  existing FK already does the right thing (unlink, back to the inbox).

Not deciding leaves the inventory read-only from the UI, forcing seed edits or direct
database writes for every correction, which does not scale past the demo.

## Options considered

### Option 1: Modal dialog + Server Actions + shared zod schema (chosen)

One `AssetFormDialog` client component for both create and edit, built on the existing
Base UI `Dialog`, following the `LinkDialog` idiom. Three new Server Actions
(`createAsset`, `updateAsset`, `deleteAsset`) in `assets/actions.ts`, each gated by the
existing `requireWrite()` and returning `ActionResult`. One zod schema shared by the
form (inline errors) and the actions (the trust boundary). Tag helper extracted to a
shared module so both create paths use it.

**Pros**:
- Maximum reuse: dialog, `ActionResult`, `requireWrite`, `revalidatePath`, toast, and
  tag generation are all already in the codebase.
- One schema validates on the client and the server, so the rules live once.
- No schema change, no migration, no new route; small, contained surface.

**Cons**:
- Adds `zod` as a dependency and a validation pattern the project did not have.
- A modal with ~12 fields is a dense dialog; needs careful layout to stay usable.

### Option 2: Dedicated create/edit pages (`/assets/new`, `/assets/[id]/edit`)

Full RSC pages instead of a dialog. Arguably a better fit for a 12-field form and for
the user's general preference for pages over drawers, and the form is linkable.

**Pros**:
- Comfortable room for many fields; linkable and refresh-safe.
- No modal scroll/focus-trap concerns.

**Cons**:
- More routing surface and navigation state (where to return after save/cancel).
- A modal keeps the admin in context on the list or the detail page; for a quick edit or
  a quick add, a page is a heavier interaction. The engineer chose the dialog for this
  reason. (A modal is not the side-drawer the user dislikes; it is centered and
  transient.)

### Option 3: A REST route handler (`POST/PATCH/DELETE /api/assets`) + fetch

Do the writes through the API layer the reads already use (`/api/assets`).

**Pros**:
- A reusable HTTP surface other clients could call later.

**Cons**:
- The app's writes are Server Actions; only ingest and reads live under `/api`. Adding a
  write API means re-implementing auth (JWKS/cookie handling) and CSRF concerns that
  Server Actions handle for free. No caller needs the HTTP surface today. Reinventing the
  established write path for no current benefit.

### Option 4: Hand-rolled validation (no zod)

Match the current no-library house style; validate inside each action and in the form by
hand.

**Pros**:
- No new dependency; consistent with the existing hand-rolled forms.

**Cons**:
- The same ~12-field rules would be written twice (client and action) and drift.
- More manual, error-prone per-field checking for dates and enums. A single shared schema
  is the cheaper long-term path once more than one form exists.

## Rationale

Option 1 wins because it extends the write path the codebase already commits to
(`ActionResult` + `requireWrite` + `revalidatePath` + `Dialog` + `useTransition`),
adding the smallest new surface: three actions, one dialog, one schema, and no migration.
The forces from Context point straight at it: reuse over invention, no schema pressure,
a real trust boundary that benefits from one shared validator.

The engineer chose the **modal dialog** (Option 1) over dedicated pages (Option 2)
despite a general preference for pages over drawers. That preference is about the retired
side-drawer detail UI; a centered, transient create/edit modal launched from a button is
a different interaction and keeps the admin in context. Recorded so a later reader does
not "fix" it back into pages.

On the choices the engineer settled:
- **Add zod** (over hand-rolling): a 12-field form with a server trust boundary is
  exactly where one shared schema pays off; the rules live once and cannot drift between
  client and action. The cost is a new dependency and pattern, accepted deliberately.
- **Type locked on edit**: keeps the tag prefix and the asset type always consistent
  (the tag is generated once from the type). Retyping is rare; delete-and-recreate is an
  acceptable escape hatch.
- **Pick-from-existing assignee only**: keeps this spec focused on the asset; inline
  person-create is a clean follow-up rather than scope creep here.
- **Last write wins**: for a few admins, an optimistic `updatedAt` guard is machinery
  the team does not yet need; it is noted as the later path if concurrent edits bite.

On the decisions delegated to the design (the RECOMMEND items), each settled with the
full picture:
- **Extract the tag helper to `lib/tags.ts`** (runner-up: duplicate it): duplication
  would let the inbox quick-create and the new create action drift; AC-8 pins them to one
  definition.
- **Delete via a confirm dialog, not `window.confirm`** (runner-up: type-the-tag to
  confirm): a native `confirm()` is discouraged and blocking; type-to-confirm is overkill
  for a small trusted team. An explicit two-step dialog is the right weight.
- **Blank optional fields stored as null** (runner-up: empty string): null is the honest
  "unknown" and matches how ingest and the seed leave unset fields.

## Options / notes not taken further

- **Soft delete / archive table**: rejected for now. Soft deletes pollute queries and
  break assumptions; with the FK `set null` behavior and a small fleet, a hard delete is
  simpler and safe. Revisit if retired-asset history is ever required (Follow-up).
- **Serial uniqueness**: not enforced. Serial is nullable and sometimes unknown at
  creation; a unique constraint would block legitimate rows. Left as-is.
