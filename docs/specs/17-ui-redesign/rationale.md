# 17. OPUS UI redesign — rationale

The decision record for the spec 17 umbrella. `/develop` does not read this file.

## Context

OPUS shipped its first sixteen features against a design system (`design-system.md`)
that describes a dark first, teal accented console. The app today still defaults to
dark (`layout.tsx` sets `defaultTheme="dark"`, `enableSystem={false}`), teal
accented. The engineer produced new mocks for the printer pages (`docs/Design/mock-printers-*`)
that set a different direction: light surfaces, a single blue accent, a
photographic hero header on the list, and a rich tabbed detail page. The engineer
confirmed this is a new global direction, not a one page treatment, so the whole
app should move to it.

The mocks also imply capabilities OPUS does not have yet: a product photo per
asset, a five tab printer detail (Overview, Network, Counters, Checks, Activity),
an on demand Run Check, an Open Management UI link, a unified activity feed, and a
Manufacturer filter. Each is a real decision about how much new plumbing to build
versus how much to render from data that already exists (spec 12 reachability
history, spec 14 counter history).

Not deciding leaves two problems: the design system doc misleads every future
build, and the printer pages stay far behind the mocks the engineer has already
designed.

## Options considered

### Option 1: One large spec

Put the whole redesign in a single directory spec with a long phased build plan.

**Pros**: one document, one status to track.

**Cons**: four genuinely independent decisions (a design system, an object storage
capability, the printer pages, the category rollout) in one file sprawls; the
build plan becomes unwieldy; a reader building the printer pages must wade through
storage infra.

### Option 2: Umbrella plus child specs (chosen)

An umbrella `index.md` holds the program and the shared design token contract; four
child specs carry the design system, image upload, printer pages, and category
rollout, each buildable on its own in order.

**Pros**: each concern is specced and built independently but in a proven order;
the design tokens are stated once as the cross child contract; the flagship
(printers) proves the design before the rollout copies it.

**Cons**: more files and ceremony than one spec.

### Option 3: Printers only now, defer the rest

Spec just the printer pages and the tokens they need; leave the global rollout and
image upload for later.

**Pros**: smallest first step.

**Cons**: the engineer explicitly asked for the global direction, image upload for
all asset types, and the full category rollout; deferring them contradicts the
decision and would re strand the design system doc.

## Rationale

Option 2 wins on the forces above. The redesign is not one decision but four, and
they have a natural dependency order (tokens first, then storage, then the
flagship, then the rollout), which the umbrella captures cleanly while keeping each
child a focused build spec. The one shared thing every child needs, the design
tokens, lives once in the umbrella's cross child contract, so no child redefines
the palette.

Two design calls settle mock ambiguities. The sidebar: the list mock shows a dark
navy rail, the detail mock a light one; the light sidebar wins because the app is
light first and light on light content reads more calmly than a heavy dark rail,
and one treatment app wide beats two. The new data the mocks imply is rendered from
what already exists wherever possible (the activity feed from reachability and
counter history, Manufacturer from the existing vendor field, counters as the
single total OPUS already reads) rather than built new; the two genuinely new
capabilities the engineer asked for, uploaded images and the async Run Check, are
built, the first on MinIO (self hosted S3, matching OPUS's on prem, self hosted
posture) and the second on the existing spec 12 collector path (so the web app
still never reaches into the fleet).

MinIO over local disk or Postgres bytea: the engineer chose it for real object
storage that scales and keeps image bytes out of the inventory database and its
backups, accepting one more on prem service to run. Local disk was simpler but ties
images to one web host; Postgres bytea bloats the DB. HTTP per protocol
reachability and a mono/color counter split were both declined for v1 (rendered as
"not tracked"), keeping this program a redesign rather than a collector rewrite;
both remain the spec 12 / spec 14 follow ups they already were.
