import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Monitor,
  Printer,
  Smartphone,
  Cpu,
  Network,
  AppWindow,
  ShieldCheck,
  FileText,
  Settings,
  ScanLine,
  ListChecks,
  HelpCircle,
  Users,
  Images,
  Bell,
} from "lucide-react";

/* ---------------- Types ---------------- */

export type AssetStatus = "deployed" | "maintenance" | "online" | "storage";
export type AssetType =
  | "Computer"
  | "Monitor"
  | "Printer"
  | "Phone"
  | "Network";

export interface Assignee {
  name: string;
  initials: string;
}

export interface Asset {
  id: string;
  name: string;
  type: AssetType;
  serial: string;
  model: string;
  assignee: Assignee | null; // null = unassigned / pool
  location: string; // full path of the assigned leaf, e.g. "New York / Bronx"; "" = none
  locationId: string | null; // the assigned leaf's id, for the subtree filter
  status: AssetStatus;
  lastSync: string; // ISO date
  // richer fields for the detail drawer (later)
  vendor: string;
  purchaseDate: string;
  warrantyUntil: string;
  costCenter: string;
  spec: string;
  // Media-library id of the asset's product photo (spec 18, superseding spec
  // 17.02's imageKey); null/absent = no image, show the type icon. The image is
  // served through /api/assets/[tag]/image, which resolves it through media.
  imageId?: string | null;
  // Cache-buster for the asset image URL (spec 18 phase 3): encodes the media id
  // plus whether the cut-out is being displayed, so toggling the cut-out updates
  // the shown image instead of serving a stale cached one. Falls back to imageId.
  imageVersion?: string | null;
  // Extra searchable identifiers from the type detail tables (IP, phone, IMEI,
  // MAC), so the search bar and list search match them (spec 10). Optional
  // because the sample seed data predates the detail tables.
  search?: string;
  // Type-specific identifiers surfaced as per-category table columns (spec 10);
  // only the fields for the row's own type are set.
  ip?: string; // printer or network IP
  mac?: string; // network MAC
  phoneNumber?: string; // phone number
  // Printer reachability rollup (spec 12), set only on printer rows that have a
  // reachability status yet; absent means never checked.
  reachability?: AssetReachability;
}

/* ---------------- Printer reachability (spec 12) ---------------- */

export type ReachabilityState = "up" | "down" | "unknown";

/** Current reachability rollup shown as a badge on printer rows / detail. */
export interface AssetReachability {
  state: ReachabilityState;
  lastCheckedAt: string | null; // ISO
  downSince: string | null; // ISO; set while down
}

/** One historical reachability check, for the printer detail page. */
export interface ReachabilityCheck {
  checkedAt: string; // ISO
  reachable: boolean;
  latencyMs: number | null;
  method: "tcp" | "snmp";
}

/* ---------------- Printer page counter (spec 14) ---------------- */

/** A day's counter reading with its computed delta, for the detail panel. */
export interface CounterHistoryDay {
  readingDate: string; // YYYY-MM-DD
  totalPages: number;
  delta: number | null; // pages that day; null when a first reading or a reset
  note: "first-reading" | "counter-reset" | null;
}

/** The page-counter panel data for one printer's detail page (spec 14, AC-3). */
export interface PrinterCounters {
  latestTotal: number | null;
  latestDate: string | null; // YYYY-MM-DD
  latestDelta: number | null;
  latestNote: "first-reading" | "counter-reset" | null;
  history: CounterHistoryDay[];
}

/* ---------------- Printer detail: network health & activity (spec 17.03) ---- */

/** One protocol's latest probe on the Network Health card (spec 17.03, AC-3.5).
   `latencyMs` is null for SNMP: the collector times only the TCP probe, so an
   SNMP latency would be invented data and is never shown. */
export interface PrinterProtocolCheck {
  reachable: boolean;
  latencyMs: number | null;
  checkedAt: string; // ISO
}

/** The Network Health card for one printer (spec 17.03, AC-3.5): the reachable
   rollup plus the latest TCP and SNMP probes. HTTP is deliberately absent
   (shown as "not tracked" in the UI, a spec 12 follow-up). */
export interface PrinterNetworkHealth {
  state: ReachabilityState;
  lastCheckedAt: string | null; // ISO
  ip: string | null;
  tcp: PrinterProtocolCheck | null;
  snmp: PrinterProtocolCheck | null; // latencyMs always null (never timed)
}

/** The kind of a derived activity row (spec 17.03, AC-3.6). */
export type PrinterActivityKind =
  | "health-check"
  | "counter-sync"
  | "status-update";

/** One row in the printer activity feed (spec 17.03, AC-3.6), derived from the
   existing spec 12 checks and spec 14 counter history. Nothing here is stored:
   Health Check and Counter Sync are straight reads; Status Update is replayed
   from `printer_checks` through the shared down rule. */
export interface PrinterActivityEvent {
  kind: PrinterActivityKind;
  at: string; // ISO
  title: string; // "Health Check" | "Counter Sync" | "Status Update"
  detail: string;
  ok: boolean; // dot color: healthy/neutral (true) vs down (false)
}

/* ---------------- Software inventory (spec 15) ---------------- */

/** One tracked title on the /software aggregate page (AC-4): its fleet install
   count (distinct Computer assets) and the distinct versions seen. */
export interface SoftwareInventoryRow {
  id: string; // tracked_software id
  name: string; // the tracked title
  machineCount: number; // distinct Computer assets with a matching row (0 shown)
  versions: string[]; // distinct versions seen across the fleet
}

/** A Computer asset that has a tracked title, for the per-title drill-down
   (AC-5). `id` is the asset tag (the UI id), so it links to /assets/[id]. */
export interface SoftwareTitleMachine {
  id: string; // asset tag
  name: string;
  serial: string;
  versions: string[]; // the versions of this title found on the machine
  lastSeen: string; // ISO date of the scan that recorded it
}

/** One tracked program on a computer's detail-page software panel (AC-6). */
export interface InstalledSoftwareItem {
  name: string; // the actual DisplayName found
  version: string;
  publisher: string;
}

/* ---------------- Notifications (spec 19) ---------------- */

export type NotificationType =
  | "printer-down"
  | "printer-recovery"
  | "scan-failed"
  | "device-discovered"
  | "warranty-expiring";

export type NotificationSeverity = "info" | "warning" | "critical";

/** One notification as the bell and the /notifications page render it, carrying
   the current user's read flag. Shared by the server data layer and the client
   (this is the client-safe shape; the DB module imports it from here). */
export interface NotificationItem {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  href: string;
  assetId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string; // ISO
  read: boolean;
}

/* ---------------- People directory & assignments (spec 16) ---------------- */

export type PersonStatus = "active" | "archived";

/** One row on the /people directory (AC-2): the profile summary plus the count
   of devices the person currently holds. */
export interface DirectoryPerson {
  id: string;
  name: string;
  initials: string;
  email: string;
  department: string;
  jobTitle: string;
  phone: string;
  employeeId: string;
  officeLocation: string; // full location path, "" = none
  officeLocationId: string | null;
  status: PersonStatus;
  deviceCount: number; // devices with an open assignment to this person
}

/** A device a person currently holds, for the person detail page (AC-4). `id`
   is the asset tag (the UI id), so it links to /assets/[id]. */
export interface CurrentDevice {
  id: string; // asset tag
  name: string;
  type: AssetType;
  serial: string;
  assignedAt: string; // ISO — when this open assignment started
}

/** One assignment event, used by both the person timeline and the device
   timeline (AC-4, AC-7). Carries both sides so either page can render it. */
export interface AssignmentEvent {
  id: string;
  assetId: string; // asset tag (the UI id), for a link
  assetName: string;
  assetType: AssetType;
  personId: string;
  personName: string;
  assignedAt: string; // ISO
  assignedBy: string; // admin email
  unassignedAt: string | null; // ISO; null = still open
  unassignedBy: string | null; // admin email; null while open
  open: boolean;
}

/** The full person detail page payload (AC-4). */
export interface PersonDetail {
  person: DirectoryPerson;
  currentDevices: CurrentDevice[];
  history: AssignmentEvent[];
}

/* ---------------- Status metadata ---------------- */

export const STATUS_META: Record<
  AssetStatus,
  { label: string; colorVar: string }
> = {
  deployed: { label: "Deployed", colorVar: "var(--status-deployed)" },
  maintenance: { label: "Maintenance", colorVar: "var(--status-maintenance)" },
  online: { label: "Online", colorVar: "var(--status-online)" },
  storage: { label: "Storage", colorVar: "var(--status-storage)" },
};

export const TYPE_ICON: Record<AssetType, LucideIcon> = {
  Computer: Cpu,
  Monitor: Monitor,
  Printer: Printer,
  Phone: Smartphone,
  Network: Network,
};

/* ---------------- Discovered devices (scan inbox) ---------------- */

/* A scanned machine kind (collector `device_type`) and how it maps into
   managed inventory when quick-created. */
export const KIND_META: Record<
  string,
  { label: string; icon: LucideIcon; type: AssetType }
> = {
  windows: { label: "Windows", icon: Cpu, type: "Computer" },
  printer: { label: "Printer", icon: Printer, type: "Printer" },
  unknown: { label: "Unknown", icon: HelpCircle, type: "Computer" },
};

export function kindMeta(kind: string) {
  return KIND_META[kind] ?? KIND_META.unknown;
}

/* A ranked suggestion of the existing asset a discovered device probably is. */
export interface DeviceSuggestion {
  assetId: string; // uuid, used to link
  tag: string; // human key, shown to the admin
  name: string;
  type: AssetType;
  serial: string;
  reason: string; // why it was suggested, e.g. "Exact serial match"
  strength: "exact" | "strong" | "weak";
}

/* A scanned machine with no managed asset yet — a row in the inbox. */
export interface DiscoveredDevice {
  id: string; // machine uuid
  hostname: string;
  ip: string;
  subnet: string;
  kind: string; // windows | printer | unknown
  os: string; // osName + osVersion, combined
  serial: string;
  spec: string; // short hardware summary (cpu · ram), when scanned
  lastSeen: string; // ISO date
  ignored: boolean; // true when dismissed from the active inbox
  suggestions: DeviceSuggestion[];
}

/* Minimal asset shape for the manual "link to existing asset" picker. */
export interface LinkAsset {
  id: string; // uuid
  tag: string;
  name: string;
  type: AssetType;
  serial: string;
}

/* Result of an inbox write action (link / create / ignore / restore). */
export type ActionResult =
  | { ok: true; message: string; tag?: string }
  | { ok: false; error: string };

/* ---------------- Locations (the location tree) ---------------- */

/* A node in the location tree, rendered nested on /locations. `deviceCount` is
   the number of devices assigned directly to this node (only ever non-zero on a
   leaf, since assignment is leaf-only). */
export interface LocationNode {
  id: string;
  name: string;
  parentId: string | null;
  deviceCount: number;
  children: LocationNode[];
}

/* A flat location row for the pickers and the list filter. `path` is the full
   ancestry ("New York / Bronx"), `depth` the tree level (0 = top), `isLeaf`
   whether it has no children (only leaves are assignable). */
export interface LocationOption {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  depth: number;
  isLeaf: boolean;
}

/** Join two location names into a display path. */
export const LOCATION_PATH_SEP = " / ";

/* ---------------- Navigation ---------------- */

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

export const NAV_PRIMARY: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
];

export const NAV_ASSETS: NavItem[] = [
  { label: "Computers", href: "/computers", icon: Cpu },
  { label: "Monitors", href: "/monitors", icon: Monitor },
  { label: "Printers", href: "/printers", icon: Printer },
  { label: "Phones", href: "/phones", icon: Smartphone },
  { label: "Network", href: "/network", icon: Network },
  { label: "Software", href: "/software", icon: AppWindow },
];

export const NAV_MANAGE: NavItem[] = [
  { label: "People", href: "/people", icon: Users },
  { label: "Media", href: "/media", icon: Images },
  { label: "Compliance", href: "/compliance", icon: ShieldCheck },
  { label: "Reports", href: "/reports", icon: FileText },
  { label: "Scans", href: "/scans", icon: ScanLine },
  { label: "Scan Jobs", href: "/scans/jobs", icon: ListChecks },
  { label: "Notifications", href: "/notifications", icon: Bell },
  { label: "Admin", href: "/admin", icon: Settings },
];

/** Manage-section routes that are admin-only, hidden from the sidebar for users
   without `user:admin` (spec 19 notifications; the Admin page). */
export const ADMIN_ONLY_NAV = new Set<string>(["/admin", "/notifications"]);

/* ---------------- KPIs ---------------- */

export interface Kpi {
  label: string;
  value: number;
  sub: string;
  delta?: number; // percent, positive/negative
  icon: LucideIcon;
}

/* KPI values/distribution/status are computed from the database at request
   time (see src/db/queries.ts and the dashboard page). */

export interface Slice {
  label: string;
  value: number;
  colorVar: string;
}

/* Live-scan summary for an asset, sourced from the machines table (collector). */
export interface MachineSummary {
  lastSeen: string;
  osName: string;
  osVersion: string;
  cpu: string;
  ramGb: number | null;
  freeDiskGb: number | null;
  uptimeHours: number | null;
  status: string;
}

/* ---------------- Sample fleet (DB seed source) ----------------
   Consumed by src/db/seed.ts to populate Postgres. The UI reads assets from
   the database, not from this array. `locationId` is DB-assigned (the tree
   didn't exist when this data was written), so the seed shape omits it; the
   free-text `location` is kept for reference but no longer seeded (spec 09). */

export type SampleAsset = Omit<Asset, "locationId">;

export const ASSETS: SampleAsset[] = [
  {
    id: "OPUS-COMP-7491",
    name: "Sarah's MacBook Pro 16\"",
    type: "Computer",
    serial: "C02DW480MD6R",
    model: "MacBook Pro 16\" (M3 Max)",
    assignee: { name: "Sarah Jenkins", initials: "SJ" },
    location: "SF — HQ — L4",
    status: "deployed",
    lastSync: "2026-08-24",
    vendor: "Apple Enterprise",
    purchaseDate: "2024-02-14",
    warrantyUntil: "2027-02-14",
    costCenter: "ENG-CORE-SF",
    spec: "64GB RAM / 2TB SSD / Space Black",
  },
  {
    id: "OPUS-COMP-7492",
    name: "Michael's Dell XPS 15",
    type: "Computer",
    serial: "E8E630008",
    model: "Dell XPS 15 9530",
    assignee: { name: "Michael Reyes", initials: "MR" },
    location: "Remote — AUS",
    status: "maintenance",
    lastSync: "2026-08-23",
    vendor: "Dell ProSupport",
    purchaseDate: "2024-05-02",
    warrantyUntil: "2027-05-02",
    costCenter: "FIELD-AUS",
    spec: "i7-13700H / 32GB RAM / 1TB NVMe",
  },
  {
    id: "OPUS-PRNT-7493",
    name: "Marketing Printer — HQ",
    type: "Printer",
    serial: "VNC3K12345",
    model: "HP LaserJet Enterprise M611dn",
    assignee: null,
    location: "SF — HQ — L4 Print Bay",
    status: "online",
    lastSync: "2026-08-25",
    vendor: "HP Enterprise",
    purchaseDate: "2023-09-15",
    warrantyUntil: "2026-09-15",
    costCenter: "FAC-SF",
    spec: "Mono / 65ppm / Duplex / JetDirect",
  },
  {
    id: "OPUS-MON-7494",
    name: "Priya's Studio Display",
    type: "Monitor",
    serial: "C07ZW2ABMD6T",
    model: "Apple Studio Display 5K",
    assignee: { name: "Priya Raman", initials: "PR" },
    location: "SF — HQ — L10",
    status: "deployed",
    lastSync: "2026-08-24",
    vendor: "Apple Enterprise",
    purchaseDate: "2024-05-01",
    warrantyUntil: "2027-05-01",
    costCenter: "DESIGN-SF",
    spec: "5K Retina / Nano-Texture",
  },
  {
    id: "OPUS-PHN-7495",
    name: "Field iPhone 15 Pro",
    type: "Phone",
    serial: "DX4Q9F7GHY",
    model: "iPhone 15 Pro Max",
    assignee: null,
    location: "SF — Cage 01",
    status: "storage",
    lastSync: "2026-08-20",
    vendor: "Apple Enterprise",
    purchaseDate: "2024-09-15",
    warrantyUntil: "2026-09-15",
    costCenter: "POOL-SF",
    spec: "256GB / Natural Titanium / eSIM",
  },
  {
    id: "OPUS-COMP-7496",
    name: "David's Latitude 7440",
    type: "Computer",
    serial: "7KJ2QN3",
    model: "Dell Latitude 7440",
    assignee: { name: "David Varma", initials: "DV" },
    location: "AUS — Field Ops",
    status: "deployed",
    lastSync: "2026-08-25",
    vendor: "Dell ProSupport",
    purchaseDate: "2024-08-03",
    warrantyUntil: "2027-08-03",
    costCenter: "FIELD-AUS",
    spec: "i7-1365U / 32GB RAM / 1TB NVMe",
  },
  {
    id: "OPUS-MON-7497",
    name: "Bay 3 — UltraSharp 34\"",
    type: "Monitor",
    serial: "CN0J8P2Q",
    model: "Dell UltraSharp U3423WE",
    assignee: null,
    location: "NY — Cage 02",
    status: "storage",
    lastSync: "2026-08-19",
    vendor: "Dell ProSupport",
    purchaseDate: "2023-02-18",
    warrantyUntil: "2026-02-18",
    costCenter: "POOL-NY",
    spec: "WQHD Curved / USB-C 90W hub",
  },
  {
    id: "OPUS-NET-7498",
    name: "Core Switch — SF L4",
    type: "Network",
    serial: "FOC2450R1AB",
    model: "Cisco Catalyst 9300",
    assignee: null,
    location: "SF — HQ — MDF",
    status: "online",
    lastSync: "2026-08-25",
    vendor: "Cisco",
    purchaseDate: "2023-06-10",
    warrantyUntil: "2028-06-10",
    costCenter: "NET-CORE",
    spec: "48-port / PoE+ / 10G uplink",
  },
  {
    id: "OPUS-COMP-7499",
    name: "Elena's ThinkPad X1",
    type: "Computer",
    serial: "PF3ABX12",
    model: "Lenovo ThinkPad X1 Carbon G11",
    assignee: { name: "Elena Fox", initials: "EF" },
    location: "LDN — Floor 2",
    status: "deployed",
    lastSync: "2026-08-24",
    vendor: "Lenovo Premier",
    purchaseDate: "2024-03-20",
    warrantyUntil: "2027-03-20",
    costCenter: "SALES-LDN",
    spec: "i7-1355U / 16GB RAM / 512GB",
  },
  {
    id: "OPUS-PHN-7500",
    name: "Ops Pixel 8 Pro",
    type: "Phone",
    serial: "35812110AB",
    model: "Google Pixel 8 Pro",
    assignee: { name: "Tom Nash", initials: "TN" },
    location: "NY — Floor 5",
    status: "deployed",
    lastSync: "2026-08-23",
    vendor: "Google Enterprise",
    purchaseDate: "2024-01-11",
    warrantyUntil: "2026-01-11",
    costCenter: "OPS-NY",
    spec: "128GB / Obsidian",
  },
  {
    id: "OPUS-MON-7501",
    name: "Design LG UltraFine",
    type: "Monitor",
    serial: "912NTLLAT881",
    model: "LG UltraFine 27\" 4K",
    assignee: { name: "Ana López", initials: "AL" },
    location: "SF — HQ — L10",
    status: "deployed",
    lastSync: "2026-08-24",
    vendor: "LG Business",
    purchaseDate: "2023-11-05",
    warrantyUntil: "2026-11-05",
    costCenter: "DESIGN-SF",
    spec: "3840×2160 / Thunderbolt 3",
  },
  {
    id: "OPUS-PRNT-7502",
    name: "Reception MFP — LDN",
    type: "Printer",
    serial: "JKL08876",
    model: "Canon imageRUNNER C3226i",
    assignee: null,
    location: "LDN — Floor 2",
    status: "maintenance",
    lastSync: "2026-08-22",
    vendor: "Canon Business",
    purchaseDate: "2025-01-22",
    warrantyUntil: "2028-01-22",
    costCenter: "FAC-LDN",
    spec: "Color MFP / Scan-to-SMB / Badge auth",
  },
  {
    id: "OPUS-COMP-7503",
    name: "Kenji's iMac 24\"",
    type: "Computer",
    serial: "C02KJ9ABMD",
    model: "iMac 24\" (M3)",
    assignee: { name: "Kenji Ito", initials: "KI" },
    location: "SF — HQ — L4",
    status: "deployed",
    lastSync: "2026-08-25",
    vendor: "Apple Enterprise",
    purchaseDate: "2024-06-18",
    warrantyUntil: "2027-06-18",
    costCenter: "ENG-CORE-SF",
    spec: "16GB RAM / 1TB SSD / Blue",
  },
  {
    id: "OPUS-MON-7504",
    name: "Bay 7 — UltraSharp 27\"",
    type: "Monitor",
    serial: "CN0K2M9P",
    model: "Dell UltraSharp U2723QE",
    assignee: { name: "Kenji Ito", initials: "KI" },
    location: "SF — HQ — L4",
    status: "deployed",
    lastSync: "2026-08-25",
    vendor: "Dell ProSupport",
    purchaseDate: "2024-06-18",
    warrantyUntil: "2027-06-18",
    costCenter: "ENG-CORE-SF",
    spec: "4K / USB-C hub / IPS Black",
  },
  {
    id: "OPUS-COMP-7505",
    name: "Warehouse Latitude",
    type: "Computer",
    serial: "9QW2ZZ3",
    model: "Dell Latitude 5440",
    assignee: null,
    location: "NY — Cage 02",
    status: "storage",
    lastSync: "2026-08-18",
    vendor: "Dell ProSupport",
    purchaseDate: "2023-10-01",
    warrantyUntil: "2026-10-01",
    costCenter: "POOL-NY",
    spec: "i5-1345U / 16GB RAM / 512GB",
  },
  {
    id: "OPUS-PHN-7506",
    name: "Support iPhone SE",
    type: "Phone",
    serial: "F2LLD8QR",
    model: "iPhone SE (3rd gen)",
    assignee: { name: "Rita Boyle", initials: "RB" },
    location: "LDN — Floor 2",
    status: "deployed",
    lastSync: "2026-08-24",
    vendor: "Apple Enterprise",
    purchaseDate: "2023-08-30",
    warrantyUntil: "2025-08-30",
    costCenter: "SUP-LDN",
    spec: "128GB / Midnight",
  },
  {
    id: "OPUS-NET-7507",
    name: "AP — LDN Floor 2",
    type: "Network",
    serial: "FCW2440A9BC",
    model: "Cisco Meraki MR46",
    assignee: null,
    location: "LDN — Floor 2",
    status: "online",
    lastSync: "2026-08-25",
    vendor: "Cisco Meraki",
    purchaseDate: "2024-04-14",
    warrantyUntil: "2029-04-14",
    costCenter: "NET-CORE",
    spec: "Wi-Fi 6 / 4x4 MU-MIMO",
  },
  {
    id: "OPUS-MON-7508",
    name: "Bay 1 — ProArt 32\"",
    type: "Monitor",
    serial: "M4LMQC0091",
    model: "ASUS ProArt PA328CGV",
    assignee: { name: "Ana López", initials: "AL" },
    location: "SF — HQ — L10",
    status: "deployed",
    lastSync: "2026-08-24",
    vendor: "ASUS Business",
    purchaseDate: "2024-02-02",
    warrantyUntil: "2027-02-02",
    costCenter: "DESIGN-SF",
    spec: "QHD / 165Hz / Calman verified",
  },
  {
    id: "OPUS-COMP-7509",
    name: "Finance OptiPlex",
    type: "Computer",
    serial: "3RT8LM2",
    model: "Dell OptiPlex 7010",
    assignee: { name: "Grace Park", initials: "GP" },
    location: "NY — Floor 5",
    status: "deployed",
    lastSync: "2026-08-25",
    vendor: "Dell ProSupport",
    purchaseDate: "2024-07-09",
    warrantyUntil: "2027-07-09",
    costCenter: "FIN-NY",
    spec: "i5-13500 / 16GB RAM / 512GB",
  },
  {
    id: "OPUS-PRNT-7510",
    name: "Label Printer — Cage 01",
    type: "Printer",
    serial: "ZB4X20091",
    model: "Zebra ZT411",
    assignee: null,
    location: "SF — Cage 01",
    status: "online",
    lastSync: "2026-08-25",
    vendor: "Zebra",
    purchaseDate: "2024-03-03",
    warrantyUntil: "2027-03-03",
    costCenter: "FAC-SF",
    spec: "Thermal / 300dpi / Ethernet",
  },
  {
    id: "OPUS-COMP-7511",
    name: "Nadia's MacBook Air",
    type: "Computer",
    serial: "FVFXK220Q6L1",
    model: "MacBook Air 15\" (M2)",
    assignee: { name: "Nadia Ali", initials: "NA" },
    location: "NY — Floor 5",
    status: "deployed",
    lastSync: "2026-08-24",
    vendor: "Apple Enterprise",
    purchaseDate: "2023-11-20",
    warrantyUntil: "2026-11-20",
    costCenter: "MKT-NY",
    spec: "16GB RAM / 512GB SSD / Starlight",
  },
  {
    id: "OPUS-MON-7512",
    name: "Bay 9 — UltraSharp 27\"",
    type: "Monitor",
    serial: "CN0P4R7T",
    model: "Dell UltraSharp U2724DE",
    assignee: { name: "Grace Park", initials: "GP" },
    location: "NY — Floor 5",
    status: "deployed",
    lastSync: "2026-08-25",
    vendor: "Dell ProSupport",
    purchaseDate: "2024-07-09",
    warrantyUntil: "2027-07-09",
    costCenter: "FIN-NY",
    spec: "QHD / 120Hz / USB-C hub",
  },
  {
    id: "OPUS-COMP-7513",
    name: "Lab Precision Tower",
    type: "Computer",
    serial: "8HHT2QD",
    model: "Dell Precision 3660",
    assignee: null,
    location: "SF — HQ — Lab",
    status: "maintenance",
    lastSync: "2026-08-21",
    vendor: "Dell ProSupport",
    purchaseDate: "2023-12-12",
    warrantyUntil: "2026-12-12",
    costCenter: "ENG-CORE-SF",
    spec: "i9-13900 / 64GB RAM / RTX A2000",
  },
  {
    id: "OPUS-PHN-7514",
    name: "Exec iPhone 15",
    type: "Phone",
    serial: "GX9P2L7QT",
    model: "iPhone 15",
    assignee: { name: "Sarah Jenkins", initials: "SJ" },
    location: "SF — HQ — L4",
    status: "deployed",
    lastSync: "2026-08-25",
    vendor: "Apple Enterprise",
    purchaseDate: "2024-09-22",
    warrantyUntil: "2026-09-22",
    costCenter: "EXEC-SF",
    spec: "256GB / Black",
  },
];
