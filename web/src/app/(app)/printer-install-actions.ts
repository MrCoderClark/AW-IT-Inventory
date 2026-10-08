"use server";

import { revalidatePath } from "next/cache";

import {
  cancelInstallJob,
  enqueueInstall,
  enqueueList,
  enqueueRemove,
  resolveInstallTarget,
} from "@/db/printer-install";
import type { PrinterInstallConnection } from "@/db/schema";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import type { AuthUser } from "@/lib/auth/types";
import type { ActionResult } from "@/lib/data";
import { getPrinterPackage, snapshotOf } from "@/lib/printer-packages";
import {
  installInputSchema,
  installFirstError,
} from "@/lib/printer-install-schema";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to install printers.",
};

/** Resolve the caller only if they hold `printer:install` (AC-9). */
async function requireInstaller(): Promise<AuthUser | null> {
  const user = await getCurrentUser();
  return user && hasPermission(user, "printer:install") ? user : null;
}

export async function installPrinterAction(
  assetTag: unknown,
  raw: unknown,
  sourcePrinterAssetId?: unknown,
): Promise<ActionResult> {
  const user = await requireInstaller();
  if (!user) return FORBIDDEN;
  if (typeof assetTag !== "string" || !assetTag) {
    return { ok: false, error: "Unknown computer." };
  }

  const parsed = installInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: installFirstError(parsed.error) };
  }
  const input = parsed.data;

  // AC-2: the target must be a Computer with an entered IP.
  const target = await resolveInstallTarget(assetTag);
  if (!target) {
    return {
      ok: false,
      error:
        "This computer has no IP on record. Add its IP address first, then try again.",
    };
  }

  // AC-10: the package must be in the filesystem catalog.
  const pkg = await getPrinterPackage(input.packageId);
  if (!pkg) {
    return { ok: false, error: "That driver package isn't available." };
  }

  let connection: PrinterInstallConnection;
  if (input.connectionType === "tcpip") {
    connection = {
      type: "tcpip",
      host: input.host,
      port: input.port ?? 9100,
      replace: input.replaceExisting,
    };
  } else if (input.connectionType === "wsd") {
    connection = { type: "wsd", host: input.host || undefined };
  } else {
    connection = { type: "share", sharePath: input.sharePath };
  }

  const jobId = await enqueueInstall({
    assetId: target.assetId,
    targetIp: target.ip,
    packageId: pkg.id,
    packageSnapshot: snapshotOf(pkg),
    printerName: input.printerName,
    connection,
    sourcePrinterAssetId:
      typeof sourcePrinterAssetId === "string" ? sourcePrinterAssetId : null,
    requestedBy: user.email,
  });
  // Follow with a re-scan so the live list reflects the new printer (runs after
  // the install, FIFO).
  await enqueueList({
    assetId: target.assetId,
    targetIp: target.ip,
    requestedBy: user.email,
  });

  revalidatePath(`/assets/${assetTag}`);
  return {
    ok: true,
    message: `Install queued — the collector will install "${input.printerName}" shortly.`,
    tag: jobId,
  };
}

export async function scanPrintersAction(
  assetTag: unknown,
): Promise<ActionResult> {
  const user = await requireInstaller();
  if (!user) return FORBIDDEN;
  if (typeof assetTag !== "string" || !assetTag) {
    return { ok: false, error: "Unknown computer." };
  }
  const target = await resolveInstallTarget(assetTag);
  if (!target) {
    return {
      ok: false,
      error: "This computer has no IP on record. Add its IP address first.",
    };
  }
  await enqueueList({
    assetId: target.assetId,
    targetIp: target.ip,
    requestedBy: user.email,
  });
  revalidatePath(`/assets/${assetTag}`);
  return { ok: true, message: "Scanning the computer's printers…" };
}

export async function removePrinterAction(
  assetTag: unknown,
  printerName: unknown,
): Promise<ActionResult> {
  const user = await requireInstaller();
  if (!user) return FORBIDDEN;
  if (typeof assetTag !== "string" || !assetTag) {
    return { ok: false, error: "Unknown computer." };
  }
  if (typeof printerName !== "string" || !printerName) {
    return { ok: false, error: "Unknown printer." };
  }
  const target = await resolveInstallTarget(assetTag);
  if (!target) {
    return { ok: false, error: "This computer has no IP on record." };
  }
  await enqueueRemove({
    assetId: target.assetId,
    targetIp: target.ip,
    printerName,
    requestedBy: user.email,
  });
  // Re-scan afterwards so the list drops the removed printer (FIFO after remove).
  await enqueueList({
    assetId: target.assetId,
    targetIp: target.ip,
    requestedBy: user.email,
  });
  revalidatePath(`/assets/${assetTag}`);
  return { ok: true, message: `Removing "${printerName}"…` };
}

export async function cancelInstallJobAction(
  id: unknown,
  assetTag: unknown,
): Promise<ActionResult> {
  if (!(await requireInstaller())) return FORBIDDEN;
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "Unknown job." };
  }

  const ok = await cancelInstallJob(id);
  if (!ok) {
    return { ok: false, error: "That job has already finished." };
  }
  if (typeof assetTag === "string" && assetTag) {
    revalidatePath(`/assets/${assetTag}`);
  }
  return { ok: true, message: "Install job canceled." };
}
