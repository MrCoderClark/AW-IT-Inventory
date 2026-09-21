/**
 * Table column configuration: the code-owned catalog, defaults, and render rule
 * shared by the server (validation + read) and the client (the picker + the
 * table). Pure and dependency-free so both sides import it (spec 11).
 *
 * A "view" is one of the seven configurable asset tables. Each view has a
 * catalog (what columns it may show) and a default (what it shows when no row is
 * saved). A saved row is a subset of the catalog in a chosen order; on render it
 * is always filtered back through the catalog, and Name + Actions are forced, so
 * stored data and code can never drift into a broken table.
 */

export const COLUMN_VIEWS = [
  "computer",
  "monitor",
  "printer",
  "phone",
  "network",
  "dashboard",
  "location",
] as const;

export type ColumnView = (typeof COLUMN_VIEWS)[number];

export type ColumnId =
  | "id"
  | "name"
  | "type"
  | "serial"
  | "model"
  | "assignee"
  | "location"
  | "status"
  | "lastSync"
  | "ip"
  | "mac"
  | "phoneNumber"
  | "reachability"
  | "actions";

/** Always shown, never removable, and pinned: Name first, Actions last (AC-4). */
export const LOCKED_FIRST: ColumnId = "name";
export const LOCKED_LAST: ColumnId = "actions";

export function isLockedColumn(id: ColumnId): boolean {
  return id === LOCKED_FIRST || id === LOCKED_LAST;
}

/** Human labels for the picker; match the table header text. */
export const COLUMN_LABELS: Record<ColumnId, string> = {
  id: "Asset ID",
  name: "Asset Name",
  type: "Type",
  serial: "Serial Number",
  model: "Model",
  assignee: "Assigned To",
  location: "Location",
  status: "Status",
  lastSync: "Last Sync",
  ip: "IP Address",
  mac: "MAC",
  phoneNumber: "Phone",
  reachability: "Reachability",
  actions: "Actions",
};

/** The shared columns every view can show (plus the locked Name and Actions). */
const SHARED: ColumnId[] = [
  "id",
  "name",
  "model",
  "serial",
  "assignee",
  "location",
  "status",
  "lastSync",
  "actions",
];

/** What each view may show. Category catalogs add that type's identifier
   columns; the mixed views (dashboard, location) add Type instead (AC-3). */
const CATALOGS: Record<ColumnView, ColumnId[]> = {
  computer: [...SHARED, "ip"],
  monitor: SHARED,
  printer: [...SHARED, "ip", "reachability"],
  network: [...SHARED, "ip", "mac"],
  phone: [...SHARED, "phoneNumber"],
  dashboard: [...SHARED, "type"],
  location: [...SHARED, "type"],
};

/** What each view shows when no row is saved: exactly today's hardcoded columns
   (`columnsFor(type)` for a category, `allColumns` for the mixed views), so
   nothing changes until an admin opts in (AC-2). */
const DEFAULTS: Record<ColumnView, ColumnId[]> = {
  computer: ["id", "name", "model", "serial", "ip", "assignee", "location", "status", "lastSync", "actions"],
  monitor: ["id", "name", "model", "serial", "assignee", "location", "status", "actions"],
  printer: ["id", "name", "model", "serial", "ip", "reachability", "location", "status", "lastSync", "actions"],
  network: ["id", "name", "model", "serial", "ip", "mac", "location", "status", "actions"],
  phone: ["id", "name", "model", "serial", "phoneNumber", "assignee", "location", "status", "actions"],
  dashboard: ["id", "name", "type", "serial", "model", "assignee", "location", "status", "lastSync", "actions"],
  location: ["id", "name", "type", "serial", "model", "assignee", "location", "status", "lastSync", "actions"],
};

export function isColumnView(value: unknown): value is ColumnView {
  return (
    typeof value === "string" &&
    (COLUMN_VIEWS as readonly string[]).includes(value)
  );
}

export function catalogFor(view: ColumnView): ColumnId[] {
  return CATALOGS[view];
}

export function defaultsFor(view: ColumnView): ColumnId[] {
  return DEFAULTS[view];
}

/** The mixed views drop the Assigned To column dynamically when nothing shown is
   ever assigned to a person; category views never do (AC-7 note). Only relevant
   when there is no saved row. */
function isMixedView(view: ColumnView): boolean {
  return view === "dashboard" || view === "location";
}

/**
 * The render rule (AC-2, AC-6). Produce the final ordered, deduped column ids for
 * a view:
 *  - a saved row (even an empty one) is authoritative; `null` means no row, so
 *    fall back to the code defaults;
 *  - with no saved row, the mixed views preserve today's "drop Assigned To when
 *    none is assigned" behavior (`anyAssignee`);
 *  - every id is filtered through the view's catalog (an id no longer in the
 *    catalog is silently dropped, so a stale stored id can't break the table);
 *  - Name is always present (injected first if missing) and Actions is always
 *    last, so an empty or all-removed saved array still yields a usable table.
 */
export function resolveColumns(
  view: ColumnView,
  saved: string[] | null,
  opts: { anyAssignee?: boolean } = {},
): ColumnId[] {
  const catalog = catalogFor(view);

  let base: string[];
  if (saved !== null) {
    base = saved;
  } else {
    base = [...defaultsFor(view)];
    if (isMixedView(view) && opts.anyAssignee === false) {
      base = base.filter((id) => id !== "assignee");
    }
  }

  const seen = new Set<string>();
  const ids: ColumnId[] = [];
  for (const id of base) {
    if (seen.has(id)) continue;
    if (!(catalog as string[]).includes(id)) continue;
    seen.add(id);
    ids.push(id as ColumnId);
  }

  // Locked columns: Name present (first if missing), Actions always last.
  if (!ids.includes(LOCKED_FIRST)) ids.unshift(LOCKED_FIRST);
  const withoutActions = ids.filter((id) => id !== LOCKED_LAST);
  return [...withoutActions, LOCKED_LAST];
}

/**
 * Sanitize a submitted list before storing it (the Server Action trust
 * boundary, AC-6): drop ids outside the catalog, dedupe, and force the locked
 * columns. Reuses the render rule so what is stored is exactly what renders.
 */
export function sanitizeColumns(view: ColumnView, ids: unknown): ColumnId[] {
  const list = Array.isArray(ids)
    ? ids.filter((x): x is string => typeof x === "string")
    : [];
  return resolveColumns(view, list);
}
