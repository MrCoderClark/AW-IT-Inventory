# OPUS scope

The living, coarse scope for OPUS. Each feature is a milestone rollup, not a task
dump: the atomic build steps stay in each feature's spec (`docs/specs/`). Run
`/scope` to reconcile this against what has shipped and to enroll the next slice.

> This file was seeded by `/architect` when spec 11 was captured. Specs 00 to 10
> predate it and are tracked directly by their own specs; `/scope` will backfill
> them on its next reconcile if wanted.

## At a glance

| Feature | Status | Spec |
|---|---|---|
| Global table column configuration | done | [11](../specs/11-table-column-config/index.md) |

## Features

### Global table column configuration · done

Let admins choose which columns each asset table shows, and in what order, saved
once and seen by everyone, across the five category pages, the dashboard, and the
location device pages.

**Done when**: an admin with `columns:write` can add, remove, and reorder columns
on any of the seven views from a toolbar picker; the choice is saved globally and
every user sees it; a view with no saved layout renders exactly today's columns.

- [x] Design it (spec): [11](../specs/11-table-column-config/index.md)
- [x] Build it: `/develop table column config` — code in `web/src/lib/table-columns.ts`,
      `web/src/components/{asset-table,column-picker-dialog}.tsx`,
      `web/src/app/(app)/columns-actions.ts`, `web/src/db/{schema,queries}.ts`,
      `aw-auth/rbac/management/commands/seed_rbac.py`
  - [x] Foundations: the `table_column_config` table and enum, and the
        `columns:write` permission in the aw-auth seed (covers AC-1, AC-8)
        — `db:push` and `seed_rbac` applied; confirmed live in `/check verify`
        (pages read the table, saves persist, the permission gates the picker
        after re-login).
  - [x] Column engine: stable column ids, the code-owned catalog and defaults, and
        the `AssetTable` render rule (saved list over defaults) (covers AC-2, AC-3,
        AC-6)
  - [x] Read + write path: `getColumnConfig`, the gated save and reset actions, and
        one view wired end to end (covers AC-2, AC-5, AC-6)
  - [x] Picker UI: the "Columns" toolbar button and dialog (toggle, reorder, save,
        reset), shown only to `columns:write` admins (covers AC-4, AC-5)
  - [x] Widen: the remaining six views plus a regression pass over search, filters,
        sorting, pagination, and row-click (covers AC-2, AC-7)
- [x] Verify it: `/check verify table column config`
- [x] Test it: `/test table column config` — 50 tests in `table-columns.test.ts`,
      `columns-actions.test.ts`, `column-picker-dialog.test.tsx` (full suite: 171 pass)
