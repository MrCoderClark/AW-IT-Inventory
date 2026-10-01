# 17. OPUS UI redesign: new global design direction

**Date**: 2026-09-30
**Status**: In Progress

## Summary

OPUS moves to a new look: light first, a single blue accent, a restyled light
sidebar, and photographic hero headers on list pages. The printer list and
printer detail pages are rebuilt to the new mocks (a rich detail page with tabs),
and the same new layouts roll out to every asset category. Along the way OPUS
gains uploaded product images per asset, stored in self hosted, S3 compatible
object storage. This umbrella holds the program; four child specs carry the pieces. The
mocks in `docs/Design/` are the design authority and supersede the old
`design-system.md` (which was teal and dark first).

## Structure

This is an umbrella. Build the children in order; each is a Tracer Bullet slice
(a thin working thread through every layer) that the next builds on.

- [01. Design system: light first, blue accent, new shell](01-design-system.md)
  — the global visual foundation (color tokens, light sidebar, hero header
  component, tabs, cards, typography) every page inherits. The cross child
  contract below is its output. Supports the "new global direction" decision.
- [02. Asset image upload (S3 compatible object storage)](02-asset-image-upload.md)
  — self hosted S3 storage, an upload path, and an `imageKey` on every asset, so
  the redesigned pages can show a real product photo. Supports the product image
  in the printer mocks.
- [03. Printers redesign: hero list + tabbed detail](03-printers-redesign.md)
  — the flagship surface built to the mocks: the printer list (hero, Manufacturer
  / Model / Location filters) and the printer detail page (five tabs, Run Check,
  Open Management UI, a derived activity feed). Proves the new design end to end.
- [04. Computers redesign](04-computers-redesign.md)
  — apply the new list and tabbed detail to Computers, the heaviest non printer
  category (live scan, tracked software, assignment); its own slice because it is
  roughly flagship sized.
- [05. Monitors, Phones, Network rollout](05-monitor-phone-network-rollout.md)
  — the three thin categories, rolled out together once the framework is proven on
  printers and computers.

## Cross child contract (the design tokens every child builds to)

Child 01 defines these; children 02 to 04 and the rest of the app consume them.
Concrete values are pinned in `01-design-system.md`; the contract here is that
they exist as tokens and nothing hardcodes a literal.

- **Theme**: light is the default skin (the app already renders light); a dark
  toggle stays. Tokens live on `:root`, dark under the existing toggle.
- **Accent**: one blue interactive color (`--primary`), replacing teal
  everywhere (buttons, active nav, links, focus rings). Semantic status colors
  (green reachable/online, amber maintenance, red down, slate idle) stay separate.
- **Shell**: a light sidebar (the detail mock's treatment, chosen over the list
  mock's dark rail) used app wide; the active nav item is blue text on a light
  blue background.
- **Surfaces**: white cards, hairline borders, ~16px card radius, ~10px control
  radius, generous spacing. Big bold tabular numbers for counters and metrics.
- **Hero header**: a reusable page header that can sit over a photographic
  background image with a light gradient scrim; used on the printers list now
  (child 03), available to other list pages later.
- **Tabs**: a reusable tab strip for detail pages (Overview plus type specific
  tabs), used by the printer detail (child 03) and the category detail pages
  (child 04).

## Requirements

**User stories**:
- As any user, I want OPUS to look like the new mocks (light, blue, modern) so the
  product feels current and consistent across every page.
- As an IT admin, I want a rich printer detail page with tabs, live health, and
  counters so I can manage a printer without leaving the page.
- As an IT admin, I want to attach a product photo to an asset so the inventory is
  easy to recognize at a glance.

**Acceptance criteria** (program level; each child spec refines these into its own
IDed ACs):
- **AC-1**: Every page renders in the new light, blue accented theme with the new
  light sidebar; no page still shows the old teal accent. (child 01)
- **AC-2**: An `asset:write` user can upload a product image for an asset, stored
  in the object store, and it shows on the asset's detail and list rows; a size/type limit is
  enforced and viewing is open to `asset:read`. (child 02)
- **AC-3**: The printers list matches the list mock (hero header with the office
  printer photo, Manufacturer / Model / Location filters, the reachability table,
  New Printer) and the printer detail matches the detail mock (product image,
  status, Edit / Run Check / Open Management UI, and the five tabs Overview /
  Network / Counters / Checks / Activity with their cards). (child 03)
- **AC-4**: Run Check enqueues an on demand reachability check the collector runs;
  Open Management UI opens the printer's management URL; the Activity feed is
  derived from existing reachability and counter history. (child 03)
- **AC-5**: The Computers, Monitors, Phones, and Network list and detail pages use
  the same new list and detail layouts (a type appropriate tab set), reusing the
  printer framework; Computers is its own slice (child 04), the three thin
  categories another (child 05). (children 04, 05)

## Decision

**Chosen option**: adopt a new light first, blue accented design system as the
global direction, rebuild the printer pages to the mocks as the flagship, add
S3 backed asset image upload, and roll the new layouts out to every asset
category. Structured as this umbrella plus four child specs, built in order.

Reasoning and options: see [rationale.md](rationale.md).

## Build plan

The umbrella sequences the children; each child carries its own `## Build plan`.

1. **Child 01 (design system)** — the token and shell foundation, applied app
   wide. Everything else builds on it. Satisfies **AC-1**.
2. **Child 02 (image upload)** — S3 compatible object storage, the upload path, the `imageKey`
   column. The redesigned pages need it for product images. Satisfies **AC-2**.
3. **Child 03 (printers)** — the flagship list + tabbed detail, the Tracer Bullet
   that proves the new design and the new data patterns end to end. Satisfies
   **AC-3**, **AC-4**.
4. **Child 04 (computers)** — generalize the printer framework to Computers, the
   heaviest non printer category, as its own slice. Satisfies **AC-5**.
5. **Child 05 (monitors, phones, network)** — the three thin categories together,
   once the framework is proven. Satisfies **AC-5**.

## Consequences

**Positive**:
- One coherent, modern look across OPUS, defined once as tokens.
- A far richer printer detail page (tabs, live health, counters, activity) without
  new scan infrastructure (it reuses spec 12 and spec 14 data).
- Assets gain real product photos.

**Negative / tradeoffs**:
- A large program touching every page; done as ordered slices to keep each
  shippable and verifiable.
- A new runtime dependency to operate: a self hosted, S3 compatible object store (deploy, secure, back up).
- The old `design-system.md` (teal, dark first) is superseded and must be rewritten
  to match, or it misleads.

**Neutral**:
- spec 05 (frontend spec) predates this direction; its visual guidance is
  superseded by child 01 (flag for `/architect` reconcile, not edited here).

**Watch out**:
- The app currently defaults to DARK (`layout.tsx` sets `defaultTheme="dark"`), so
  "light first" is a real behavior flip for every user with no stored theme, and
  the existing light tokens are largely unvetted. Treat the light mode regression
  pass (AC-1.6) as first class work: visually check every page in light, not just
  wire the tokens.

## Follow-up

- [ ] Rewrite `docs/Design/design-system.md` to the new direction as part of child
  01 (or supersede it with a pointer to spec 17).
- [ ] spec 05 (frontend spec) visual sections are superseded by child 01; reconcile
  or mark superseded via `/architect`.
- [ ] Extend uploaded images and the hero header pattern to non asset pages
  (Dashboard, Admin) if wanted, after the asset pages land.
- [ ] Real per protocol HTTP reachability + latency and a mono/color counter split
  stay deferred (spec 12 / spec 14 follow ups); the redesign renders what exists.

## Rationale

Reasoning, options considered, and context: see [rationale.md](rationale.md).
