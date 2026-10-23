/**
 * The report data-source catalog (spec 26): what you can report on and which
 * fields each source exposes. Client-safe metadata (the builder renders from it);
 * the matching rows are produced server-side in `src/db/report-engine.ts`, whose
 * row keys MUST match the field ids here. No row here is a secret — these are the
 * same fields already shown around the app.
 */
import { AUDIT_ACTIONS } from "./computer-audit-actions";
import type { ReportField, ReportSource } from "./report-spec";

const ASSET_TYPES = ["Computer", "Monitor", "Printer", "Phone", "Network"];
const ASSET_STATUSES = ["deployed", "maintenance", "online", "storage"];
const ON_OFF = ["on", "off"];

const assetCommon: ReportField[] = [
  { id: "tag", label: "Asset tag", type: "text" },
  { id: "name", label: "Name", type: "text" },
  { id: "status", label: "Status", type: "enum", enumValues: ASSET_STATUSES },
  { id: "serial", label: "Serial", type: "text" },
  { id: "model", label: "Model", type: "text" },
  { id: "vendor", label: "Vendor", type: "text" },
  { id: "location", label: "Location", type: "text" },
  { id: "assignee", label: "Assigned to", type: "text" },
  { id: "costCenter", label: "Cost center", type: "text" },
  { id: "purchaseDate", label: "Purchase date", type: "date" },
  { id: "warrantyUntil", label: "Warranty until", type: "date" },
];

export const REPORT_SOURCES: Record<string, ReportSource> = {
  assets: {
    id: "assets",
    label: "Assets",
    description: "Every asset of every type.",
    fields: [
      { id: "tag", label: "Asset tag", type: "text" },
      { id: "name", label: "Name", type: "text" },
      { id: "type", label: "Type", type: "enum", enumValues: ASSET_TYPES },
      { id: "status", label: "Status", type: "enum", enumValues: ASSET_STATUSES },
      { id: "serial", label: "Serial", type: "text" },
      { id: "model", label: "Model", type: "text" },
      { id: "vendor", label: "Vendor", type: "text" },
      { id: "location", label: "Location", type: "text" },
      { id: "assignee", label: "Assigned to", type: "text" },
      { id: "costCenter", label: "Cost center", type: "text" },
      { id: "spec", label: "Specification", type: "text" },
      { id: "purchaseDate", label: "Purchase date", type: "date" },
      { id: "warrantyUntil", label: "Warranty until", type: "date" },
      { id: "lastSync", label: "Last scan", type: "date" },
      { id: "createdAt", label: "Added on", type: "date" },
    ],
  },
  computers: {
    id: "computers",
    label: "Computers + compliance",
    description: "Computer assets with hardware specs and security posture.",
    fields: [
      ...assetCommon,
      { id: "formFactor", label: "Form factor", type: "enum", enumValues: ["laptop", "desktop", "all-in-one", "tower"] },
      { id: "operatingSystem", label: "Operating system", type: "text" },
      { id: "cpu", label: "CPU", type: "text" },
      { id: "ramGb", label: "RAM (GB)", type: "number" },
      { id: "storage", label: "Storage", type: "text" },
      { id: "ipAddress", label: "IP address", type: "text" },
      { id: "complianceScore", label: "Compliance score", type: "number" },
      { id: "atRisk", label: "At risk", type: "bool" },
      { id: "bitlocker", label: "BitLocker", type: "enum", enumValues: ON_OFF },
      { id: "antivirus", label: "Antivirus", type: "text" },
      { id: "tpmReady", label: "TPM ready", type: "bool" },
      { id: "secureBoot", label: "Secure Boot", type: "enum", enumValues: ON_OFF },
      { id: "updatesLastDays", label: "Days since update", type: "number" },
      { id: "diskPctUsed", label: "System disk % used", type: "number" },
      { id: "assessedAt", label: "Posture assessed", type: "date" },
    ],
  },
  assignments: {
    id: "assignments",
    label: "Assignments (custody)",
    description: "Who has (or had) which device, with dates and duration.",
    fields: [
      { id: "personName", label: "Person", type: "text" },
      { id: "personDepartment", label: "Department", type: "text" },
      { id: "personTitle", label: "Job title", type: "text" },
      { id: "deviceTag", label: "Device tag", type: "text" },
      { id: "deviceName", label: "Device", type: "text" },
      { id: "deviceType", label: "Device type", type: "enum", enumValues: ASSET_TYPES },
      { id: "status", label: "Status", type: "enum", enumValues: ["current", "returned"] },
      { id: "assignedAt", label: "Assigned on", type: "date" },
      { id: "unassignedAt", label: "Returned on", type: "date" },
      { id: "assignedBy", label: "Assigned by", type: "text" },
      { id: "durationDays", label: "Days held", type: "number" },
    ],
  },
  people: {
    id: "people",
    label: "People",
    description: "The staff directory and how many devices each person holds.",
    fields: [
      { id: "name", label: "Name", type: "text" },
      { id: "email", label: "Email", type: "text" },
      { id: "department", label: "Department", type: "text" },
      { id: "jobTitle", label: "Job title", type: "text" },
      { id: "phone", label: "Phone", type: "text" },
      { id: "employeeId", label: "Employee ID", type: "text" },
      { id: "status", label: "Status", type: "enum", enumValues: ["active", "archived"] },
      { id: "officeLocation", label: "Office location", type: "text" },
      { id: "deviceCount", label: "Devices held", type: "number" },
      { id: "createdAt", label: "Added on", type: "date" },
    ],
  },
  software: {
    id: "software",
    label: "Software (tracked installs)",
    description: "Each tracked-software install, by title and machine.",
    fields: [
      { id: "title", label: "Tracked title", type: "text" },
      { id: "program", label: "Program", type: "text" },
      { id: "version", label: "Version", type: "text" },
      { id: "publisher", label: "Publisher", type: "text" },
      { id: "architecture", label: "Architecture", type: "enum", enumValues: ["x64", "x86", "user"] },
      { id: "machineTag", label: "Machine tag", type: "text" },
      { id: "machineName", label: "Machine", type: "text" },
      { id: "machineLocation", label: "Machine location", type: "text" },
    ],
  },
  printers: {
    id: "printers",
    label: "Printers",
    description: "Printer assets with page counts and reachability.",
    fields: [
      { id: "tag", label: "Asset tag", type: "text" },
      { id: "name", label: "Name", type: "text" },
      { id: "model", label: "Model", type: "text" },
      { id: "vendor", label: "Vendor", type: "text" },
      { id: "location", label: "Location", type: "text" },
      { id: "serial", label: "Serial", type: "text" },
      { id: "ipAddress", label: "IP address", type: "text" },
      { id: "totalPages", label: "Total pages", type: "number" },
      { id: "reachability", label: "Reachability", type: "enum", enumValues: ["up", "down", "unknown"] },
      { id: "consecutiveFailures", label: "Consecutive failures", type: "number" },
      { id: "lastCheckedAt", label: "Last checked", type: "date" },
    ],
  },
  computerAuditEvents: {
    id: "computerAuditEvents",
    label: "Computer audit events",
    description: "Computer actions: deploys, patches, reboots, scripts, sessions, and asset changes.",
    fields: [
      { id: "occurredAt", label: "Occurred at", type: "date" },
      { id: "assetTag", label: "Asset tag", type: "text" },
      { id: "assetName", label: "Asset", type: "text" },
      { id: "serial", label: "Serial", type: "text" },
      { id: "action", label: "Action", type: "enum", enumValues: [...AUDIT_ACTIONS] },
      {
        id: "status",
        label: "Status",
        type: "enum",
        enumValues: ["pending", "succeeded", "failed", "canceled"],
      },
      { id: "operator", label: "Operator", type: "text" },
      {
        id: "source",
        label: "Source",
        type: "enum",
        enumValues: ["admin_console", "scheduled", "collector"],
      },
      { id: "summary", label: "Summary", type: "text" },
      { id: "flagged", label: "Flagged", type: "bool" },
      { id: "location", label: "Location", type: "text" },
    ],
  },
};

export const REPORT_SOURCE_LIST: ReportSource[] = Object.values(REPORT_SOURCES);

/** The field catalog (id → ReportField) for a source, for `runReport`/validation. */
export function fieldMap(sourceId: string): Record<string, ReportField> {
  const src = REPORT_SOURCES[sourceId];
  if (!src) return {};
  return Object.fromEntries(src.fields.map((f) => [f.id, f]));
}
