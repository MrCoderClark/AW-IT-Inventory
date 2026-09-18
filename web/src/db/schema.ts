import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  date,
  jsonb,
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

export type AssetRow = typeof assets.$inferSelect;
export type PersonRow = typeof people.$inferSelect;
export type MachineRow = typeof machines.$inferSelect;
export type LocationRow = typeof locations.$inferSelect;
