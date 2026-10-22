import type { AssistResult } from "@/lib/ai/types";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
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
  tag: text("tag").notNull().unique(), // human key, e.g. H2TECS-COMP-7491
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
  kind: text("kind").notNull().default("unknown"), // windows | printer | phone | unknown
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
  phone: jsonb("phone"), // VoIP desk phone identity (spec 27): mac, model, …
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
    // VoIP desk phone (spec 27). Repurposed from the old mobile fields.
    mac: text("mac"), // device MAC (from the TLS cert) — the scan reconciliation key
    extension: text("extension"), // SIP account Label, e.g. "117"
    ipAddress: text("ip_address"),
    firmware: text("firmware"),
    registerStatus: text("register_status"), // Registered | Unregistered | Unknown
    // SIP account Display Name (phase-2 auth read, e.g. "Joseph Clark"). This
    // is the name the device shows on the handset, not the asset's assignee —
    // the two often agree but can differ (shared desk, floater phone).
    displayName: text("display_name"),
  },
  (t) => [
    // One phone per MAC (the reconciliation key); null MAC (manual entry) never collides.
    uniqueIndex("phone_details_mac_uq")
      .on(t.mac)
      .where(sql`${t.mac} is not null`),
    index("phone_details_extension_idx").on(t.extension),
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
  deviceType: text("device_type")
    .$type<"computer" | "printer" | "phone">()
    .primaryKey(),
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

// ── Device metric telemetry (spec 29) ───────────────────────────────────────
// Lightweight time-series sampled by the worker on a cadence (CPU/RAM/disk/uptime
// over WinRM), one wide row per (asset, sample). Retention-pruned daily like
// printer_checks. A gauge the collector couldn't read is NULL (a gap), never 0.
export const deviceMetrics = pgTable(
  "device_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull(),
    cpuPct: doublePrecision("cpu_pct"), // 0–100
    memPct: doublePrecision("mem_pct"), // used %
    diskPct: doublePrecision("disk_pct"), // system drive used %
    uptimeSec: integer("uptime_sec"),
  },
  (t) => [
    // Serves the per-device sparkline read and the retention prune.
    index("device_metrics_asset_sampled_idx").on(t.assetId, t.sampledAt.desc()),
  ],
);
export type DeviceMetricRow = typeof deviceMetrics.$inferSelect;

// ── Alert rules (spec 30) ───────────────────────────────────────────────────
// Configurable metric-threshold rules evaluated at metric ingest. `alert_rules`
// is the admin-edited catalog; `alert_rule_states` is the per-(rule, asset)
// episode machine (consecutive streak + last notified state). Both additive and
// brand new, so NOT NULL columns are safe. `signal`/`op`/`severity` are plain
// text unions (not pg enums) so a future signal never needs an enum migration.
export const alertRules = pgTable("alert_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  signal: text("signal")
    .$type<"cpu_pct" | "mem_pct" | "disk_pct" | "uptime_sec">()
    .notNull(),
  op: text("op").$type<"gt" | "gte" | "lt" | "lte">().notNull(),
  threshold: doublePrecision("threshold").notNull(),
  consecutive: integer("consecutive").notNull().default(1),
  severity: text("severity").$type<"info" | "warning" | "critical">().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  ticketAutoCreate: text("ticket_auto_create")
    .$type<"inherit" | "on" | "off">()
    .notNull()
    .default("inherit"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export const alertRuleStates = pgTable(
  "alert_rule_states",
  {
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => alertRules.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    consecutive: integer("consecutive").notNull().default(0),
    alertedState: text("alerted_state").$type<"ok" | "firing">(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.ruleId, t.assetId] })],
);
export type AlertRuleRow = typeof alertRules.$inferSelect;
export type AlertRuleStateRow = typeof alertRuleStates.$inferSelect;

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
    // Admin-uploaded brand icon (spec 22): the S3 object key `software-icons/{id}.png`
    // (null = use the built-in registry / generic glyph). `iconUpdatedAt` cache-busts
    // the serve URL when an admin replaces the icon.
    iconKey: text("icon_key"),
    iconUpdatedAt: timestamp("icon_updated_at", { withTimezone: true }),
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
    installLocation: text("install_location"), // spec 22
    architecture: text("architecture"), // "x64" | "x86" | "user" (spec 22)
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
  localAdmins: jsonb("local_admins").$type<
    { name: string; isGroup: boolean; enabled: boolean }[]
  >(),
  assessedAt: timestamp("assessed_at", { withTimezone: true }).notNull(),
  // Alerting state (spec 21 v2): the last posture state we notified admins about,
  // so we alert only on a transition and once per episode (like printer alerts).
  // "ok" | "at-risk" | null (never evaluated). Advanced only after a successful send.
  alertedState: text("alerted_state").$type<"ok" | "at-risk">(),
});

// ── Windows patch inventory (spec 31) ────────────────────────────────────────
// Current-state hotfix list + pending reboot + optional winget upgrade list per
// Computer. Replaced on each successful collect; no history in v1.
export const windowsUpdateState = pgTable("windows_update_state", {
  assetId: uuid("asset_id")
    .primaryKey()
    .references(() => assets.id, { onDelete: "cascade" }),
  pendingReboot: boolean("pending_reboot"),
  hotfixCount: integer("hotfix_count").notNull().default(0),
  // null = app collect skipped (config off); false = client unusable after bootstrap
  wingetAvailable: boolean("winget_available"),
  // Why winget was unavailable in the WinRM session (alias vs InstallLocation, etc.)
  wingetDetail: text("winget_detail"),
  appUpgradeCount: integer("app_upgrade_count").notNull().default(0),
  collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
  // Spec 31 phase 2: WUA Search("IsInstalled=0") on the dedicated worker loop.
  missingCount: integer("missing_count").notNull().default(0),
  missingCollectedAt: timestamp("missing_collected_at", { withTimezone: true }),
});

export const windowsHotfixes = pgTable(
  "windows_hotfixes",
  {
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    hotfixId: text("hotfix_id").notNull(), // e.g. KB5034441
    description: text("description"),
    installedOn: date("installed_on"), // null when WMI date missing/garbage
  },
  (t) => [
    primaryKey({ columns: [t.assetId, t.hotfixId] }),
    index("windows_hotfixes_asset_idx").on(t.assetId),
  ],
);

export const appUpgrades = pgTable(
  "app_upgrades",
  {
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    packageId: text("package_id").notNull(), // e.g. Google.Chrome
    name: text("name").notNull(),
    version: text("version"), // installed
    available: text("available"), // winget latest
    source: text("source"), // winget | msstore | …
  },
  (t) => [
    primaryKey({ columns: [t.assetId, t.packageId] }),
    index("app_upgrades_asset_idx").on(t.assetId),
  ],
);

// Missing OS updates from WUA Search (spec 31 phase 2). Replaced per asset on
// each successful Search; kb_id is KBnnnnnn or the update Identity GUID.
export const windowsMissingUpdates = pgTable(
  "windows_missing_updates",
  {
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    kbId: text("kb_id").notNull(),
    title: text("title").notNull(),
    severity: text("severity"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
  },
  (t) => [
    primaryKey({ columns: [t.assetId, t.kbId] }),
    index("windows_missing_updates_asset_idx").on(t.assetId),
  ],
);

export type WindowsUpdateStateRow = typeof windowsUpdateState.$inferSelect;
export type WindowsHotfixRow = typeof windowsHotfixes.$inferSelect;
export type AppUpgradeRow = typeof appUpgrades.$inferSelect;
export type WindowsMissingUpdateRow = typeof windowsMissingUpdates.$inferSelect;

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
        | "software-deploy"
        | "software-deploy-failed"
        | "patch-install"
        | "patch-install-failed"
        | "script-run"
        | "script-run-failed"
        | "ai-assist"
        | "ai-assist-failed"
        | "compliance-at-risk"
        | "compliance-recovered"
        | "metric-threshold"
        | "metric-recovered"
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
    audience: text("audience")
      .$type<"admins" | "user">()
      .notNull()
      .default("admins"),
    recipientEmail: text("recipient_email"),
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

// ── Remote Actions: interactive terminal sessions (spec 24) ──────────────────
// An on-demand, audited PowerShell-remoting session to a managed computer. Same
// outbound-only, atomic-claim / fenced / reaper machinery as scan_jobs and
// printer_install_jobs: the web owns the session, the collector worker claims it,
// opens the runspace, and relays a live terminal. This is arbitrary remote code
// execution, gated on the narrow `remote:shell` permission (Owner-only by default)
// and fully recorded in remote_session_events. The session carries NO credentials
// (fleet creds live only in collector/.env, resolved per subnet like scanning).
export const remoteSessions = pgTable(
  "remote_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The target computer asset. Cascade so deleting the computer clears sessions.
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    targetIp: text("target_ip").notNull(), // snapshot of computer_details.ip_address
    shell: text("shell").$type<"powershell">().notNull().default("powershell"),
    status: text("status")
      .$type<
        | "pending"
        | "claimed"
        | "active"
        | "closing"
        | "closed"
        | "failed"
        | "canceled"
      >()
      .notNull()
      .default("pending"),
    // Admin email from the access token; no FK (users live in aw-auth). Also the
    // session owner: only this user may stream or send input (spec 24, AC-5).
    requestedBy: text("requested_by").notNull(),
    workerId: text("worker_id"),
    error: text("error"), // worker-level error when status = failed
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // Cheap "oldest pending" claim poll (mirrors scan_jobs_pending_idx).
    index("remote_sessions_pending_idx")
      .on(t.status, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    // "One open session per computer" guard + history reads for one computer.
    index("remote_sessions_asset_idx").on(t.assetId, t.createdAt),
    // At most one live session per target (spec 24, AC-9). Partial unique over the
    // open statuses; a second Start races to a clean 23505 the action turns into
    // "a session is already open".
    uniqueIndex("remote_sessions_open_uq")
      .on(t.assetId)
      .where(sql`${t.status} in ('pending','claimed','active','closing')`),
  ],
);

// Append-only session log: the live relay buffer, the audit trail, AND the
// SSE/long-poll resume cursor, all in one structure (spec 24, AC-7). `seq` is
// monotonic per session; readers (browser output, collector input) hold their own
// cursor and query "events after <seq>". Never mutated; only the retention prune
// deletes. Output chunk size is capped by the writers.
export const remoteSessionEvents = pgTable(
  "remote_session_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => remoteSessions.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(), // monotonic per session
    direction: text("direction")
      .$type<"input" | "output" | "system">()
      .notNull(),
    // output: stdout|stderr; system: status (e.g. a status token); input: null.
    channel: text("channel").$type<"stdout" | "stderr" | "status">(),
    data: text("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // The "after my cursor" read, and the monotonic-seq guarantee per session.
    uniqueIndex("remote_session_events_seq_uq").on(t.sessionId, t.seq),
  ],
);

// ---------------- Software deployment (spec 23) ----------------

/**
 * One ordered step in a software package (spec 23). A package is a sequence of
 * steps the collector runs in order, stopping on the first failure. A `script`
 * step is inline PowerShell run elevated; an `install` step runs an uploaded
 * MSI/EXE silently. A plain single installer is just a one-`install`-step package.
 */
/** A stored file an install step transfers to the target (the installer itself, or
    a companion like a response .iss / .mst / config). */
export type SoftwareFileRef = {
  storageKey: string; // private object-store key the collector pulls from
  sha256: string; // hex, of the uploaded bytes (re-verified on the target)
  fileName: string; // original upload name + on-target name
  fileSize: number;
};

export type SoftwareStep =
  | {
      id: string; // stable per step (reorder/remove in the UI, per-step results)
      kind: "script";
      name: string;
      script: string; // PowerShell, run elevated over WinRM
      continueOnError?: boolean; // default false: a non-zero exit stops the package
    }
  | {
      id: string;
      kind: "install";
      name: string;
      installerType: "msi" | "exe";
      fileName: string; // original upload name + on-target name
      silentArgs: string; // required for EXE; MSI defaults to /qn /norestart.
      // `%DIR%` in silentArgs is replaced with the on-target temp dir, so a
      // response/transform file shipped as a companion can be referenced, e.g.
      // `/s /f1"%DIR%\app.iss" /v"/qn"`.
      sha256: string; // hex, of the uploaded bytes (re-verified on the target)
      storageKey: string; // private object-store key the collector pulls from
      fileSize: number;
      // Extra files transferred into the same temp dir beside the installer (not
      // executed): response files, transforms, config, etc.
      companions?: SoftwareFileRef[];
      continueOnError?: boolean;
    };

/** The package frozen onto a deployment at enqueue, so a later edit or delete of
    the catalog row never changes a queued/running job. */
export type SoftwarePackageSnapshot = {
  name: string;
  version: string;
  steps: SoftwareStep[];
};

export type SoftwareStepResult = {
  stepId: string;
  name: string;
  kind: "script" | "install";
  status: "ok" | "failed" | "skipped"; // skipped = a prior step failed and stopped
  exitCode: number | null;
  outputTail: string;
};

export type SoftwareDeployResult = {
  outcome: "installed" | "install-failed" | "integrity-failed";
  rebootRequired: boolean; // true on msiexec 3010 / a step that signals a reboot
  steps: SoftwareStepResult[];
};

// Software package catalog (spec 23). A package is a header plus an ordered list of
// steps (`steps` jsonb). Installer-step bytes live in the private object store
// under each step's `storageKey`. Soft-archived (`archivedAt`) rather than hard-
// deleted while deployment history references it, so history stays resolvable.
export const softwarePackages = pgTable(
  "software_packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    publisher: text("publisher"),
    steps: jsonb("steps")
      .$type<SoftwareStep[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    uploadedBy: text("uploaded_by").notNull(), // admin email; no FK (aw-auth)
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("software_packages_created_idx").on(t.createdAt)],
);

// Deploy queue (spec 23) — the same outbound-only atomic-claim / fenced-status /
// reaper machinery as scan_jobs and printer_install_jobs. One worker claims the
// oldest pending row; its result post is fenced by workerId + claimedAt.
export const softwareDeployments = pgTable(
  "software_deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The target computer asset. Cascade so deleting the computer clears its jobs.
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    targetIp: text("target_ip").notNull(), // snapshot of computer_details.ip_address
    // Null after the catalog row is hard-deleted; the frozen snapshot still drives
    // the job either way.
    packageId: uuid("package_id").references(() => softwarePackages.id, {
      onDelete: "set null",
    }),
    packageSnapshot: jsonb("package_snapshot")
      .$type<SoftwarePackageSnapshot>()
      .notNull(),
    status: text("status")
      .$type<
        "pending" | "claimed" | "running" | "succeeded" | "failed" | "canceled"
      >()
      .notNull()
      .default("pending"),
    requestedBy: text("requested_by").notNull(), // admin email; no FK (aw-auth)
    workerId: text("worker_id"),
    result: jsonb("result").$type<SoftwareDeployResult>(),
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
    // Cheap "oldest pending" claim poll (mirrors printer_install_jobs_pending_idx).
    index("software_deployments_pending_idx")
      .on(t.status, t.requestedAt)
      .where(sql`${t.status} = 'pending'`),
    // History panel reads the newest jobs for one computer.
    index("software_deployments_asset_idx").on(t.assetId, t.requestedAt),
    // "Is a deploy already in flight on this computer" read (spec 23, AC-10).
    index("software_deployments_inflight_idx")
      .on(t.assetId)
      .where(sql`${t.status} in ('pending','claimed','running')`),
  ],
);

// Patch install queue (spec 31 phase 3). Approve selected missing OS KBs and/or
// winget upgrades on one Computer; collector claims and runs over WinRM.
export type PatchInstallOsItem = { kbId: string; title: string };
export type PatchInstallAppItem = {
  packageId: string;
  name: string;
  version: string | null;
  available: string | null;
};
export type PatchInstallSelection = {
  os: PatchInstallOsItem[];
  apps: PatchInstallAppItem[];
};
export type PatchInstallItemResult = {
  kind: "os" | "app";
  id: string; // kbId or packageId
  ok: boolean;
  rebootRequired?: boolean;
  exitCode?: number | null;
  outputTail?: string | null;
};
export type PatchInstallResult = {
  items: PatchInstallItemResult[];
  rebootRequired: boolean;
};

export const patchInstallJobs = pgTable(
  "patch_install_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    targetIp: text("target_ip").notNull(),
    selection: jsonb("selection").$type<PatchInstallSelection>().notNull(),
    status: text("status")
      .$type<
        "pending" | "claimed" | "running" | "succeeded" | "failed" | "canceled"
      >()
      .notNull()
      .default("pending"),
    requestedBy: text("requested_by").notNull(),
    workerId: text("worker_id"),
    result: jsonb("result").$type<PatchInstallResult>(),
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
    index("patch_install_jobs_pending_idx")
      .on(t.status, t.requestedAt)
      .where(sql`${t.status} = 'pending'`),
    index("patch_install_jobs_asset_idx").on(t.assetId, t.requestedAt),
    index("patch_install_jobs_inflight_idx")
      .on(t.assetId)
      .where(sql`${t.status} in ('pending','claimed','running')`),
  ],
);

export type PatchInstallJobRow = typeof patchInstallJobs.$inferSelect;

/** Scheduled forced reboot queue (spec 31 v2). Standalone or linked to patch install. */
export const rebootJobs = pgTable(
  "reboot_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    targetIp: text("target_ip").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    sourcePatchInstallJobId: uuid("source_patch_install_job_id").references(
      () => patchInstallJobs.id,
      { onDelete: "set null" },
    ),
    status: text("status")
      .$type<
        "pending" | "claimed" | "running" | "succeeded" | "failed" | "canceled"
      >()
      .notNull()
      .default("pending"),
    requestedBy: text("requested_by").notNull(),
    workerId: text("worker_id"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
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
    index("reboot_jobs_pending_due_idx")
      .on(t.status, t.scheduledAt)
      .where(sql`${t.status} = 'pending'`),
    index("reboot_jobs_inflight_idx")
      .on(t.assetId)
      .where(sql`${t.status} in ('pending','claimed','running')`),
    index("reboot_jobs_source_install_idx").on(t.sourcePatchInstallJobId),
  ],
);

export type RebootJobRow = typeof rebootJobs.$inferSelect;

// One-host missing-update Search (spec 31 phase 4 closeout). Same claim shape as
// patch install; runs PS_MISSING_UPDATES then posts /api/ingest/missing-updates.
export const missingUpdateChecks = pgTable(
  "missing_update_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    targetIp: text("target_ip").notNull(),
    status: text("status")
      .$type<
        "pending" | "claimed" | "running" | "succeeded" | "failed" | "canceled"
      >()
      .notNull()
      .default("pending"),
    requestedBy: text("requested_by").notNull(),
    workerId: text("worker_id"),
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
    index("missing_update_checks_pending_idx")
      .on(t.status, t.requestedAt)
      .where(sql`${t.status} = 'pending'`),
    index("missing_update_checks_inflight_idx")
      .on(t.assetId)
      .where(sql`${t.status} in ('pending','claimed','running')`),
  ],
);

export type MissingUpdateCheckRow = typeof missingUpdateChecks.$inferSelect;

// Script library + run queue (spec 32). Saved PowerShell; run-now on one Computer.
export const scripts = pgTable(
  "scripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    body: text("body").notNull(),
    timeoutSeconds: integer("timeout_seconds").notNull().default(120),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("scripts_name_idx").on(t.name)],
);

export type ScriptRow = typeof scripts.$inferSelect;

export type ScriptSnapshot = {
  name: string;
  body: string;
  timeoutSeconds: number;
};
export type ScriptRunResult = {
  exitCode: number | null;
  outputTail: string | null;
};
/** Frozen target set for a batch or schedule (spec 32 v2). */
export type ScriptTargetSpec =
  | { mode: "tags"; tags: string[] }
  | { mode: "location"; locationId: string };

// Fan-out batch (spec 32 v2): one row per Run-on… / schedule fire.
export const scriptRunBatches = pgTable(
  "script_run_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scriptId: uuid("script_id").references(() => scripts.id, {
      onDelete: "set null",
    }),
    scriptSnapshot: jsonb("script_snapshot").$type<ScriptSnapshot>().notNull(),
    targetSpec: jsonb("target_spec").$type<ScriptTargetSpec>().notNull(),
    source: text("source").$type<"manual" | "schedule">().notNull(),
    scheduleId: uuid("schedule_id"),
    requestedBy: text("requested_by").notNull(),
    enqueuedCount: integer("enqueued_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("script_run_batches_created_idx").on(t.createdAt)],
);

export type ScriptRunBatchRow = typeof scriptRunBatches.$inferSelect;

export const scriptRunJobs = pgTable(
  "script_run_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    targetIp: text("target_ip").notNull(),
    scriptId: uuid("script_id").references(() => scripts.id, {
      onDelete: "set null",
    }),
    batchId: uuid("batch_id").references(() => scriptRunBatches.id, {
      onDelete: "set null",
    }),
    scriptSnapshot: jsonb("script_snapshot").$type<ScriptSnapshot>().notNull(),
    status: text("status")
      .$type<
        "pending" | "claimed" | "running" | "succeeded" | "failed" | "canceled"
      >()
      .notNull()
      .default("pending"),
    requestedBy: text("requested_by").notNull(),
    workerId: text("worker_id"),
    result: jsonb("result").$type<ScriptRunResult>(),
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
    index("script_run_jobs_pending_idx")
      .on(t.status, t.requestedAt)
      .where(sql`${t.status} = 'pending'`),
    index("script_run_jobs_asset_idx").on(t.assetId, t.requestedAt),
    index("script_run_jobs_inflight_idx")
      .on(t.assetId)
      .where(sql`${t.status} in ('pending','claimed','running')`),
    index("script_run_jobs_batch_idx").on(t.batchId),
  ],
);

export type ScriptRunJobRow = typeof scriptRunJobs.$inferSelect;

// Scheduled script runs (spec 32 v2). Data in web; worker ticks due rows.
export const scriptSchedules = pgTable(
  "script_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scriptId: uuid("script_id")
      .notNull()
      .references(() => scripts.id, { onDelete: "cascade" }),
    targetSpec: jsonb("target_spec").$type<ScriptTargetSpec>().notNull(),
    cadence: text("cadence").$type<"daily" | "weekly">().notNull(),
    hour: integer("hour").notNull(),
    minute: integer("minute").notNull(),
    weekday: integer("weekday"), // 0–6 for weekly
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("script_schedules_next_run_idx").on(t.nextRunAt),
    index("script_schedules_script_idx").on(t.scriptId),
  ],
);

export type ScriptScheduleRow = typeof scriptSchedules.$inferSelect;

// Connected displays per Computer (spec 25). Current state, fully replaced per scan
// (like installed_software); `serial` keys the read-time join to Monitor assets.
export const connectedMonitors = pgTable(
  "connected_monitors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    manufacturer: text("manufacturer"), // vendor name, mapped from the PnP code
    vendorCode: text("vendor_code"), // 3-letter PnP code, e.g. "DEL"
    model: text("model"),
    serial: text("serial"),
    productCode: text("product_code"),
    year: integer("year"),
    active: boolean("active").notNull().default(true),
    diagonalIn: doublePrecision("diagonal_in"),
    resolution: text("resolution"), // native, e.g. "1920x1080" (from EDID)
    refreshHz: integer("refresh_hz"), // native refresh, from EDID
    seenAt: timestamp("seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("connected_monitors_asset_idx").on(t.assetId),
    index("connected_monitors_serial_idx").on(t.serial),
  ],
);

// Displays a scan reported that an admin has waved off the Monitors discovery
// list (spec 25 follow-up). Keyed by the EDID serial so the dismissal survives
// re-scans (connected_monitors is wiped and rewritten each scan). An entry here
// hides that serial from "Discovered displays"; adding the monitor to inventory
// (an asset with that serial) also drops it from the list, by the asset match.
export const dismissedMonitors = pgTable("dismissed_monitors", {
  serial: text("serial").primaryKey(),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  dismissedBy: text("dismissed_by"), // the admin's email, for the audit trail
});

export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationReadRow = typeof notificationReads.$inferSelect;
export type DashboardWidgetRow = typeof dashboardWidgets.$inferSelect;
export type RemoteSessionRow = typeof remoteSessions.$inferSelect;
export type RemoteSessionEventRow = typeof remoteSessionEvents.$inferSelect;
export type SoftwarePackageRow = typeof softwarePackages.$inferSelect;
export type SoftwareDeploymentRow = typeof softwareDeployments.$inferSelect;
export type ConnectedMonitorRow = typeof connectedMonitors.$inferSelect;
export type DismissedMonitorRow = typeof dismissedMonitors.$inferSelect;

// Saved custom-report definitions (spec 26). A report is a data source + a spec
// (columns/filters/groupBy/aggregates/sort/limit) stored as jsonb and re-run on
// demand — no user SQL, the engine composes from a whitelisted field catalog.
export const reportDefinitions = pgTable("report_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"), // optional folder/grouping (spec 26 phase 2 extra)
  source: text("source").notNull(), // a REPORT_SOURCES id
  spec: jsonb("spec")
    .$type<import("@/lib/report-spec").ReportSpec>()
    .notNull(),
  createdBy: text("created_by"), // the author's email (no FK; admins live in aw-auth)
  shared: boolean("shared").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export type ReportDefinitionRow = typeof reportDefinitions.$inferSelect;

export const reportCadence = pgEnum("report_cadence", [
  "daily",
  "weekly",
  "monthly",
]);

// A delivery schedule for a saved report (spec 26 phase 2): email the report to
// recipients on a cadence. One schedule per report (unique reportId). Schedules
// are DATA here, not collector config — the worker fires a periodic trigger and
// web decides which are due (nextRunAt <= now), runs the report, emails it, then
// advances lastRunAt/nextRunAt (the spec 19 warranty-sweep model). Times are
// wall-clock in the server's local zone.
export const reportSchedules = pgTable(
  "report_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reportDefinitions.id, { onDelete: "cascade" }),
    cadence: reportCadence("cadence").notNull(),
    hour: integer("hour").notNull(), // 0–23
    minute: integer("minute").notNull(), // 0–59
    weekday: integer("weekday"), // 0–6 (0 = Sunday), for weekly
    dayOfMonth: integer("day_of_month"), // 1–31 (clamped), for monthly
    recipients: jsonb("recipients").$type<string[]>().notNull(),
    format: text("format").notNull().default("csv"), // attachment: csv | xlsx
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by"), // the author's email (no FK; admins live in aw-auth)
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // One schedule per report.
    uniqueIndex("report_schedules_report_uq").on(t.reportId),
    // Serves the delivery sweep (enabled schedules that are due).
    index("report_schedules_next_run_idx").on(t.nextRunAt),
  ],
);
export type ReportScheduleRow = typeof reportSchedules.$inferSelect;

// AI assist audit (spec 34). Hash of redacted context only — no prompt/completion store.
export const aiAssistEvents = pgTable(
  "ai_assist_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorEmail: text("actor_email").notNull(),
    assetId: uuid("asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    contextHash: text("context_hash").notNull(),
    ok: boolean("ok").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("ai_assist_events_created_idx").on(t.createdAt),
    index("ai_assist_events_asset_idx").on(t.assetId),
  ],
);
export type AiAssistEventRow = typeof aiAssistEvents.$inferSelect;

export const aiAssistJobs = pgTable(
  "ai_assist_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorEmail: text("actor_email").notNull(),
    assetId: uuid("asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    scriptRunJobId: uuid("script_run_job_id"),
    userPrompt: text("user_prompt"),
    status: text("status")
      .$type<"pending" | "running" | "succeeded" | "failed">()
      .notNull()
      .default("pending"),
    result: jsonb("result").$type<AssistResult>(),
    error: text("error"),
    contextHash: text("context_hash"),
    provider: text("provider"),
    model: text("model"),
    notificationId: uuid("notification_id").references(() => notifications.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("ai_assist_jobs_asset_created_idx").on(t.assetId, t.createdAt),
    index("ai_assist_jobs_status_started_idx").on(t.status, t.startedAt),
  ],
);
export type AiAssistJobRow = typeof aiAssistJobs.$inferSelect;

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: integer("number").notNull().unique(),
    subject: text("subject").notNull(),
    description: text("description").notNull().default(""),
    status: text("status")
      .$type<
        "open" | "in_progress" | "waiting_on_user" | "resolved" | "closed"
      >()
      .notNull()
      .default("open"),
    priority: text("priority")
      .$type<"low" | "medium" | "high">()
      .notNull()
      .default("medium"),
    category: text("category").notNull().default(""),
    assigneeEmail: text("assignee_email"),
    /** End-user / device owner the ticket is for (may differ from createdBy). */
    requesterEmail: text("requester_email"),
    assetId: uuid("asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    sourceNotificationId: uuid("source_notification_id").references(
      () => notifications.id,
      { onDelete: "set null" },
    ),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("tickets_source_notification_id_uidx").on(t.sourceNotificationId),
    index("tickets_status_updated_idx").on(t.status, t.updatedAt),
    index("tickets_asset_id_idx").on(t.assetId),
  ],
);

export const ticketComments = pgTable("ticket_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  ticketId: uuid("ticket_id")
    .notNull()
    .references(() => tickets.id, { onDelete: "cascade" }),
  authorEmail: text("author_email").notNull(),
  body: text("body").notNull(),
  kind: text("kind").$type<"user" | "system">().notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/** Spec 33: outbound and inbound ticket mail, keyed by Message-ID. */
export const ticketEmailMessages = pgTable(
  "ticket_email_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    direction: text("direction")
      .$type<"outbound" | "inbound">()
      .notNull(),
    messageId: text("message_id").notNull(),
    inReplyTo: text("in_reply_to"),
    fromEmail: text("from_email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("ticket_email_messages_message_id_uidx").on(t.messageId),
    index("ticket_email_messages_ticket_id_idx").on(t.ticketId),
  ],
);

/** Absent type = auto-create OFF (explicit enable required). */
export const ticketAutoCreateTypes = pgTable("ticket_auto_create_types", {
  type: text("type").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type TicketRow = typeof tickets.$inferSelect;
export type TicketCommentRow = typeof ticketComments.$inferSelect;
export type TicketEmailMessageRow = typeof ticketEmailMessages.$inferSelect;
export type TicketAutoCreateTypeRow = typeof ticketAutoCreateTypes.$inferSelect;
