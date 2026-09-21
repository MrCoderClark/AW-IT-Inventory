import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const assetType = pgEnum("asset_type", [
  "Computer",
  "Monitor",
  "Printer",
  "Phone",
  "Network",
]);

export const assetStatus = pgEnum("asset_status", [
  "deployed",
  "maintenance",
  "online",
  "storage",
]);

export const people = pgTable("people", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  initials: text("initials").notNull(),
  email: text("email"),
});

// A node in the location tree (adjacency list). `parentId` null = a top-level
// location; otherwise it points at its parent. Depth is unbounded. Devices are
// assigned to a *leaf* (a row that is nobody's parent) via `assets.locationId`.
export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Self-FK. `restrict` so a parent can't be deleted out from under its
    // children (the delete action blocks until empty before we get here).
    parentId: uuid("parent_id").references((): AnyPgColumn => locations.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // Siblings can't share a name. Postgres treats NULLs as distinct, so this
    // constraint covers the non-null-parent case only...
    uniqueIndex("locations_parent_name_uq").on(t.parentId, t.name),
    // ...and this partial index covers two top-level locations sharing a name.
    uniqueIndex("locations_root_name_uq")
      .on(t.name)
      .where(sql`${t.parentId} is null`),
  ],
);

export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  tag: text("tag").notNull().unique(), // human key, e.g. OPUS-COMP-7491
  name: text("name").notNull(),
  type: assetType("type").notNull(),
  serial: text("serial"),
  model: text("model"),
  assigneeId: uuid("assignee_id").references(() => people.id, {
    onDelete: "set null",
  }),
  // Nullable FK to a *leaf* location (the leaf-only rule is an app invariant the
  // asset actions enforce; a plain FK can't express it). `restrict` so a
  // location holding devices can't be deleted until they're reassigned.
  locationId: uuid("location_id").references(() => locations.id, {
    onDelete: "restrict",
  }),
  status: assetStatus("status").notNull(),
  lastSync: timestamp("last_sync", { withTimezone: true }),
  vendor: text("vendor"),
  purchaseDate: date("purchase_date"),
  warrantyUntil: date("warranty_until"),
  costCenter: text("cost_center"),
  spec: text("spec"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Live scanned machine (from the collector). Linked to an asset once matched,
// otherwise a "discovered" device (assetId null).
export const machines = pgTable("machines", {
  id: uuid("id").primaryKey().defaultRandom(),
  matchKey: text("match_key").notNull().unique(), // hardware_uuid | serial | hostname | ip
  assetId: uuid("asset_id").references(() => assets.id, {
    onDelete: "set null",
  }),
  kind: text("kind").notNull().default("unknown"), // windows | printer | unknown
  hostname: text("hostname"),
  ip: text("ip"),
  subnet: text("subnet"),
  serial: text("serial"),
  hardwareUuid: text("hardware_uuid"),
  osName: text("os_name"),
  osVersion: text("os_version"),
  osBuild: text("os_build"),
  hardware: jsonb("hardware"),
  health: jsonb("health"),
  printer: jsonb("printer"),
  credentialProfile: text("credential_profile"),
  lastScanStatus: text("last_scan_status"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  // Discovered-devices inbox: null = active (in the inbox), set = dismissed.
  // Never touched by the ingest upsert, so ignore survives re-scans.
  ignoredAt: timestamp("ignored_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Per-type detail tables (spec 10). Each is 1:1 with an asset: `assetId` is both
// the primary key and a foreign key to `assets.id` with `onDelete: cascade`, so a
// detail row is created on first save and removed when its asset is deleted. Only
// the asset's own type ever has a row here. All fields are nullable except a
// printer's `ipAddress`, which a printer must have.

export const computerDetails = pgTable(
  "computer_details",
  {
    assetId: uuid("asset_id")
      .primaryKey()
      .references(() => assets.id, { onDelete: "cascade" }),
    // Optional: a manually-entered target IP so a computer can be scanned before
    // the collector has discovered it (spec 12). The scan resolver prefers this
    // over the discovered `machines.ip`.
    ipAddress: text("ip_address"),
    formFactor: text("form_factor"), // laptop | desktop | all-in-one | tower
    operatingSystem: text("operating_system"),
    cpu: text("cpu"),
    ramGb: integer("ram_gb"),
    storage: text("storage"),
  },
  (t) => [index("computer_details_ip_idx").on(t.ipAddress)],
);

export const monitorDetails = pgTable("monitor_details", {
  assetId: uuid("asset_id")
    .primaryKey()
    .references(() => assets.id, { onDelete: "cascade" }),
  sizeInches: numeric("size_inches"),
  resolution: text("resolution"),
  panelType: text("panel_type"), // IPS | VA | OLED | TN
  refreshHz: integer("refresh_hz"),
  ports: text("ports"),
  isCurved: boolean("is_curved"),
});

export const printerDetails = pgTable(
  "printer_details",
  {
    assetId: uuid("asset_id")
      .primaryKey()
      .references(() => assets.id, { onDelete: "cascade" }),
    ipAddress: text("ip_address").notNull(), // required for printers
    colorMode: text("color_mode"), // mono | color
    isDuplex: boolean("is_duplex"),
    pageCount: integer("page_count"),
    connection: text("connection"), // network | USB
    mgmtUrl: text("mgmt_url"),
  },
  (t) => [index("printer_details_ip_idx").on(t.ipAddress)],
);

export const phoneDetails = pgTable(
  "phone_details",
  {
    assetId: uuid("asset_id")
      .primaryKey()
      .references(() => assets.id, { onDelete: "cascade" }),
    imei: text("imei"),
    phoneNumber: text("phone_number"),
    carrier: text("carrier"),
    storageGb: integer("storage_gb"),
    os: text("os"), // iOS | Android
    plan: text("plan"),
  },
  (t) => [
    index("phone_details_imei_idx").on(t.imei),
    index("phone_details_number_idx").on(t.phoneNumber),
  ],
);

export const networkDetails = pgTable(
  "network_details",
  {
    assetId: uuid("asset_id")
      .primaryKey()
      .references(() => assets.id, { onDelete: "cascade" }),
    ipAddress: text("ip_address"),
    macAddress: text("mac_address"),
    deviceRole: text("device_role"), // switch | router | access-point | firewall
    portCount: integer("port_count"),
    firmware: text("firmware"),
    mgmtUrl: text("mgmt_url"),
  },
  (t) => [
    index("network_details_ip_idx").on(t.ipAddress),
    index("network_details_mac_idx").on(t.macAddress),
  ],
);

// Global, per-view table column layout (spec 11). One row per configurable view,
// keyed by `column_view`; `columns` is an ordered array of stable column id
// strings. Additive: no existing table is touched. NOT NULL is safe because the
// table is brand new (no rows to backfill). Absent row = the view falls back to
// the code-owned default columns, so behavior is unchanged until an admin saves.
export const columnView = pgEnum("column_view", [
  "computer",
  "monitor",
  "printer",
  "phone",
  "network",
  "dashboard",
  "location",
]);

export const tableColumnConfig = pgTable("table_column_config", {
  viewKey: columnView("view_key").primaryKey(),
  columns: jsonb("columns").$type<string[]>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ── Scheduled and manual scans (spec 12) ─────────────────────────────────────
// Four additive tables. All brand new (no rows to backfill), so NOT NULL columns
// are safe. See docs/specs/12-scheduled-manual-scans/index.md for the contract.

// Fixed shape of a finished job's `result`. Per-target status is recorded here so
// an unreachable target never fails the job (only a worker-level error does).
export type ScanJobResult = {
  matched: number;
  discovered: number;
  upserted: number;
  skipped: number;
  targets: { ip: string; status: string }[];
};

// The manual scan queue. An admin enqueues a job (single computer, several
// selected computers, or every known device); the worker claims exactly one
// pending job atomically, runs it, posts results through /api/ingest/scan, then
// marks it succeeded (or failed only on a worker-level error). `targets` is a
// frozen, de-duplicated list of IP strings snapshotted at creation, so an "all"
// job scans the device set as of enqueue time, not run time. `scope`/`status`
// are plain text (not pg enums) so drizzle-kit push never needs an enum
// migration to add a state; the union `$type` keeps them type-safe in TS.
export const scanJobs = pgTable(
  "scan_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").$type<"all" | "selected">().notNull(),
    targets: jsonb("targets").$type<string[]>().notNull(),
    status: text("status")
      .$type<
        "pending" | "claimed" | "running" | "succeeded" | "failed" | "canceled"
      >()
      .notNull()
      .default("pending"),
    // User email from the access token; no FK, users live in aw-auth.
    requestedBy: text("requested_by").notNull(),
    workerId: text("worker_id"), // the worker that currently holds the claim
    runId: text("run_id"), // the ingest run id the results were posted under
    result: jsonb("result").$type<ScanJobResult>(),
    error: text("error"), // worker-level error message when status = failed
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // The claim query polls every few seconds; a partial index over just the
    // pending rows keeps the "oldest pending" lookup cheap as finished jobs pile up.
    index("scan_jobs_pending_idx")
      .on(t.status, t.requestedAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

// Reachability history: one row per printer check (scheduled or manual).
export const printerChecks = pgTable(
  "printer_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    ipAddress: text("ip_address").notNull(), // snapshot of the IP checked
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    reachable: boolean("reachable").notNull(),
    latencyMs: integer("latency_ms"),
    method: text("method").$type<"tcp" | "snmp">().notNull(),
    source: text("source").$type<"scheduled" | "manual">().notNull(),
  },
  (t) => [
    index("printer_checks_asset_checked_idx").on(t.assetId, t.checkedAt.desc()),
  ],
);

// Current reachability rollup plus alert state, 1:1 with a printer asset. Stores
// derived values (consecutiveFailures/isDown/lastAlertState) deliberately: once-
// only alert emails need a persisted last-alerted state.
export const printerStatus = pgTable("printer_status", {
  assetId: uuid("asset_id")
    .primaryKey()
    .references(() => assets.id, { onDelete: "cascade" }),
  reachable: boolean("reachable"), // last known
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastReachableAt: timestamp("last_reachable_at", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  isDown: boolean("is_down").notNull().default(false),
  downSince: timestamp("down_since", { withTimezone: true }),
  // dedupe key for alert emails: exactly one down email per down episode, one
  // recovery email per recovery.
  lastAlertState: text("last_alert_state")
    .$type<"up" | "down">()
    .notNull()
    .default("up"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Worker heartbeat, so the jobs view can tell whether a worker is polling.
export const scanWorkers = pgTable("scan_workers", {
  workerId: text("worker_id").primaryKey(),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }).notNull(),
  version: text("version"),
});

export type AssetRow = typeof assets.$inferSelect;
export type PersonRow = typeof people.$inferSelect;
export type MachineRow = typeof machines.$inferSelect;
export type LocationRow = typeof locations.$inferSelect;
export type ComputerDetailsRow = typeof computerDetails.$inferSelect;
export type MonitorDetailsRow = typeof monitorDetails.$inferSelect;
export type PrinterDetailsRow = typeof printerDetails.$inferSelect;
export type PhoneDetailsRow = typeof phoneDetails.$inferSelect;
export type NetworkDetailsRow = typeof networkDetails.$inferSelect;
export type TableColumnConfigRow = typeof tableColumnConfig.$inferSelect;
export type ScanJobRow = typeof scanJobs.$inferSelect;
export type PrinterCheckRow = typeof printerChecks.$inferSelect;
export type PrinterStatusRow = typeof printerStatus.$inferSelect;
export type ScanWorkerRow = typeof scanWorkers.$inferSelect;
