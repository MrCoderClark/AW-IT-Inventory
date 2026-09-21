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

export const computerDetails = pgTable("computer_details", {
  assetId: uuid("asset_id")
    .primaryKey()
    .references(() => assets.id, { onDelete: "cascade" }),
  formFactor: text("form_factor"), // laptop | desktop | all-in-one | tower
  operatingSystem: text("operating_system"),
  cpu: text("cpu"),
  ramGb: integer("ram_gb"),
  storage: text("storage"),
});

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
