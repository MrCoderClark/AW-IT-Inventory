# OPUS — Design System

**Status:** Draft v2 · **Last updated:** 2026-08-21 · **Direction set by:** `docs/Design/mock2.jpg`

The visual language for **OPUS IT Inventory**: a modern, dark-first enterprise dashboard
with a teal accent. Clean geometric sans, rounded cards, real data-viz, generous spacing —
polished and professional without reading as a generic template. Reference mockup:
`docs/Design/opus-dashboard.html` (published as an Artifact).

---

## 1. Point of view

> A calm, confident operations console. Dark canvas so data and status colors pop;
> a single teal identity color; numbers and charts do the talking.

Tenets:
1. **Dark-first.** The product's primary skin is dark; a light theme is available via toggle.
2. **One accent, many status colors.** Teal is the brand/interactive color. Semantic
   status (green/amber/teal/slate) is separate and used only to encode state.
3. **Cards as containers.** Rounded 16px cards with hairline borders and soft depth group
   related data (KPIs, table, charts).
4. **Summary before detail.** KPI row first, then the working table, then analytics.
5. **Quiet chrome, loud data.** Big bold numbers; muted labels; restrained UI furniture.

---

## 2. Color tokens

Dark is the default palette (defined on `:root`); light is an explicit `[data-theme="light"]`
override. Every color is a token; components never hardcode a literal.

### Dark (default)
| Token | Value | Use |
|---|---|---|
| `--bg` | `#0E1317` | App background |
| `--sidebar` | `#0B1014` | Sidebar (slightly deeper) |
| `--card` | `#151C22` | Cards, inputs |
| `--card-2` | `#1A222A` | Hover / nested surface |
| `--border` | `#232E37` | Card & control borders |
| `--border-soft`| `#1B242C` | Row dividers |
| `--text` | `#F2F6F8` | Primary text |
| `--text-muted` | `#93A2AD` | Secondary text, labels |
| `--text-faint` | `#5E6C77` | Tertiary, icons, placeholders |
| `--accent` | `#2DD4BF` | **Teal** — brand, interactive, active nav |
| `--accent-strong`| `#14B8A6` | Pressed/strong teal |
| `--accent-soft`| `rgba(45,212,191,.13)` | Active nav bg, KPI icon bg |

### Semantic status
| State | Dark | Meaning |
|---|---|---|
| Deployed / Active | `#4ADE80` green | In productive use |
| Maintenance | `#FBBF24` amber | Being serviced |
| Online | `#2DD4BF` teal | Reachable / healthy (e.g. printers) |
| Storage / Idle | `#64748B` slate | In pool / not deployed |
| Positive delta | `#4ADE80` green | KPI up vs prior period |

### Chart palette
Teal `#2DD4BF` · Blue `#3B82F6` · Amber `#FBBF24` · Slate `#64748B` (+ Violet `#8B5CF6`
for a 5th series). Ordered, colorblind-reasonable, consistent across every chart.

### Light theme (toggle)
Same roles, lighter grounds: `--bg #F4F6F8`, `--sidebar/--card #FFFFFF`,
`--text #0F1B22`, `--accent #0D9488` (teal darkened for AA on white), status colors
darkened one step. Defined under `:root[data-theme="light"]`.

> Implementation note: this is a **committed dark design** — default is always dark
> regardless of OS (no `prefers-color-scheme` swing); the light theme applies only when
> the user toggles it (`data-theme="light"`). `body` sets an explicit token background.

---

## 3. Typography

- **Family:** a clean geometric/humanist sans. Preferred: **Figtree**, **Onest**, or
  **Plus Jakarta Sans**; system fallback `Segoe UI Variable, system-ui`. (Self-host as
  woff2 in the app; the Artifact mockup uses the system stack because CDNs are blocked.)
- **Data/serial mono:** `ui-monospace, "Cascadia Mono", Consolas` for serial numbers.
- **Scale:** 11 (uppercase label) · 13–14 (body/table) · 15 (card title) · 26 (page
  title) · 34 (KPI number). KPI numbers 800 weight, `-.02em` tracking, tabular numerals.
- **Page title pattern:** light-weight lead + bold emphasis — e.g.
  "IT Asset Management: **Overview & Inventory**".
- Uppercase table headers: 11.5px, 650 weight, `.03em`, `--text-faint`.

---

## 4. Layout

- **Two-column shell:** fixed **sidebar (236px)** + fluid **main**. Sidebar: logo, nav
  (Dashboard + collapsible Assets group + Compliance/Reports/Admin), status footer
  ("Collector online").
- **Sticky top bar:** global search (left/center), theme toggle, mail, notifications
  (badge), user chip (avatar + name + role + chevron). Subtle blur backdrop.
- **Content:** page head (title + Quick Actions) → **4 KPI cards** → **table card**
  (toolbar of filter dropdowns + Add Asset / Export / Scan QR, then the table) →
  **charts row** (Asset Distribution donut + Asset Status bars). 24–26px page padding;
  16px gaps.
- **Radii:** cards 16px, controls 10–11px, pills/dots small. **Depth:** hairline border +
  soft low shadow, never heavy.

---

## 5. Components

- **KPI card** — muted label + tinted teal icon top-right; 34px bold number; sub-line with
  a green delta chip or a count.
- **Table** — 30px rounded type-icon + bold asset name; muted type/model/location;
  monospace serial; **assignee avatar** (teal→blue gradient, mono initials; neutral for
  pools); **status** as a colored dot + label (green/amber/teal/slate); row hover; a
  `⋮` row menu; sortable header affordance on Asset ID.
- **Filter dropdowns** — pill-style `select` chips (Asset Type, Location, Status, Dept).
- **Buttons** — primary = solid teal on dark ink text; secondary = card bg + border;
  icon buttons 40px rounded.
- **Donut chart** — CSS conic-gradient donut with a center total + a legend with right-
  aligned percentages.
- **Status bars** — labeled tracks with a teal→green gradient fill for Active, flat
  colors for others.
- **Sidebar nav** — icon + label; active item = teal text on `--accent-soft`.
- **User chip / notifications** — avatar, role subtitle, bell with count badge.

---

## 6. Iconography

Lucide-style **line icons** (1.8px stroke, round caps), delivered as an inline SVG
sprite (`<symbol>` + `<use>`) or the `lucide-react` package in the app. One consistent
set across nav, KPI icons, type icons, and toolbar.

---

## 7. Data-viz rules

- Reuse the chart palette in the same order everywhere; teal leads.
- Donuts show a center total; bars show the value inline; keep gridlines faint or absent.
- Encode state with color **and** a label/number — never color alone (accessibility).
- Give charts the same care as type: consistent radii, legible legends, no 3D, no clutter.

---

## 8. Motion & accessibility

- Subtle 120–140ms transitions on hover/active; respect `prefers-reduced-motion`.
- Contrast ≥ WCAG AA in **both** themes (verify teal-on-dark and status colors).
- Visible focus rings (`--focus` teal); full keyboard operability; ARIA on nav, table,
  charts, and the notification badge.

---

## 9. Anti-patterns (avoid the generic look)

- ❌ Purple→blue gradient hero, glassmorphism, glowing blobs.
- ❌ Rainbow-colored category chips or color with no semantic meaning.
- ❌ Heavy drop shadows, everything `rounded-2xl`, emoji as UI icons.
- ❌ Stock unmodified component-library defaults.
- ✅ Instead: dark calm canvas, one teal accent, disciplined status colors, tabular
  numbers, real charts, generous spacing.

---

## 10. Screens beyond the dashboard

The dashboard is the landing view. The same system extends to:
- **Category list views** (Computers, Monitors, …) — the table card full-height with more
  columns + saved filters.
- **Asset detail** — a drill-in (drawer or page) with metadata, **live-scan health**
  (storage ring, sparklines from the collector), assignment + audit history, and label
  printing.
- **Scans / Discovery** — collector run history + the discovered-devices inbox.
- **Reports & Compliance** — warranty expiry, aging, software/license, BitLocker/AV state.
- **Admin** — users & roles (via `aw-auth`) and service-account (collector key) management.
