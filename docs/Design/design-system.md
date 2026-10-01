# OPUS — Design System

**Status:** v3 (light first, blue accent) · **Last updated:** 2026-09-30 · **Direction set by:** spec 17 and the mocks in `docs/Design/` (`mock-printers-list.png`, `mock-printers-detail-page.png`)

The visual language for **OPUS IT Inventory**: a light, calm enterprise console with a
single blue accent, a light sidebar, photographic hero headers on list pages, and a rich
tabbed detail page. Clean geometric sans, white cards with hairline borders, big tabular
numbers, generous spacing. Polished and professional, never a generic template.

> This supersedes the old teal, dark first v2. The token values live in
> `web/src/app/globals.css` (the single source of color); this doc is the art
> direction. Components never hardcode a color literal (enforced by
> `web/scripts/check-no-teal.mjs` and its Vitest test).

---

## 1. Point of view

> A calm, confident operations console. Light canvas, one blue identity color,
> disciplined status colors, and numbers and charts that do the talking.

Tenets:
1. **Light first.** The product's default skin is light (`ThemeProvider defaultTheme="light"`);
   a dark theme is available via the toggle and carries the same blue accent.
2. **One accent, many status colors.** Blue is the brand/interactive color (buttons,
   active nav, links, focus rings). Semantic status (green/amber/red/slate) is separate
   and used only to encode state.
3. **Cards as containers.** White cards, ~16px radius, hairline borders, soft depth, group
   related data.
4. **Summary before detail.** Hero/title first, then the working table or the detail tabs.
5. **Quiet chrome, loud data.** Big bold tabular numbers; muted labels; restrained UI.

---

## 2. Color tokens

Light is the default palette (defined on `:root`); dark is the `.dark` class override
(driven by `next-themes`). Every color is a token; components never hardcode a literal.
Exact values live in `web/src/app/globals.css` — the table below is the intent.

### Accent (single blue)
| Token | Light | Dark | Use |
|---|---|---|---|
| `--primary` | `#2563EB` | `#3B82F6` | Brand, buttons, active nav, links, focus ring |
| `--primary-strong` | `#1D4ED8` | `#2563EB` | Pressed / hover |
| `--primary-foreground` | `#FFFFFF` | `#FFFFFF` | Text/icon on the accent |
| `--accent-soft` | `rgba(37,99,235,.10)` | `rgba(59,130,246,.16)` | Active nav bg, tinted icon tile |

### Grounds & text
| Token | Light | Use |
|---|---|---|
| `--background` | `#F6F8FB` | App background |
| `--card` / `--popover` | `#FFFFFF` | Cards, inputs, menus |
| `--sidebar` | `#FFFFFF` | Sidebar (light app wide) |
| `--border` | `#E2E8F0` | Card & control borders |
| `--border-soft` | `#EEF2F6` | Row dividers |
| `--foreground` | `#0F172A` | Primary text |
| `--muted-foreground` | `#64748B` | Secondary text, labels |
| `--faint` | `#94A3B8` | Tertiary, icons, placeholders |
| `--ring` | `var(--primary)` | Focus ring |

### Semantic status (separate from the accent)
| State | Light | Meaning |
|---|---|---|
| Deployed / Active | `#16A34A` green | In productive use |
| Online / Reachable | `#16A34A` green | Reachable / healthy |
| Maintenance | `#D97706` amber | Being serviced |
| Down | `#DC2626` red | Unreachable / failed |
| Storage / Idle | `#64748B` slate | In pool / not deployed |

### Chart palette
Blue `#2563EB` · Sky `#0EA5E9` · Amber `#D97706` · Slate `#64748B` · Violet `#7C3AED`.
Ordered, colorblind-reasonable, consistent across every chart. No teal.

### Radius
`--radius-card: 16px` (cards, hero header) · `--radius-control: 10px` (buttons, inputs,
icon tiles). A broader `--radius` scale (`--radius-sm..4xl`) covers everything else.

---

## 3. Typography

- **Family:** Geist Sans (self-hosted via `next/font`), system fallback `system-ui`.
- **Data/serial mono:** Geist Mono for serial numbers.
- **Scale:** 11 (uppercase label) · 13–14 (body/table) · 15–16 (card title) · 24–26 (page
  title) · 34+ (big metric). Metric numbers bold, tight tracking, tabular numerals.
- Uppercase table headers: ~11px, semibold, wide tracking, `--faint`.

---

## 4. Layout & shell

- **Two-column shell:** fixed **light sidebar (~240px)** + fluid **main**. Sidebar: wordmark,
  nav (Dashboard + Assets group + collapsible Locations tree + Manage group), a status
  footer ("Collector online"). The active nav item is **blue text on `--accent-soft`** with
  a blue left indicator bar; hover is `--muted`; focus is a visible ring.
- **Sticky top bar:** global search, theme toggle, mail, notifications (badge), user chip.
- **Content:**
  - **List pages** open with a **hero header** (`HeroHeader`): an icon tile, page title,
    subtitle, and right-aligned actions, optionally over a photographic background with a
    left-to-right gradient scrim (`--card` over the text, fading to reveal the photo) so
    text stays AA legible in both themes. Then a toolbar of filter dropdowns + actions,
    then the table card.
  - **Detail pages** open with a header row (product image, type pill, big serial/name,
    status, actions: Edit / Run Check / Open Management UI), then a **tab strip** (`Tabs`)
    that swaps card-based panels without navigation.
- **Radii:** cards ~16px, controls ~10px. **Depth:** hairline border + soft low shadow.

---

## 5. Shared primitives

- **`HeroHeader`** (`web/src/components/hero-header.tsx`) — title/subtitle/actions, optional
  icon tile and optional photographic background with a gradient scrim. AA-safe text.
- **`Tabs`** (`web/src/components/ui/tabs.tsx`) — a Base UI tab strip with a blue active
  underline, keyboard operable (arrow keys, roles), swaps panels without navigation.
- **Sidebar** (`web/src/components/app-sidebar.tsx`) — light treatment, blue active item.
- **KPI / metric card, table, status/reachability badges, filter dropdowns, buttons** —
  as shipped, now recolored from the blue tokens.

---

## 6. Iconography

Lucide line icons (via `lucide-react`). One consistent set across nav, metric tiles, type
icons, and toolbars. Decorative icons `aria-hidden`; standalone interactive icons carry an
`aria-label`. Icon sizes reference spacing tokens.

---

## 7. Data-viz rules

- Reuse the chart palette in the same order everywhere; blue leads.
- Encode state with color **and** a label/number — never color alone.
- Give charts the same care as type: consistent radii, legible legends, no 3D, no clutter.

---

## 8. Motion & accessibility

- Subtle ~120–200ms transitions on hover/active/tab change; respect `prefers-reduced-motion`.
- Contrast ≥ WCAG AA in **both** themes (verify blue-on-white, text over hero scrims, and
  status colors).
- Visible focus rings (`--ring` blue); full keyboard operability; ARIA on nav, tabs, table,
  charts, and the notification badge.

---

## 9. Anti-patterns (avoid the generic look)

- ❌ Any leftover teal (the retired accent) — guarded in CI.
- ❌ Purple→blue gradient hero, glassmorphism, glowing blobs.
- ❌ Rainbow category chips or color with no semantic meaning.
- ❌ Heavy drop shadows, everything `rounded-2xl`, emoji as UI icons.
- ✅ Instead: light calm canvas, one blue accent, disciplined status colors, tabular
  numbers, real charts, generous spacing, photographic hero headers.

---

## 10. Screens

- **Dashboard** — the landing view (KPI row, table, charts).
- **Category list views** (Computers, Monitors, Printers, Phones, Network) — hero header +
  filter toolbar + full-height table card.
- **Asset detail** — a dedicated page (not a drawer) with the product image, live-scan
  health, counters/checks, assignment + activity, across a type-appropriate tab set.
- **Scans / Discovery, Reports & Compliance, Admin** — the same system, same tokens.
