import "server-only";

import { eq, or, sql } from "drizzle-orm";

import { db } from "./index";
import {
  assets,
  computerDetails,
  machines,
  networkDetails,
  printerDetails,
} from "./schema";

// Loose shapes matching the collector's HostResult payload.
interface IngestHardware {
  serial?: string | null;
  hardware_uuid?: string | null;
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

    // Reconcile to an existing asset by serial.
    let assetId: string | null = null;
    if (serial) {
      const found = await db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.serial, serial))
        .limit(1);
      if (found.length) assetId = found[0].id;
    }

    // Fall back to matching a manually-entered device by its IP. For a printer,
    // `printer_details.ipAddress` is the device's identity (spec 12), so a printer
    // whose SNMP serial differs from — or is missing on — the asset still links to
    // the right asset when scanned at its IP. Same for a network/computer detail IP.
    if (!assetId && ip) {
      const byIp = await db
        .select({ id: assets.id })
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
      if (byIp.length) assetId = byIp[0].id;
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
    } else {
      result.discovered += 1;
    }
  }

  return result;
}
