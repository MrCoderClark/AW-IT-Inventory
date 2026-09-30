# 17.01 Design system: light first, blue accent, new shell

Child of the [spec 17 umbrella](index.md). Defines the cross child token contract.

## Summary

Move OPUS to a light first, single blue accent design system with a restyled light
sidebar, plus two reusable building blocks the redesign needs: a hero page header
and a detail page tab strip. This is the foundation every other child and every
existing page inherits, because the change is made at the design token layer.

## Requirements

**Acceptance criteria**:
- **AC-1.1**: The accent is a single blue (`--primary`); no button, active nav item,
  link, or focus ring still renders teal, in either theme.
- **AC-1.2**: Light is the default theme (no dark on first load); the existing dark
  toggle still works and is also blue accented.
- **AC-1.3**: The sidebar is light app wide; the active nav item is blue text on a
  light blue background; hover and focus are visible and keyboard reachable.
- **AC-1.4**: A reusable `HeroHeader` renders a page title/subtitle/actions over an
  optional photographic background with a light gradient scrim; text stays AA
  legible over the image.
- **AC-1.5**: A reusable `Tabs` strip (built on the project's Base UI) renders a row
  of tabs with an active underline, is keyboard operable (arrow keys, roles), and
  swaps panels without navigation.
- **AC-1.6**: Every existing page still renders correctly under the new tokens (no
  broken contrast, no hardcoded teal); `docs/Design/design-system.md` is rewritten
  to the new direction.

## Decision

**Chosen option**: redefine the shared CSS design tokens (light default, blue
accent) and restyle the shell, rather than restyle each page. Add `HeroHeader` and
`Tabs` as shared components. Because the app already colors from tokens, the palette
change propagates app wide.

**Rationale (inline)**: OPUS already colors every surface from CSS variables and the
sidebar already themes off them, so the palette change propagates from one token
edit, not a page by page restyle. The theme default does flip (dark to light, see
below), which is the one behavior change, not just a repaint. The two new components
are the only net new UI primitives the mocks need beyond what exists.

## Standard definition

**Canonical pattern** — tokens are the single source of color; components never
hardcode a literal. Target values (pin exact hex in the build; these match the
mocks):

```css
:root {
  --primary: #2563EB;          /* blue-600, the one accent */
  --primary-strong: #1D4ED8;   /* pressed / hover */
  --primary-foreground: #FFFFFF;
  --accent-soft: rgba(37,99,235,.10); /* active nav bg, tinted icon bg */

  --background: #F6F8FB;  --card: #FFFFFF;
  --sidebar: #FFFFFF;     --sidebar-active: var(--accent-soft);
  --border: #E2E8F0;      --border-soft: #EEF2F6;
  --foreground: #0F172A;  --muted-foreground: #64748B;  --faint: #94A3B8;
  --ring: var(--primary);

  /* semantic status stays separate from the accent */
  --status-online: #16A34A;  --status-deployed: #16A34A;
  --status-maintenance: #D97706;  --status-down: #DC2626;
  --status-storage: #64748B;

  --radius-card: 16px;  --radius-control: 10px;
}
/* dark theme (existing toggle): same roles, dark grounds, same blue accent */
```

**Replaces**:
- The teal `--primary`/accent tokens everywhere.
- `docs/Design/design-system.md`'s dark first, teal direction (rewrite it).

**Enforcement**: tokens defined once in the global stylesheet; a build check that no
component sets a teal literal. Base UI + Tailwind v4 `@theme` already map tokens to
utilities.

**Rollout**: the token + sidebar change lands once and applies to every page
immediately (child 01). `HeroHeader` and `Tabs` are consumed by children 03 and 04.

**Exceptions**: none; every surface uses the tokens.

## Build plan

1. Redefine the color tokens (light default + dark) in the global stylesheet: blue
   `--primary`, light grounds, status colors kept. Satisfies **AC-1.1**, **AC-1.2**.
2. Flip the default theme dark to light in `layout.tsx` (`defaultTheme="light"`);
   keep the toggle and a working, blue accented dark theme. Satisfies **AC-1.2**.
3. Restyle the sidebar (`src/components/app-sidebar.tsx`) to the light treatment:
   blue active item on `--accent-soft`, visible hover/focus. Satisfies **AC-1.3**.
4. Build `HeroHeader` (`src/components/hero-header.tsx`): title/subtitle/actions over
   an optional background image with a gradient scrim and AA safe text. Satisfies
   **AC-1.4**.
5. Build `Tabs` (`src/components/ui/tabs.tsx`) on Base UI: accessible tab strip +
   panels. Satisfies **AC-1.5**.
6. Light mode regression pass (first class, not a wire up): the app defaults to dark
   today, so the light tokens are largely unexercised. Visually check EVERY page in
   light for contrast and layout, and fix any component that hardcoded a teal or
   dark literal. Satisfies **AC-1.6**.
7. Add a CI/lint guard that fails on a teal literal (a grep for the old teal hex, or
   an ESLint rule), so AC-1.1 is enforced, not aspirational. Rewrite
   `docs/Design/design-system.md` to the new direction. Satisfies **AC-1.1**,
   **AC-1.6**.

## Consequences

**Positive**: one edit repaints the whole app; two reusable primitives unlock the
redesign; the design doc finally matches the product.

**Negative / tradeoffs**: a global visual change touches every screen at once, so
the regression pass (AC-1.6) is real work; any component that hardcoded teal must be
found and fixed.

**Watch out**: the app defaults to dark today, so light is a real flip and the light
tokens are largely unvetted; the AC-1.6 light regression pass is genuine work, not a
formality. Users with a stored light preference already see light and are unaffected.
