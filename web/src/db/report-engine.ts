import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "./index";
import { getLocationPathMap, getPrinterCounterMap } from "./queries";
import {
  assets,
  assetAssignments,
  complianceStatus,
  computerDetails,
  installedSoftware,
  people,
  printerDetails,
  printerStatus,
  reportDefinitions,
  trackedSoftware,
} from "./schema";
import {
  isAtRisk,
  scoreCompliance,
  type CompliancePosture,
} from "@/lib/compliance-score";
import { fieldMap, REPORT_SOURCES } from "@/lib/report-sources";
import {
  runReport,
  type ReportResult,
  type ReportRow,
  type ReportSpec,
} from "@/lib/report-spec";

/* ================================================================
   Reporting engine (spec 26). Each data source is a denormalized
   server query returning flat rows whose keys match the field ids
   in `report-sources.ts`. `runReportBySpec` fetches the source and
   runs the pure `runReport` over it. The fleet is ~hundreds of rows,
   so filtering/grouping/sorting happens in memory (one readable
   place); SQL push-down is a later scale optimization. Server-only.
   ================================================================ */

const toIso = (d: Date | null): string | null => (d ? d.toISOString() : null);

async function assetsSource(): Promise<ReportRow[]> {
  const paths = await getLocationPathMap();
  const rows = await db
    .select({
      tag: assets.tag,
      name: assets.name,
      type: assets.type,
      status: assets.status,
      serial: assets.serial,
      model: assets.model,
      vendor: assets.vendor,
      locationId: assets.locationId,
      assignee: people.name,
      costCenter: assets.costCenter,
      spec: assets.spec,
      purchaseDate: assets.purchaseDate,
      warrantyUntil: assets.warrantyUntil,
      lastSync: assets.lastSync,
      createdAt: assets.createdAt,
    })
    .from(assets)
    .leftJoin(people, eq(people.id, assets.assigneeId));
  return rows.map((r) => ({
    tag: r.tag,
    name: r.name,
    type: r.type,
    status: r.status,
    serial: r.serial,
    model: r.model,
    vendor: r.vendor,
    location: r.locationId ? paths.get(r.locationId) ?? null : null,
    assignee: r.assignee,
    costCenter: r.costCenter,
    spec: r.spec,
    purchaseDate: r.purchaseDate,
    warrantyUntil: r.warrantyUntil,
    lastSync: toIso(r.lastSync),
    createdAt: toIso(r.createdAt),
  }));
}

async function computersSource(): Promise<ReportRow[]> {
  const paths = await getLocationPathMap();
  const rows = await db
    .select({
      tag: assets.tag,
      name: assets.name,
      status: assets.status,
      serial: assets.serial,
      model: assets.model,
      vendor: assets.vendor,
      locationId: assets.locationId,
      assignee: people.name,
      costCenter: assets.costCenter,
      purchaseDate: assets.purchaseDate,
      warrantyUntil: assets.warrantyUntil,
      formFactor: computerDetails.formFactor,
      operatingSystem: computerDetails.operatingSystem,
      cpu: computerDetails.cpu,
      ramGb: computerDetails.ramGb,
      storage: computerDetails.storage,
      ipAddress: computerDetails.ipAddress,
      bitlocker: complianceStatus.bitlocker,
      defenderRealtime: complianceStatus.defenderRealtime,
      defenderSigAgeDays: complianceStatus.defenderSigAgeDays,
      avProduct: complianceStatus.avProduct,
      tpmReady: complianceStatus.tpmReady,
      secureBoot: complianceStatus.secureBoot,
      updatesLastDays: complianceStatus.updatesLastDays,
      updatesPending: complianceStatus.updatesPending,
      systemDrivePctUsed: complianceStatus.systemDrivePctUsed,
      assessedAt: complianceStatus.assessedAt,
    })
    .from(assets)
    .leftJoin(people, eq(people.id, assets.assigneeId))
    .leftJoin(computerDetails, eq(computerDetails.assetId, assets.id))
    .leftJoin(complianceStatus, eq(complianceStatus.assetId, assets.id))
    .where(eq(assets.type, "Computer"));

  return rows.map((r) => {
    const posture: CompliancePosture = {
      bitlocker: r.bitlocker,
      defenderRealtime: r.defenderRealtime,
      defenderSigAgeDays: r.defenderSigAgeDays,
      avProduct: r.avProduct,
      tpmReady: r.tpmReady,
      secureBoot: r.secureBoot,
      updatesLastDays: r.updatesLastDays,
      updatesPending: r.updatesPending,
      systemDrivePctUsed: r.systemDrivePctUsed,
    };
    const score = scoreCompliance(posture);
    return {
      tag: r.tag,
      name: r.name,
      status: r.status,
      serial: r.serial,
      model: r.model,
      vendor: r.vendor,
      location: r.locationId ? paths.get(r.locationId) ?? null : null,
      assignee: r.assignee,
      costCenter: r.costCenter,
      purchaseDate: r.purchaseDate,
      warrantyUntil: r.warrantyUntil,
      formFactor: r.formFactor,
      operatingSystem: r.operatingSystem,
      cpu: r.cpu,
      ramGb: r.ramGb,
      storage: r.storage,
      ipAddress: r.ipAddress,
      complianceScore: score.assessed ? score.score : null,
      atRisk: score.assessed ? isAtRisk(score) : null,
      bitlocker: r.bitlocker,
      antivirus: r.avProduct,
      tpmReady: r.tpmReady,
      secureBoot: r.secureBoot,
      updatesLastDays: r.updatesLastDays,
      diskPctUsed: r.systemDrivePctUsed,
      assessedAt: toIso(r.assessedAt),
    };
  });
}

async function assignmentsSource(): Promise<ReportRow[]> {
  const rows = await db
    .select({
      personName: people.name,
      personDepartment: people.department,
      personTitle: people.jobTitle,
      deviceTag: assets.tag,
      deviceName: assets.name,
      deviceType: assets.type,
      assignedAt: assetAssignments.assignedAt,
      unassignedAt: assetAssignments.unassignedAt,
      assignedBy: assetAssignments.assignedBy,
    })
    .from(assetAssignments)
    .innerJoin(people, eq(people.id, assetAssignments.personId))
    .innerJoin(assets, eq(assets.id, assetAssignments.assetId));
  const now = Date.now();
  return rows.map((r) => {
    const start = r.assignedAt.getTime();
    const end = r.unassignedAt ? r.unassignedAt.getTime() : now;
    return {
      personName: r.personName,
      personDepartment: r.personDepartment,
      personTitle: r.personTitle,
      deviceTag: r.deviceTag,
      deviceName: r.deviceName,
      deviceType: r.deviceType,
      status: r.unassignedAt ? "returned" : "current",
      assignedAt: toIso(r.assignedAt),
      unassignedAt: toIso(r.unassignedAt),
      assignedBy: r.assignedBy,
      durationDays: Math.max(0, Math.round((end - start) / 86_400_000)),
    };
  });
}

async function peopleSource(): Promise<ReportRow[]> {
  const paths = await getLocationPathMap();
  const rows = await db
    .select({
      name: people.name,
      email: people.email,
      department: people.department,
      jobTitle: people.jobTitle,
      phone: people.phone,
      employeeId: people.employeeId,
      status: people.status,
      officeLocationId: people.officeLocationId,
      createdAt: people.createdAt,
      deviceCount: sql<number>`count(${assets.id})::int`,
    })
    .from(people)
    .leftJoin(assets, eq(assets.assigneeId, people.id))
    .groupBy(people.id);
  return rows.map((r) => ({
    name: r.name,
    email: r.email,
    department: r.department,
    jobTitle: r.jobTitle,
    phone: r.phone,
    employeeId: r.employeeId,
    status: r.status,
    officeLocation: r.officeLocationId ? paths.get(r.officeLocationId) ?? null : null,
    deviceCount: r.deviceCount,
    createdAt: toIso(r.createdAt),
  }));
}

async function softwareSource(): Promise<ReportRow[]> {
  const paths = await getLocationPathMap();
  const rows = await db
    .select({
      title: trackedSoftware.name,
      program: installedSoftware.name,
      version: installedSoftware.version,
      publisher: installedSoftware.publisher,
      architecture: installedSoftware.architecture,
      machineTag: assets.tag,
      machineName: assets.name,
      locationId: assets.locationId,
    })
    .from(installedSoftware)
    .innerJoin(trackedSoftware, eq(trackedSoftware.id, installedSoftware.trackedId))
    .innerJoin(assets, eq(assets.id, installedSoftware.assetId));
  return rows.map((r) => ({
    title: r.title,
    program: r.program,
    version: r.version,
    publisher: r.publisher,
    architecture: r.architecture,
    machineTag: r.machineTag,
    machineName: r.machineName,
    machineLocation: r.locationId ? paths.get(r.locationId) ?? null : null,
  }));
}

async function printersSource(): Promise<ReportRow[]> {
  const [paths, counters] = await Promise.all([
    getLocationPathMap(),
    getPrinterCounterMap(),
  ]);
  const rows = await db
    .select({
      tag: assets.tag,
      name: assets.name,
      model: assets.model,
      vendor: assets.vendor,
      locationId: assets.locationId,
      serial: assets.serial,
      ipAddress: printerDetails.ipAddress,
      isDown: printerStatus.isDown,
      consecutiveFailures: printerStatus.consecutiveFailures,
      lastCheckedAt: printerStatus.lastCheckedAt,
    })
    .from(assets)
    .leftJoin(printerDetails, eq(printerDetails.assetId, assets.id))
    .leftJoin(printerStatus, eq(printerStatus.assetId, assets.id))
    .where(eq(assets.type, "Printer"));
  return rows.map((r) => ({
    tag: r.tag,
    name: r.name,
    model: r.model,
    vendor: r.vendor,
    location: r.locationId ? paths.get(r.locationId) ?? null : null,
    serial: r.serial,
    ipAddress: r.ipAddress,
    totalPages: counters[r.tag] ?? null,
    reachability: r.lastCheckedAt == null ? "unknown" : r.isDown ? "down" : "up",
    consecutiveFailures: r.lastCheckedAt == null ? null : r.consecutiveFailures,
    lastCheckedAt: toIso(r.lastCheckedAt),
  }));
}

const SOURCE_FETCHERS: Record<string, () => Promise<ReportRow[]>> = {
  assets: assetsSource,
  computers: computersSource,
  assignments: assignmentsSource,
  people: peopleSource,
  software: softwareSource,
  printers: printersSource,
};

/** Fetch a source's rows and run the spec over them. Throws on an unknown source. */
export async function runReportBySpec(spec: ReportSpec): Promise<ReportResult> {
  const fetcher = SOURCE_FETCHERS[spec.source];
  if (!fetcher) throw new Error(`Unknown report source: ${spec.source}`);
  const rows = await fetcher();
  return runReport(rows, spec, fieldMap(spec.source));
}

/* ----------------------------- saved definitions ----------------------------- */

export interface SavedReport {
  id: string;
  name: string;
  description: string | null;
  source: string;
  spec: ReportSpec;
  createdBy: string | null;
  updatedAt: string;
}

function toSaved(r: typeof reportDefinitions.$inferSelect): SavedReport {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    source: r.source,
    spec: r.spec,
    createdBy: r.createdBy,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listReports(): Promise<SavedReport[]> {
  const rows = await db
    .select()
    .from(reportDefinitions)
    .orderBy(reportDefinitions.name);
  return rows.map(toSaved);
}

export async function getReport(id: string): Promise<SavedReport | null> {
  const [r] = await db
    .select()
    .from(reportDefinitions)
    .where(eq(reportDefinitions.id, id))
    .limit(1);
  return r ? toSaved(r) : null;
}

export async function createReport(input: {
  name: string;
  description?: string | null;
  source: string;
  spec: ReportSpec;
  createdBy: string | null;
}): Promise<SavedReport> {
  const [r] = await db
    .insert(reportDefinitions)
    .values({
      name: input.name,
      description: input.description ?? null,
      source: input.source,
      spec: input.spec,
      createdBy: input.createdBy,
    })
    .returning();
  return toSaved(r);
}

export async function updateReport(
  id: string,
  input: { name: string; description?: string | null; source: string; spec: ReportSpec },
): Promise<SavedReport | null> {
  const [r] = await db
    .update(reportDefinitions)
    .set({
      name: input.name,
      description: input.description ?? null,
      source: input.source,
      spec: input.spec,
      updatedAt: new Date(),
    })
    .where(eq(reportDefinitions.id, id))
    .returning();
  return r ? toSaved(r) : null;
}

export async function deleteReport(id: string): Promise<boolean> {
  const rows = await db
    .delete(reportDefinitions)
    .where(eq(reportDefinitions.id, id))
    .returning({ id: reportDefinitions.id });
  return rows.length > 0;
}

/** Validate a spec against the catalog at the save boundary: known source, ≥1
 * column or group, and every referenced field exists in the source. Returns a
 * cleaned spec (unknown field refs dropped) or an error message. */
export function validateSpec(
  source: string,
  spec: ReportSpec,
): { ok: true; spec: ReportSpec } | { ok: false; error: string } {
  const src = REPORT_SOURCES[source];
  if (!src) return { ok: false, error: "Unknown data source." };
  const known = new Set(src.fields.map((f) => f.id));
  // Keep a chart only when its shape is valid; its fields are RESULT-column ids
  // (which may be `_count` / aggregate ids, not source fields), so they aren't
  // checked against `known` here — the render path is defensive (`canRenderChart`)
  // and simply draws nothing if a field no longer resolves.
  const c = spec.chart;
  const chart =
    c &&
    (c.type === "bar" || c.type === "donut") &&
    typeof c.categoryField === "string" &&
    c.categoryField &&
    typeof c.valueField === "string" &&
    c.valueField
      ? { type: c.type, categoryField: c.categoryField, valueField: c.valueField }
      : null;

  const cleaned: ReportSpec = {
    source,
    columns: (spec.columns ?? []).filter((c) => known.has(c)),
    filters: (spec.filters ?? []).filter((f) => known.has(f.field)),
    groupBy: (spec.groupBy ?? []).filter((g) => known.has(g)),
    aggregates: (spec.aggregates ?? []).filter((a) => known.has(a.field)),
    sort: (spec.sort ?? []).filter((s) => known.has(s.field) || s.field === "_count"),
    limit: spec.limit ?? null,
    chart,
  };
  if (cleaned.columns.length === 0 && (cleaned.groupBy?.length ?? 0) === 0) {
    return { ok: false, error: "Pick at least one column (or a grouping)." };
  }
  return { ok: true, spec: cleaned };
}
