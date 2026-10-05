import "server-only";

import { eq, or, sql } from "drizzle-orm";

import { upsertPrinterCounter } from "./counters";
import { db } from "./index";
import { replaceInstalledSoftware, type PostedSoftware } from "./software";
import {
  assets,
  computerDetails,
  machines,
  networkDetails,
  printerDetails,
} from "./schema";

// Loose shapes matching the collector's HostResult payload.
interface IngestDisk {
  model?: string | null;
  size_gb?: number | null;
  media_type?: string | null;
}
interface IngestHardware {
  serial?: string | null;
  hardware_uuid?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  cpu?: string | null;
  ram_gb?: number | null;
  disks?: IngestDisk[] | null;
  [k: string]: unknown;
}
interface IngestHealth {
  os_name?: string | null;
  os_version?: string | null;
  os_build?: string | null;
  [k: string]: unknown;
}
interface IngestPrinter {
  serial?: string | null;
  page_count?: number | null;
  [k: string]: unknown;
}
export interface IngestHost {
  ip?: string | null;
  subnet?: string | null;
  device_type?: string | null;
  hostname?: string | null;
  credential_profile?: string | null;
  hardware?: IngestHardware | null;
  health?: IngestHealth | null;
  printer?: IngestPrinter | null;
  // Installed programs from a Windows collect (spec 15). null/absent = not
  // collected (leave stored software intact); an array = the current set.
  software?: PostedSoftware[] | null;
  errors?: string[];
}
export interface IngestPayload {
  run_id?: string;
  hosts?: IngestHost[];
}

export interface IngestResult {
  received: number;
  upserted: number;
  matched: number;
  discovered: number;
  skipped: number;
}

function clean(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return v || null;
}

/** A human storage summary from the scanned disks, e.g. "476 GB + 931 GB". */
function summarizeDisks(disks: IngestDisk[] | null | undefined): string | null {
  if (!Array.isArray(disks)) return null;
  const parts = disks
    .map((d) => (typeof d.size_gb === "number" ? `${Math.round(d.size_gb)} GB` : null))
    .filter((p): p is string => p != null);
  return parts.length ? parts.join(" + ") : null;
}

/**
 * Overwrite an asset's technical fields from a scan (the user's chosen behavior:
 * the scan is authoritative). Only fields the scan actually returned a value for are
 * written — a field the collector didn't read never blanks an existing value — and
 * only the technical fields the scan can know (serial/model/vendor and, for a
 * computer, cpu/ram/os/storage). Human and admin fields (name, location, cost
 * center, dates, assignee) are never touched. Best-effort: a failure here must not
 * fail the machine ingest.
 */
async function applyScanToAsset(
  assetId: string,
  assetType: string | null,
  hw: IngestHardware | null,
  health: IngestHealth | null,
  serial: string | null,
  now: Date,
): Promise<void> {
  // Shared asset fields the scan can supply.
  const assetSet: Partial<{
    serial: string | null;
    model: string | null;
    vendor: string | null;
  }> = {};
  if (serial) assetSet.serial = serial;
  const model = clean(hw?.model);
  if (model) assetSet.model = model;
  const vendor = clean(hw?.manufacturer);
  if (vendor) assetSet.vendor = vendor;
  if (Object.keys(assetSet).length) {
    await db
      .update(assets)
      .set({ ...assetSet, updatedAt: now })
      .where(eq(assets.id, assetId));
  }

  // Computer-specific detail fields (spec 10), from the WinRM collect.
  if (assetType === "Computer" && hw) {
    const detailSet: Partial<{
      cpu: string | null;
      ramGb: number | null;
      operatingSystem: string | null;
      storage: string | null;
    }> = {};
    const cpu = clean(hw.cpu);
    if (cpu) detailSet.cpu = cpu;
    if (typeof hw.ram_gb === "number") detailSet.ramGb = Math.round(hw.ram_gb);
    const os = [clean(health?.os_name), clean(health?.os_version)]
      .filter(Boolean)
      .join(" ");
    if (os) detailSet.operatingSystem = os;
    const storage = summarizeDisks(hw.disks);
    if (storage) detailSet.storage = storage;

    if (Object.keys(detailSet).length) {
      // The 1:1 detail row may not exist yet (created on first manual save), so upsert.
      await db
        .insert(computerDetails)
        .values({ assetId, ...detailSet })
        .onConflictDoUpdate({ target: computerDetails.assetId, set: detailSet });
    }
  }
}

export async function ingestScan(payload: IngestPayload): Promise<IngestResult> {
  const hosts = payload.hosts ?? [];
  const now = new Date();
  const result: IngestResult = {
    received: hosts.length,
    upserted: 0,
    matched: 0,
    discovered: 0,
    skipped: 0,
  };

  for (const h of hosts) {
    const hw = h.hardware ?? null;
    const pr = h.printer ?? null;
    const serial = clean(hw?.serial ?? pr?.serial ?? null);
    const hardwareUuid = clean(hw?.hardware_uuid ?? null);
    const hostname = clean(h.hostname ?? null);
    const ip = clean(h.ip ?? null);

    const matchKey = hardwareUuid || serial || hostname || ip;
    if (!matchKey) {
      result.skipped += 1;
      continue;
    }

    // Reconcile to an existing asset by serial. Capture its type too, so the
    // ingest can enforce "software only for Computer assets" (spec 15, AC-3).
    let assetId: string | null = null;
    let assetType: string | null = null;
    if (serial) {
      const found = await db
        .select({ id: assets.id, type: assets.type })
        .from(assets)
        .where(eq(assets.serial, serial))
        .limit(1);
      if (found.length) {
        assetId = found[0].id;
        assetType = found[0].type;
      }
    }

    // Fall back to matching a manually-entered device by its IP. For a printer,
    // `printer_details.ipAddress` is the device's identity (spec 12), so a printer
    // whose SNMP serial differs from — or is missing on — the asset still links to
    // the right asset when scanned at its IP. Same for a network/computer detail IP.
    if (!assetId && ip) {
      const byIp = await db
        .select({ id: assets.id, type: assets.type })
        .from(assets)
        .leftJoin(printerDetails, eq(printerDetails.assetId, assets.id))
        .leftJoin(networkDetails, eq(networkDetails.assetId, assets.id))
        .leftJoin(computerDetails, eq(computerDetails.assetId, assets.id))
        .where(
          or(
            eq(printerDetails.ipAddress, ip),
            eq(networkDetails.ipAddress, ip),
            eq(computerDetails.ipAddress, ip),
          ),
        )
        .limit(1);
      if (byIp.length) {
        assetId = byIp[0].id;
        assetType = byIp[0].type;
      }
    }

    const kind = h.device_type ?? (pr ? "printer" : hw ? "windows" : "unknown");
    const hasData = Boolean(hw || pr);
    const status = !hasData && h.errors?.length ? "error" : "ok";

    const row = {
      matchKey,
      assetId,
      kind,
      hostname,
      ip,
      subnet: clean(h.subnet ?? null),
      serial,
      hardwareUuid,
      osName: clean(h.health?.os_name ?? null),
      osVersion: clean(h.health?.os_version ?? null),
      osBuild: clean(h.health?.os_build ?? null),
      hardware: hw,
      health: h.health ?? null,
      printer: pr,
      credentialProfile: clean(h.credential_profile ?? null),
      lastScanStatus: status,
      lastSeenAt: now,
    };

    // On re-scan, refresh the scan fields but never move a row backward: keep an
    // existing (manually linked or previously matched) assetId, and never touch
    // ignoredAt. A serial match still fills in assetId for a row that was unlinked.
    await db
      .insert(machines)
      .values(row)
      .onConflictDoUpdate({
        target: machines.matchKey,
        set: {
          ...row,
          assetId: sql`coalesce(${machines.assetId}, ${assetId})`,
          updatedAt: now,
        },
      });
    result.upserted += 1;

    if (assetId) {
      result.matched += 1;
      await db
        .update(assets)
        .set({ lastSync: now, updatedAt: now })
        .where(eq(assets.id, assetId));

      // Overwrite the asset's technical fields from the scan (best-effort). A
      // failure here must never fail the machine ingest.
      try {
        await applyScanToAsset(assetId, assetType, hw, h.health ?? null, serial, now);
      } catch (err) {
        console.error(`[ingest] asset enrich failed for asset ${assetId}:`, err);
      }

      // Record today's printer page-counter snapshot (spec 14, AC-2). Rides this
      // existing ingest: any matched printer that returned a numeric life counter
      // updates the one row for today (idempotent per day). Best-effort — a
      // counter write must never fail the ingest of the machine itself.
      if (kind === "printer" && typeof pr?.page_count === "number") {
        try {
          await upsertPrinterCounter(assetId, pr.page_count, "scheduled", now);
        } catch (err) {
          console.error(
            `[ingest] printer-counter snapshot failed for asset ${assetId}:`,
            err,
          );
        }
      }

      // Software inventory (spec 15, AC-3): for a matched Computer asset, replace
      // its tracked software with the watchlist matches from this scan. Only
      // Computer assets get rows; `software == null` means the collector didn't
      // read software (non-Windows or a read failure), so the prior set is left
      // intact. Best-effort — a software write must never fail the machine ingest.
      if (assetType === "Computer" && Array.isArray(h.software)) {
        try {
          await replaceInstalledSoftware(assetId, h.software, now);
        } catch (err) {
          console.error(
            `[ingest] software inventory failed for asset ${assetId}:`,
            err,
          );
        }
      }
    } else {
      result.discovered += 1;
    }
  }

  return result;
}
