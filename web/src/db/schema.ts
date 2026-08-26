import { date, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
  location: text("location"),
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

export type AssetRow = typeof assets.$inferSelect;
export type PersonRow = typeof people.$inferSelect;
