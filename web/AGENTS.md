<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Web app conventions

## Configurable table columns (spec 11)

Every asset table column has a stable string id. The code owns three things,
kept in one pure module `src/lib/table-columns.ts` (imported by both the server
and the client): the per view catalog (what a view may show), the per view
defaults (today's hardcoded columns), and the render rule `resolveColumns`
(a saved layout wins over defaults, is filtered back through the catalog, and
always forces Name first and Actions last). Column cells are registered by id in
`COLUMN_REGISTRY` in `src/components/asset-table.tsx`; `AssetTable` takes a
`view` plus a `columnOrder` and resolves the columns from them. To add a column:
add its id and `ColumnDef` to the registry, then add the id to the right
`catalogFor` / `defaultsFor` entries.

Editing a shared layout is gated on the `columns:write` permission; reading is
open to any `asset:read` viewer (there is one shared layout per view). The write
path is `src/app/(app)/columns-actions.ts` (`saveColumnConfig` /
`resetColumnConfig`), which re-validates the submitted ids against the catalog
before writing. Layouts persist in the `table_column_config` table, one row per
view. Gotcha: a newly seeded aw-auth permission only reaches a user after they
sign in again, because permissions ride the access token's `perms` claim
(restarting servers or clearing the browser cache does not refresh it).

## Discovery type toggles (spec 13)

Per type on/off switches for what the collector automatically discovers
(Computers, Printers). The code owns the settings in one `server-only` module
`src/db/discovery.ts`: `getDiscoverySettings()` reads the `discovery_settings`
table and coalesces a missing type to `true`, so an absent row means on and the
empty table means "discover everything" (no seeding). `setDiscoveryToggle()`
upserts one row. The device type union and the `isDiscoveryType` guard live here
too; add a new toggleable type by extending both plus the table's `$type`.

Two callers, two auth gates. Admins edit from `/admin` through the
`setDiscoveryToggleAction` server action in `src/app/(app)/discovery-actions.ts`,
gated on `scan:write` (the switches render read only for a `scan:read` viewer who
lacks it). The collector reads the switches through `GET /api/scan/discovery-settings`,
gated on the service `scan:dequeue` scope, same token path as the other
`/api/scan/*` routes. The switches govern only the automatic sweep; manual scan
jobs never read them.

The `Switch` UI primitive (`src/components/ui/switch.tsx`) is the Base UI toggle
in the shadcn Nova style. Note for tests: it renders a `role="switch"` element
and uses `aria-disabled`, not the native `disabled` attribute, when disabled.

## Printer reachability + alerting (spec 12)

The collector `worker` runs an in-process APScheduler that checks every
manually-entered printer three times a day (a TCP probe, plus a full SNMP collect
on the first check) and posts the results to the web app. Three service endpoints
serve it, all gated on the service `scan:dequeue` scope (same token path as the
other `/api/scan/*` routes): `GET /api/scan/printers` (the targets to probe),
`POST /api/scan/reachability` (record checks), `POST /api/scan/reachability/prune`
(retention). The web app never connects into the fleet; the worker pulls and pushes.

The reachability engine is one `server-only` module `src/db/reachability.ts`. A
printer is "down" exactly when `printer_status.consecutiveFailures >= 2`.
`recordChecks` writes each check and the rollup in a transaction and returns the
up/down transitions to alert on; the route then fires the email and calls
`markAlertSent`. Key rule: `lastAlertState` is advanced only AFTER a successful
send, so a failed send leaves the transition pending and the next check retries it
(one down email per episode, one recovery email, no duplicates while down). The
UI read helpers (`getPrinterReachabilityMap`, `getPrinterReachability`) live in
`src/db/queries.ts`.

Alerting is the one web -> aw-auth call in the app: web detects the transition (it
holds the history) and `src/lib/notify.ts` posts to aw-auth's
`/v1/notify/printer-alert` with the `opus-web` service account (client-credentials,
scope `notify:send`; creds in `web/.env` as `OPUS_WEB_CLIENT_ID` /
`OPUS_WEB_CLIENT_SECRET`). Gotcha: aw-auth returns HTTP 200 with a `{ sent }` body
even when the underlying Resend send failed, so `notify.ts` keys success on
`sent === true`, not the status code (otherwise a failed delivery is silently
dropped instead of retried).

The printers table gains a `reachability` column (a normal spec-11 catalog +
defaults entry) rendered by `ReachabilityBadge`; the printer detail page shows the
badge plus recent check history.

## Testing note: `server-only` under Vitest

`vitest.config.mts` aliases `server-only` to a no-op stub
(`src/test/empty-module.ts`) so a server module (a `src/db/*` helper) can be
imported directly in a test. Mock its real boundary (`@/db/index`, the auth
session, `next/cache`) as the existing action and db tests do.
