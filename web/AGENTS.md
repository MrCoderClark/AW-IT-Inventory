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
