import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
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

// Directory of the staff who use the fleet (spec 16). People live in the
// inventory DB and carry no aw-auth login link — a fleet has far more employees
// than login accounts. Extended from the original three columns (id, name,
// initials, email) into a managed directory: `initials` is always derived from
// `name` on write (not user-entered); `email` and `employeeId` are unique when
// present (case-insensitively for email); `status` is a real lifecycle state
// (archive on offboarding, keeping the person and their history while their
// devices return to the pool). The new columns carry defaults, so the existing
// seed rows backfill cleanly.
export const peopleStatus = pgEnum("people_status", ["active", "archived"]);

export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    initials: text("initials").notNull(), // derived from `name` on write
    email: text("email"),
    department: text("department"),
    jobTitle: text("job_title"),
    phone: text("phone"),
    employeeId: text("employee_id"),
    // A person may sit at ANY location node, not just a leaf (unlike a device).
    // `set null` so archiving/removing a location never blocks on people.
    officeLocationId: uuid("office_location_id").references(() => locations.id, {
      onDelete: "set null",
    }),
    status: peopleStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // Email is unique when present, compared case-insensitively; a blank (null)
    // email never collides (partial index, Postgres treats NULLs as distinct).
    uniqueIndex("people_email_lower_uq")
      .on(sql`lower(${t.email})`)
      .where(sql`${t.email} is not null`),
    // Employee id likewise unique when present.
    uniqueIndex("people_employee_id_uq")
      .on(t.employeeId)
      .where(sql`${t.employeeId} is not null`),
  ],
);

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
    // Optional geographic coordinates for the dashboard map (spec: dashboard map).
    // Null until an admin geocodes the site; only meaningful on the sites/buildings
    // an org wants to plot (a leaf room inherits its building's pin visually). Both
    // are set together or both null.
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
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

// ── Shared media library (spec 18) ───────────────────────────────────────────
// One row per distinct image, reusable across any number of assets (many assets →
// one media row via `assets.imageId`). This supersedes spec 17.02's one-object-
// per-asset model: an image is uploaded once and reused, deduped by content hash
// so the same bytes are stored once no matter how they arrive. Objects live in the
// private S3 bucket under `media/{id}/...`; bytes only reach a browser through the
// authenticated app route. "Used by N" is never stored — it is counted at read
// time from `assets.imageId`, so it can never go stale.
//
// `width`/`height`/`thumbnailKey` are created now but stay null until spec 18's
// phase 2 (sharp) backfills them, so phase 2 is a pure data migration with no DDL.
// The phase 3 cut-out columns are added by phase 3's migration, not here.
export const media = pgTable(
  "media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(), // human title, used to find and pick an image
    altText: text("alt_text"), // accessibility text for <img alt>
    notes: text("notes"), // freeform description or source
    // Stored image object key, `media/{id}/image.{ext}`. In phase 2 this object is
    // the original capped to a max dimension, so not always the exact bytes posted.
    objectKey: text("object_key").notNull(),
    thumbnailKey: text("thumbnail_key"), // phase 2: `media/{id}/thumb.webp`
    contentType: text("content_type")
      .$type<"image/png" | "image/jpeg" | "image/webp">()
      .notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    width: integer("width"), // read via sharp in phase 2; null for legacy rows
    height: integer("height"),
    // SHA-256 of the uploaded bytes: the dedup key. A partial unique index (below)
    // enforces one media row per distinct content; null is allowed (legacy rows
    // without a hash) and Postgres treats NULLs as distinct.
    sha256: text("sha256"),
    createdBy: text("created_by"), // uploader email from the access token; no FK
    // ── Background removal (spec 18, phase 3) ───────────────────────────────
    // A cut-out job follows the scan_jobs claim pattern, not a bare flag: an
    // `asset:write` user requests it (→ pending), a rembg worker claims it
    // atomically (→ processing, stamping claimedAt/workerId and bumping attempts),
    // stores the result (→ done) or fails (→ failed, retryable back to pending). A
    // job stuck in processing past a timeout is reclaimed on the next claim.
    cutoutKey: text("cutout_key"), // `media/{id}/cutout.png`; null until done
    cutoutStatus: text("cutout_status").$type<
      "pending" | "processing" | "done" | "failed"
    >(), // null = never requested
    cutoutClaimedAt: timestamp("cutout_claimed_at", { withTimezone: true }),
    cutoutWorkerId: text("cutout_worker_id"),
    cutoutAttempts: integer("cutout_attempts").notNull().default(0),
    // When true, assets that use this image display the cut-out (transparent)
    // instead of the original. Per-image (the image is shared), toggled from the
    // media detail page; only meaningful once a cut-out exists.
    preferCutout: boolean("prefer_cutout").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // At most one stored object per distinct content (AC-3). Partial so legacy
    // rows with a null hash never collide.
    uniqueIndex("media_sha256_uq")
      .on(t.sha256)
      .where(sql`${t.sha256} is not null`),
    // The library list orders newest first.
    index("media_created_idx").on(t.createdAt.desc()),
    // The cut-out worker claims the oldest pending job; a partial index keeps that
    // lookup cheap.
    index("media_cutout_pending_idx")
      .on(t.cutoutStatus, t.updatedAt)
      .where(sql`${t.cutoutStatus} = 'pending'`),
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
  // Shared media library reference (spec 18, superseding spec 17.02's `imageKey`):
  // many assets → one `media` row, which
  // is the reuse. `restrict` so a media row an asset still uses can never be
  // deleted out from under it (the delete path enforces "unused" first; this is
  // the hard backstop). Null = no image → the UI renders the type icon.
  imageId: uuid("image_id").references(() => media.id, { onDelete: "restrict" }),
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

// ── Remote printer install (spec 20) ─────────────────────────────────────────
// One job per "install this printer on that computer" request. Same claim /
// fenced-status / reaper machinery as `scan_jobs`; the worker pulls the job and
// the driver bundle, installs over WinRM/SMB, and posts the result back.
export type PrinterInstallConnection =
  | { type: "tcpip"; host: string; port?: number; replace?: boolean }
  | { type: "wsd"; host?: string }
  | { type: "share"; sharePath: string };

// Frozen at enqueue so a later manifest edit never changes a queued job.
export type PrinterPackageSnapshot = {
  driverName: string;
  infPath: string;
  arch: string;
  sha256: string; // content hash of the package file tree (see printer-packages.ts)
};

export type PrinterInstallStep = {
  name: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

/** One printer as it exists on a target computer (live Get-Printer snapshot). */
export type InstalledPrinter = {
  name: string;
  driverName: string;
  portName: string;
  hostAddress: string | null; // the port's TCP/IP address, when it's a TCP port
  shared: boolean;
  isDefault: boolean;
};

export type PrinterInstallResult = {
  outcome:
    | "installed"
    | "already-present"
    | "verify-failed"
    | "listed"
    | "removed";
  steps: PrinterInstallStep[];
  verifiedPrinter?: {
    name: string;
    driverName: string;
    portName: string;
  } | null;
  // Populated for a `list` op: the printers found on the computer.
  printers?: InstalledPrinter[];
};

export const printerInstallJobs = pgTable(
  "printer_install_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The target computer asset. Cascade so deleting the computer clears its jobs.
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    targetIp: text("target_ip").notNull(), // snapshot of computer_details.ip_address
    // What the worker should do. `install` carries package + connection; `list`
    // enumerates the computer's printers; `remove` deletes one by name.
    action: text("action")
      .$type<"install" | "list" | "remove">()
      .notNull()
      .default("install"),
    packageId: text("package_id"), // catalog slug (install only)
    packageSnapshot: jsonb("package_snapshot").$type<PrinterPackageSnapshot>(),
    printerName: text("printer_name"), // install: new name; remove: name to delete
    connection: jsonb("connection").$type<PrinterInstallConnection>(),
    // Set when prefilled from a printer asset (informational); null otherwise.
    sourcePrinterAssetId: uuid("source_printer_asset_id").references(
      () => assets.id,
      { onDelete: "set null" },
    ),
    status: text("status")
      .$type<
        "pending" | "claimed" | "running" | "succeeded" | "failed" | "canceled"
      >()
      .notNull()
      .default("pending"),
    // Admin email from the access token; no FK (users live in aw-auth).
    requestedBy: text("requested_by").notNull(),
    workerId: text("worker_id"),
    result: jsonb("result").$type<PrinterInstallResult>(),
    error: text("error"),
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
    // Cheap "oldest pending" claim poll (mirrors scan_jobs_pending_idx).
    index("printer_install_jobs_pending_idx")
      .on(t.status, t.requestedAt)
      .where(sql`${t.status} = 'pending'`),
    // History panel reads the newest jobs for one computer.
    index("printer_install_jobs_asset_idx").on(t.assetId, t.requestedAt),
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

// ── Discovery type toggles (spec 13) ─────────────────────────────────────────
// Per-type on/off switches for what the collector automatically discovers. One
// row per toggleable device type. An ABSENT row means "on", so the empty table
// equals "discover everything" and no seeding is needed (AC-2); reads coalesce a
// missing type to true. `deviceType` is plain text with a union `$type` (not a
// pg enum) so adding a future type never needs an enum migration.
export const discoverySettings = pgTable("discovery_settings", {
  deviceType: text("device_type").$type<"computer" | "printer">().primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ── Printer page counter (spec 14) ───────────────────────────────────────────
// One daily snapshot of a printer's total page (life) counter, filled from the
// SNMP counter that already rides the ingest. One row per printer per calendar
// day (the latest read of the day wins), so the table stays tiny while still
// giving a real day-over-day delta and a year of history. Additive and brand new
// (no rows to backfill), so the NOT NULL columns are safe. `source` is plain text
// with a union `$type` (not a pg enum) so a future source never needs a migration.
// The latest total, the delta and the daily report are all computed from this
// history; there is no rollup table. This live SNMP meter is now the only page
// count a printer has (the old manual `printer_details.pageCount` was removed).
export const printerCounters = pgTable(
  "printer_counters",
  {
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    // Calendar day in the schedule timezone; the latest read of the day wins.
    readingDate: date("reading_date").notNull(),
    totalPages: integer("total_pages").notNull(), // the life counter read that day
    lastReadAt: timestamp("last_read_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    source: text("source").$type<"scheduled" | "manual">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // One snapshot per printer per day; makes the daily upsert idempotent.
    primaryKey({ columns: [t.assetId, t.readingDate] }),
    // Serves the latest total, the delta, and the recent-history read.
    index("printer_counters_asset_date_idx").on(
      t.assetId,
      t.readingDate.desc(),
    ),
  ],
);

// ── Software inventory (spec 15) ─────────────────────────────────────────────
// A small, admin-managed watchlist of software titles (`tracked_software`) and
// the current tracked-software matches per Computer asset (`installed_software`).
// Both are additive and brand new (no rows to backfill), so NOT NULL columns are
// safe. The watchlist is read at ingest to filter each machine's installed
// programs to the tracked titles; matches are stored as current state per
// Computer asset (deleted and reinserted on each Windows scan of that asset, no
// history), keyed on `assetId` like `printer_counters`.

// The watchlist: admin-chosen titles, each also its case-insensitive "contains"
// match term. Unique on `lower(name)` so a title can't be added twice in a
// different case. Managed on /admin, gated on `scan:write`.
export const trackedSoftware = pgTable(
  "tracked_software",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(), // the tracked title AND the match term
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("tracked_software_name_lower_uq").on(sql`lower(${t.name})`),
  ],
);

// Current tracked software found on a Computer asset. Only Computer assets ever
// get rows (enforced at ingest). A row is the actual DisplayName found, tied back
// to the watchlist title it matched. Full-replaced per asset on each scan, so no
// timestamps beyond `lastSeenAt` (the scan that recorded it).
export const installedSoftware = pgTable(
  "installed_software",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    trackedId: uuid("tracked_id")
      .notNull()
      .references(() => trackedSoftware.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // the actual DisplayName, e.g. "Google Chrome"
    version: text("version"),
    publisher: text("publisher"),
    installDate: text("install_date"), // registry value is a string, stored as-is
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    // One row per (asset, tracked title, exact program, version).
    uniqueIndex("installed_software_asset_tracked_name_version_uq").on(
      t.assetId,
      t.trackedId,
      t.name,
      t.version,
    ),
    // Serves the per-title drill-down and the /software aggregate.
    index("installed_software_tracked_idx").on(t.trackedId),
    // Serves the full-replace-per-asset delete and the detail-page panel.
    index("installed_software_asset_idx").on(t.assetId),
  ],
);

// ── Compliance / device health posture (spec 21) ─────────────────────────────
// Current security-posture signals per Computer asset — no history in v1 (like
// installed_software / printer_counters). Values are stored exactly as the
// collector observed them; a NULL means "unknown" (the signal was unreadable,
// e.g. BitLocker/TPM on a UAC-filtered token). The health score and the
// 🟢/🟡/🔴 verdicts are DERIVED at read time (src/lib/compliance-score.ts), never
// stored, so the rubric can change with no migration.
export const complianceStatus = pgTable("compliance_status", {
  // 1:1 with the asset; PK = assetId, so an upsert replaces the latest state.
  assetId: uuid("asset_id")
    .primaryKey()
    .references(() => assets.id, { onDelete: "cascade" }),
  bitlocker: text("bitlocker"), // "on" | "off" | null=unknown (system drive)
  defenderRealtime: boolean("defender_realtime"), // real-time protection on?
  defenderSigAgeDays: integer("defender_sig_age_days"),
  avProduct: text("av_product"), // Defender or 3rd-party product name
  tpmReady: boolean("tpm_ready"), // present AND ready
  secureBoot: text("secure_boot"), // "on" | "off" | null
  updatesLastDays: integer("updates_last_days"), // days since last successful update
  updatesPending: integer("updates_pending"), // pending count (null in v1)
  systemDrivePctUsed: doublePrecision("system_drive_pct_used"), // % full
  assessedAt: timestamp("assessed_at", { withTimezone: true }).notNull(),
});

// ── Device assignment history (spec 16) ──────────────────────────────────────
// The custody log: one row per assignment of a device to a person. A row opens
// when a device is handed out (`assignedAt`/`assignedBy` set, `unassignedAt`
// null = current) and closes when it comes back (`unassignedAt`/`unassignedBy`
// set). This is the source of truth for history; `assets.assigneeId` is the
// denormalized "current holder", written only by the assignment engine in the
// same transaction so the two never drift (AC-11). `assignedBy`/`unassignedBy`
// record the acting admin's email from the access token (no FK — admins live in
// aw-auth, same pattern as `scan_jobs.requestedBy`).
export const assetAssignments = pgTable(
  "asset_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Device gone → its history goes with it.
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    // `restrict`: a person with any assignment history can't be deleted, only
    // archived (AC-9). The delete action pre-checks; this is the hard guarantee.
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "restrict" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    assignedBy: text("assigned_by").notNull(),
    unassignedAt: timestamp("unassigned_at", { withTimezone: true }),
    unassignedBy: text("unassigned_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // At most one OPEN assignment per device (AC-5, AC-11), enforced at the DB.
    uniqueIndex("asset_assignments_open_uq")
      .on(t.assetId)
      .where(sql`${t.unassignedAt} is null`),
    // The person timeline (their current + past devices).
    index("asset_assignments_person_idx").on(t.personId, t.assignedAt.desc()),
    // The device timeline (its custody history).
    index("asset_assignments_asset_idx").on(t.assetId, t.assignedAt.desc()),
  ],
);

// ── Notifications (spec 19) ──────────────────────────────────────────────────
// An admin-facing notification center. One row per distinct operational event
// (printer down/recovery, scan failure, newly discovered device, warranty
// expiring); every `user:admin` sees it (admin-only broadcast, no per-user
// fan-out), and `notification_reads` records who has read what so read state is
// per user. Both tables are additive and brand new (no rows to backfill), so the
// NOT NULL columns are safe. `type`/`severity` are plain text with a union `$type`
// (not pg enums) so a future event type never needs an enum migration — the same
// pattern as `scan_jobs`. Creation is idempotent on `dedupeKey` (a unique index),
// so a re-scan or a repeated daily sweep never duplicates an event.
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type")
      .$type<
        | "printer-down"
        | "printer-recovery"
        | "printer-install"
        | "printer-install-failed"
        | "scan-failed"
        | "device-discovered"
        | "warranty-expiring"
      >()
      .notNull(),
    severity: text("severity")
      .$type<"info" | "warning" | "critical">()
      .notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    // The subject asset when there is one; `set null` so deleting an asset leaves
    // the (now historical) notification rather than blocking the delete.
    assetId: uuid("asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    // The in-app link to open. Stored as text (not a live FK) so a later-deleted
    // target degrades to a dead link, never a broken row.
    href: text("href").notNull(),
    // Idempotency key (unique below): re-detecting the same event is a no-op. The
    // key encodes the episode/date so a new episode or a changed date is new.
    dedupeKey: text("dedupe_key").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("notifications_dedupe_uq").on(t.dedupeKey),
    index("notifications_created_idx").on(t.createdAt.desc()),
  ],
);

// Per-user read state: a row exists once `userKey` has read that notification.
// Unread for a user = notifications with no matching row. `userKey` is the token
// `sub` (falling back to email); no FK, users live in aw-auth (same pattern as
// `scan_jobs.requestedBy`). Cascade so retention/prune of a notification clears
// its reads.
export const notificationReads = pgTable(
  "notification_reads",
  {
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    userKey: text("user_key").notNull(),
    readAt: timestamp("read_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.notificationId, t.userKey] })],
);

export type MediaRow = typeof media.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type PersonRow = typeof people.$inferSelect;
export type AssetAssignmentRow = typeof assetAssignments.$inferSelect;
export type MachineRow = typeof machines.$inferSelect;
export type LocationRow = typeof locations.$inferSelect;
export type ComputerDetailsRow = typeof computerDetails.$inferSelect;
export type MonitorDetailsRow = typeof monitorDetails.$inferSelect;
export type PrinterDetailsRow = typeof printerDetails.$inferSelect;
export type PhoneDetailsRow = typeof phoneDetails.$inferSelect;
export type NetworkDetailsRow = typeof networkDetails.$inferSelect;
export type TableColumnConfigRow = typeof tableColumnConfig.$inferSelect;
export type ScanJobRow = typeof scanJobs.$inferSelect;
export type PrinterInstallJobRow = typeof printerInstallJobs.$inferSelect;
export type PrinterCheckRow = typeof printerChecks.$inferSelect;
export type PrinterStatusRow = typeof printerStatus.$inferSelect;
export type ScanWorkerRow = typeof scanWorkers.$inferSelect;
export type DiscoverySettingRow = typeof discoverySettings.$inferSelect;
export type PrinterCounterRow = typeof printerCounters.$inferSelect;
export type TrackedSoftwareRow = typeof trackedSoftware.$inferSelect;
export type InstalledSoftwareRow = typeof installedSoftware.$inferSelect;
// ── Dashboard widget toggles ─────────────────────────────────────────────────
// Per-widget on/off switches for the dashboard, admin-managed. Same shape and
// "absent row = on" convention as discovery_settings (spec 13): a missing widget
// row coalesces to enabled, so an empty table means "all widgets on" and nothing
// needs seeding. `widgetId` is plain text with a union `$type` so adding a future
// toggleable widget never needs an enum migration.
export const dashboardWidgets = pgTable("dashboard_widgets", {
  widgetId: text("widget_id").$type<"locations-map">().primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationReadRow = typeof notificationReads.$inferSelect;
export type DashboardWidgetRow = typeof dashboardWidgets.$inferSelect;
