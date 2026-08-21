# 05 — Frontend Spec (OPUS — Next.js Inventory App)

**Status:** Draft v2 · **Last updated:** 2026-08-21
**Stack:** Next.js (App Router) · TypeScript · Tailwind v4 · shadcn/ui · Drizzle ORM

**OPUS IT Inventory** — the inventory app and its API in one codebase. It's a **dark-first
enterprise dashboard** (sidebar + top bar + content cards); visual language is defined in
[`../Design/design-system.md`](../Design/design-system.md) and realized in
[`../Design/opus-dashboard.html`](../Design/opus-dashboard.html). This doc is structure,
routes, components, data, and auth wiring.

---

## 1. App structure

```
web/
  app/
    (auth)/login/                 # unauthenticated
    (app)/                        # authenticated shell (sidebar + top bar)
      dashboard/                  # default landing — KPIs, inventory table, charts
      computers/ monitors/        # per-category list views (Printers, Phones, Network…)
      printers/ phones/ network/  #   share one CategoryTable
      software/                   # software / license inventory
      compliance/                 # BitLocker/AV/patch/local-admin state
      assets/[id]/                # deep-linkable asset detail (drawer + full page)
      scans/                      # collector runs + discovered-devices inbox
      reports/                    # warranty, aging, software, compliance
      admin/                      # users/roles (proxied to aw-auth), service accounts
      settings/                   # credential profiles, scan config, preferences
    api/
      ingest/scan/route.ts        # collector → inventory (scope ingest:write)
      assets/…                    # CRUD route handlers
      search/route.ts
    layout.tsx  globals.css
  components/
    shell/  dashboard/  table/  detail/  charts/  common/  ui/(shadcn)
  lib/
    auth/        # aw-auth SDK: middleware, verify, refresh, requirePermission
    db/          # drizzle schema + client
    api/         # typed fetchers / server actions
  middleware.ts  # session verify + refresh + route protection
```

---

## 2. Routes & screens

| Route | Screen | Notes |
|---|---|---|
| `/login` | Sign in | Password + MFA challenge; talks to `aw-auth` |
| `/dashboard` | **Overview & Inventory** (default) | KPI cards · filterable asset table · distribution + status charts |
| `/computers` `/monitors` `/printers` `/phones` `/network` | Category views | Full-height `CategoryTable` with saved filters + columns per type |
| `/software` | Software inventory | Installed apps/versions across the fleet (license audit) |
| `/compliance` | Compliance | BitLocker / AV / patch / local-admin exceptions |
| `/assets/[id]` | Asset detail | Drawer over any list + a deep-linkable full page; metadata, live-scan health, audit, label |
| `/scans` | Scans & discovery | Run history, per-run report, **discovered-devices inbox** |
| `/reports` | Reports | Warranty expiry, aging, software/license, compliance, file-check hits |
| `/admin` | Admin | Users & roles (via aw-auth), service-account (collector key) management |
| `/settings` | Settings | Credential profiles, scan schedules/rules, theme |

RBAC gates routes: `/admin` requires `user:admin`; write actions require `asset:write`;
`/scans`,`/compliance` require `scan:read`.

---

## 3. The dashboard (primary surface)

Matches `opus-dashboard.html`. Persistent **shell** = left **sidebar** (logo, nav groups,
"Collector online" status footer) + sticky **top bar** (global search, theme toggle, mail,
notifications badge, user chip). Content, top to bottom:

1. **Page head** — "IT Asset Management: **Overview & Inventory**" + **Quick Actions**.
2. **KPI row** (4 cards) — Total IT Assets (+ delta), Computers, Monitors,
   Printers/Phones, each with a tinted teal icon and a sub-line (delta or count).
3. **Inventory table card**:
   - Toolbar: **Asset Type / Location / Status / Department** filter dropdowns +
     **Add Asset**, **Export**, **Scan QR**.
   - Columns: Asset ID (sortable) · Asset Name (type icon + name) · Type · Serial (mono) ·
     Model · Assigned To (avatar) · Location · **Status** (dot + label: Deployed / Maintenance /
     Online / Storage) · Last Sync · row `⋮` menu.
   - Row click → asset detail drawer (URL-synced for deep-linking).
   - **Virtualized** for thousands of rows; server-side sort/filter/paginate.
4. **Analytics row** — **Asset Distribution** donut (Computers/Monitors/Printers/Phones)
   + **Asset Status** bars (Active / Maintenance / Storage).

**Asset detail** (drill-in) — asset identity + status; Model / Serial / Assigned To /
Location / Purchase / Warranty / Vendor / Cost center; **live-scan health** (storage ring +
Disk/RAM/Uptime sparklines) when linked to a `machine`; **audit history**; actions
(Edit, Print label, Reassign).

---

## 4. Component inventory

| Component | Purpose |
|---|---|
| `AppShell` (`Sidebar` + `TopBar`) | Persistent nav, global search, user/notifications, theme toggle |
| `KpiCard` | Metric label + icon + big number + delta/sub-line |
| `AssetTable` / `CategoryTable` | Virtualized, server-sortable table with toolbar filters |
| `StatusBadge` | Dot + label per state (Deployed/Maintenance/Online/Storage) |
| `AssigneeCell` | Avatar (initials/gradient) or neutral pool marker |
| `AssetDetail` (drawer + page) | Metadata, health, audit, actions |
| `HealthRing` + `Sparkline` | Storage ring + disk/RAM/uptime trends from snapshots |
| `DonutChart` / `StatusBars` | Dashboard analytics (recharts or CSS/SVG) |
| `CommandPalette` | ⌘K global search + actions |
| `AssetForm` | Create/edit (drawer or page) |
| `CsvImport` | Bulk import with column mapping + validation preview |
| `DiscoveredInbox` | Unmatched scans → link/create/ignore |
| `Filters` (`FilterSelect`) | Type, status, location, department |
| `ThemeToggle` | Dark (default) ⇄ light |

Built on shadcn/ui primitives (Table, Dialog, Command, DropdownMenu, Tabs, Badge, Sheet,
Select), **restyled to the OPUS design system** — not stock shadcn defaults. Icons:
`lucide-react`. Charts: `recharts` (or the CSS/SVG approach shown in the mockup).

---

## 5. Data layer

- **ORM:** Drizzle → `inventorydb`. Schema mirrors [`03-inventory-data-model.md`](03-inventory-data-model.md).
- **Reads:** React Server Components query the DB directly for the initial render (fast,
  dense screens); client interactions (filter/sort/search) use route handlers + **TanStack
  Query** for caching/optimism.
- **Writes:** Server Actions (or route handlers) for create/edit/assign/retire; each
  writes an `activity_event` and re-checks the caller's permission server-side.
- **Search:** `/api/search` over the tsvector index; debounced from the search bar and
  the command palette.
- **Ingest:** `/api/ingest/scan` validates the service-account token + scope, runs
  reconciliation, returns per-item results.

---

## 6. Auth integration (aw-auth SDK)

- `middleware.ts`: read session cookie → verify access JWT against JWKS → if expired,
  refresh (rotation) → attach `user`/`perms` to the request; unauthenticated → `/login`.
- Server helpers: `getUser()`, `requirePermission('asset:write')` for actions/routes.
- Client: a small `useUser()` / `usePermissions()` context; UI hides disallowed controls
  (but the server is the real gate).
- Login page posts to `aw-auth`; handles MFA challenge step; stores tokens in httpOnly
  cookies via a route handler.

---

## 7. Performance & UX targets

- Registry interactive in < 1s on the LAN; virtualized table handles 5k+ rows smoothly.
- Optimistic updates on assign/edit; skeleton + real empty states (not spinners only).
- Keyboard-first: `⌘K` palette, `j/k` row nav, `/` focus search, `e` edit, `Esc` close.
- Full dark mode; comfortable/compact density toggle; tabular numerals for aligned data.
- Accessible: focus rings, ARIA on table/pills/timeline, contrast ≥ WCAG AA.

---

## 8. Testing

- Component/unit: Vitest + Testing Library.
- E2E: Playwright — login, filter, create/edit asset, import CSV, resolve a discovered
  device. (Playwright skill available in this workspace.)
- Contract: a fixture that posts a sample ingest payload and asserts reconciliation.
