import "server-only";

import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import {
  evaluateComplianceAlert,
  upsertComplianceStatus,
  type PostedCompliance,
} from "./compliance";
import { upsertPrinterCounter } from "./counters";
import { db } from "./index";
import {
  autoCreateExternalMonitors,
  replaceConnectedMonitors,
  type PostedMonitor,
} from "./monitors";
import { createNotification } from "./notifications";
import { assignAsset } from "./assignments";
import { replaceInstalledSoftware, type PostedSoftware } from "./software";
import {
  upsertWindowsUpdates,
  type PostedWindowsUpdates,
} from "./patches";
import {
  assets,
  computerDetails,
  machines,
  networkDetails,
  people,
  phoneDetails,
  printerDetails,
} from "./schema";

/** Custody-log actor for scan-driven phone assignments (spec 27 AC-6). */
const SCAN_ASSIGN_ACTOR = "collector";

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
// VoIP desk phone (spec 27). Phase 1 sends mac + model (credential-free, from the
// TLS cert); phase 2 adds vendor, serial (Yealink Machine ID), firmware,
// extension, display_name (SIP account display), register_status.
interface IngestPhone {
  mac?: string | null;
  model?: string | null;
  vendor?: string | null;
  serial?: string | null;
  extension?: string | null;
  display_name?: string | null;
  firmware?: string | null;
  register_status?: string | null;
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
  phone?: IngestPhone | null;
  // Installed programs from a Windows collect (spec 15). null/absent = not
  // collected (leave stored software intact); an array = the current set.
  software?: PostedSoftware[] | null;
  // Connected displays (spec 25). null/absent = not read (leave stored set intact);
  // an array = the current set.
  monitors?: PostedMonitor[] | null;
  // Security posture from a Windows collect (spec 21). null/absent = not
  // collected (leave the prior posture row intact).
  compliance?: PostedCompliance | null;
  // Patch inventory (spec 31). null/absent = not collected (leave prior rows).
  updates?: PostedWindowsUpdates | null;
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
 * center, dates) are never touched here. Phone Assigned To is a separate
 * best-effort step: a unique People-directory name match can assign an
 * *unassigned* phone (never overrides a manual assignment). Best-effort: a
 * failure here must not fail the machine ingest.
 */
async function applyScanToAsset(
  assetId: string,
  assetType: string | null,
  hw: IngestHardware | null,
  health: IngestHealth | null,
  serial: string | null,
  now: Date,
  phone: IngestPhone | null,
  ip: string | null,
): Promise<void> {
  // Shared asset fields the scan can supply. A phone contributes its model
  // (from the HTTPS title or the phase-2 wui bag), its vendor ("Yealink",
  // locked by the cert issuer), and its machine id as the asset serial —
  // the closest a desk phone has to a hardware serial, printed on the back
  // of the device and used by Yealink for RMA.
  const assetSet: Partial<{
    serial: string | null;
    model: string | null;
    vendor: string | null;
  }> = {};
  if (serial) assetSet.serial = serial;
  const model = clean(hw?.model ?? phone?.model);
  if (model) assetSet.model = model;
  const vendor = clean(hw?.manufacturer ?? phone?.vendor);
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

  // Desk-phone detail fields (spec 27), from the credential-free scan (mac/ip) and
  // any phase-2 enrichment (extension/firmware/register). Only written values are
  // set, so a field the scan didn't read never blanks a manually-entered one.
  if (assetType === "Phone" && phone) {
    const detailSet: Partial<{
      mac: string | null;
      extension: string | null;
      ipAddress: string | null;
      firmware: string | null;
      registerStatus: string | null;
      displayName: string | null;
    }> = {};
    const m = clean(phone.mac);
    if (m) detailSet.mac = m;
    const ext = clean(phone.extension);
    if (ext) detailSet.extension = ext;
    if (ip) detailSet.ipAddress = ip;
    const fw = clean(phone.firmware);
    if (fw) detailSet.firmware = fw;
    const reg = clean(phone.register_status);
    if (reg) detailSet.registerStatus = reg;
    const dn = clean(phone.display_name);
    if (dn) detailSet.displayName = dn;

    if (Object.keys(detailSet).length) {
      await db
        .insert(phoneDetails)
        .values({ assetId, ...detailSet })
        .onConflictDoUpdate({ target: phoneDetails.assetId, set: detailSet });
    }
  }
}

/**
 * If the SIP display name uniquely matches one active person and the phone is
 * currently unassigned, assign it through the spec-16 engine so Assigned To and
 * the custody log stay in step. Ambiguous names (two "John Smith"s) and phones
 * already assigned are left alone.
 */
async function maybeAssignPhoneByDisplayName(
  assetId: string,
  displayName: string,
): Promise<void> {
  const name = displayName.trim().replace(/\s+/g, " ");
  if (!name) return;

  const [asset] = await db
    .select({ assigneeId: assets.assigneeId, type: assets.type })
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);
  if (!asset || asset.type !== "Phone" || asset.assigneeId) return;

  const matches = await db
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        eq(people.status, "active"),
        sql`lower(btrim(${people.name})) = ${name.toLowerCase()}`,
      ),
    )
    .limit(2);
  if (matches.length !== 1) return;

  await assignAsset(assetId, matches[0].id, SCAN_ASSIGN_ACTOR);
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
    const ph = h.phone ?? null;
    // A phone's phase-2 serial is Yealink's Machine ID — the device's stable
    // identifier (never changes across resets). Treat it like any other scan
    // serial so a phone reconciles by serial on subsequent scans too, not
    // only by MAC.
    const serial = clean(hw?.serial ?? pr?.serial ?? ph?.serial ?? null);
    const hardwareUuid = clean(hw?.hardware_uuid ?? null);
    const mac = clean(ph?.mac ?? null); // a phone's stable identity (spec 27)
    const hostname = clean(h.hostname ?? null);
    const ip = clean(h.ip ?? null);

    // MAC is a strong key (a phone has no serial/hardware uuid), above hostname/ip.
    const matchKey = hardwareUuid || serial || mac || hostname || ip;
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

    // Reconcile a phone by its MAC (spec 27): phones have no scan-readable serial,
    // so `phone_details.mac` is the identity — a phone whose IP changed still links.
    if (!assetId && mac) {
      const byMac = await db
        .select({ id: assets.id, type: assets.type })
        .from(assets)
        .innerJoin(phoneDetails, eq(phoneDetails.assetId, assets.id))
        .where(eq(phoneDetails.mac, mac))
        .limit(1);
      if (byMac.length) {
        assetId = byMac[0].id;
        assetType = byMac[0].type;
      }
    }

    // Fall back to matching a manually-entered device by its IP. For a printer,
    // `printer_details.ipAddress` is the device's identity (spec 12), so a printer
    // whose SNMP serial differs from — or is missing on — the asset still links to
    // the right asset when scanned at its IP. Same for a network/computer/phone
    // detail IP — this is how a manually-added phone (no MAC yet) first links to its
    // scan, which then fills in its MAC for subsequent reconciliation (spec 27).
    if (!assetId && ip) {
      const byIp = await db
        .select({ id: assets.id, type: assets.type })
        .from(assets)
        .leftJoin(printerDetails, eq(printerDetails.assetId, assets.id))
        .leftJoin(networkDetails, eq(networkDetails.assetId, assets.id))
        .leftJoin(computerDetails, eq(computerDetails.assetId, assets.id))
        .leftJoin(phoneDetails, eq(phoneDetails.assetId, assets.id))
        .where(
          or(
            eq(printerDetails.ipAddress, ip),
            eq(networkDetails.ipAddress, ip),
            eq(computerDetails.ipAddress, ip),
            eq(phoneDetails.ipAddress, ip),
          ),
        )
        .limit(1);
      if (byIp.length) {
        assetId = byIp[0].id;
        assetType = byIp[0].type;
      }
    }

    const kind =
      h.device_type ?? (pr ? "printer" : ph ? "phone" : hw ? "windows" : "unknown");
    const hasData = Boolean(hw || pr || ph);
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
      phone: ph,
      credentialProfile: clean(h.credential_profile ?? null),
      lastScanStatus: status,
      lastSeenAt: now,
    };

    // On re-scan, refresh the scan fields but never move a row backward: keep an
    // existing (manually linked or previously matched) assetId, and never touch
    // ignoredAt. A serial match still fills in assetId for a row that was unlinked.
    const [upserted] = await db
      .insert(machines)
      .values(row)
      .onConflictDoUpdate({
        target: machines.matchKey,
        set: {
          ...row,
          assetId: sql`coalesce(${machines.assetId}, ${assetId})`,
          updatedAt: now,
        },
      })
      .returning({ id: machines.id });
    result.upserted += 1;

    // Clean up a stale weak-identity shadow row. When an earlier scan of THIS
    // device couldn't read a hardware id, its machine row was keyed by ip/hostname;
    // now that this scan keyed it by a strong id (hardware_uuid/serial), that
    // weak-keyed row is a redundant orphan (the latest-scan query already hides it;
    // this removes it). Scoped tight: only on the weak→strong transition, only a
    // row for the same ip/hostname, and never one linked to a DIFFERENT asset (so a
    // recycled IP now belonging to another device is left alone).
    const usedStrongKey = Boolean(hardwareUuid || serial);
    const weakKeys = [ip, hostname].filter(
      (k): k is string => Boolean(k) && k !== matchKey,
    );
    if (usedStrongKey && upserted?.id && weakKeys.length) {
      await db
        .delete(machines)
        .where(
          and(
            inArray(machines.matchKey, weakKeys),
            ne(machines.id, upserted.id),
            assetId
              ? or(isNull(machines.assetId), eq(machines.assetId, assetId))
              : isNull(machines.assetId),
          ),
        );
    }

    if (assetId) {
      result.matched += 1;
      await db
        .update(assets)
        .set({ lastSync: now, updatedAt: now })
        .where(eq(assets.id, assetId));

      // Overwrite the asset's technical fields from the scan (best-effort). A
      // failure here must never fail the machine ingest.
      try {
        await applyScanToAsset(
          assetId,
          assetType,
          hw,
          h.health ?? null,
          serial,
          now,
          ph,
          ip,
        );
      } catch (err) {
        console.error(`[ingest] asset enrich failed for asset ${assetId}:`, err);
      }

      // Spec 27 AC-6: unique SIP display name → Person. Only fills Assigned To
      // when the phone is currently unassigned; never steals a manual assignment.
      const displayName = clean(ph?.display_name);
      if (assetType === "Phone" && displayName) {
        try {
          await maybeAssignPhoneByDisplayName(assetId, displayName);
        } catch (err) {
          console.error(
            `[ingest] phone assignee match failed for asset ${assetId}:`,
            err,
          );
        }
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

      // Security posture (spec 21, AC-2): a matched Computer with a compliance
      // block upserts its current posture (one row per asset). null/absent means
      // the collector didn't read it (non-Windows or a failure) → leave the prior
      // row intact. Best-effort — a posture write must never fail the machine ingest.
      if (assetType === "Computer" && h.compliance) {
        try {
          await upsertComplianceStatus(assetId, h.compliance, now);
        } catch (err) {
          console.error(
            `[ingest] compliance upsert failed for asset ${assetId}:`,
            err,
          );
        }
        // Alert admins on a posture boundary (spec 21 v2): at-risk ⇄ clean, once
        // per episode. Best-effort — must never fail the machine ingest.
        try {
          await evaluateComplianceAlert(assetId, now);
        } catch (err) {
          console.error(
            `[ingest] compliance alert failed for asset ${assetId}:`,
            err,
          );
        }
      }

      // Patch inventory (spec 31, AC-2): matched Computer with an updates block
      // upserts state + replaces hotfixes / app upgrades. null/absent → leave
      // prior rows. Best-effort — must never fail the machine ingest.
      if (assetType === "Computer" && h.updates) {
        try {
          await upsertWindowsUpdates(assetId, h.updates, now);
        } catch (err) {
          console.error(
            `[ingest] patch inventory failed for asset ${assetId}:`,
            err,
          );
        }
      }

      // Connected displays (spec 25, AC-3): a matched Computer that reported a
      // `monitors` array replaces its display set. `monitors == null`/absent means
      // the collector didn't read it (non-Windows or a failure) → leave the prior
      // set intact. Best-effort — a display write must never fail the machine ingest.
      if (assetType === "Computer" && Array.isArray(h.monitors)) {
        try {
          await replaceConnectedMonitors(assetId, h.monitors, now);
        } catch (err) {
          console.error(
            `[ingest] monitor inventory failed for asset ${assetId}:`,
            err,
          );
        }
        // Auto-add external monitors as Monitor assets (spec 25 follow-up): a
        // standalone display plugged into this computer becomes an inventory
        // asset, inheriting its location. Built-in laptop panels and dismissed
        // serials are skipped (they stay in the manual discovery list).
        // Best-effort — must never fail the machine ingest.
        try {
          await autoCreateExternalMonitors(assetId, h.monitors, now);
        } catch (err) {
          console.error(
            `[ingest] monitor auto-create failed for asset ${assetId}:`,
            err,
          );
        }
      }
    } else {
      result.discovered += 1;

      // Newly discovered device → an in-app notification (spec 19, AC-4). Keyed on
      // the machine id, which is stable across re-scans, so `createNotification`
      // fires only on the first discovery and is a no-op every re-scan after.
      // Best-effort — it never throws into the ingest.
      if (upserted?.id) {
        const label = row.hostname || row.ip || serial || "A new device";
        await createNotification({
          type: "device-discovered",
          severity: "info",
          title: "New device discovered",
          body: `${label}${row.ip && row.ip !== label ? ` (${row.ip})` : ""} was found by a scan and is waiting in the inbox.`,
          href: "/scans",
          dedupeKey: `device-discovered:${upserted.id}`,
          meta: { machineId: upserted.id, ip: row.ip, kind: row.kind },
        });
      }
    }
  }

  return result;
}
