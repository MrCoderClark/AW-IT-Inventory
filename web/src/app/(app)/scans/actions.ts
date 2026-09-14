"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db/index";
import { assets, machines } from "@/db/schema";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { kindMeta } from "@/lib/data";
import type { ActionResult, AssetType } from "@/lib/data";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to do that.",
};

/** Gate every write action on `asset:write`, server-side. */
async function requireWrite(): Promise<boolean> {
  const user = await getCurrentUser();
  return hasPermission(user, "asset:write");
}

const TAG_PREFIX: Record<AssetType, string> = {
  Computer: "COMP",
  Monitor: "MON",
  Printer: "PRNT",
  Phone: "PHN",
  Network: "NET",
};

/** OPUS-COMP-7F3K9 — prefix from the type, 5 random base36 chars. */
function generateTag(type: AssetType): string {
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `OPUS-${TAG_PREFIX[type]}-${suffix}`;
}

function specSummary(hardware: unknown): string | null {
  const hw = (hardware ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof hw.cpu === "string" && hw.cpu) parts.push(hw.cpu);
  if (typeof hw.ram_gb === "number") parts.push(`${hw.ram_gb} GB RAM`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Link a discovered device to an existing asset. Guarded so it only touches a
 * still-discovered row: if it was already resolved by someone else, it's a safe
 * no-op (AC-8), never an error and never a duplicate.
 */
export async function linkDevice(
  machineId: string,
  assetId: string,
): Promise<ActionResult> {
  if (!(await requireWrite())) return FORBIDDEN;
  const now = new Date();

  const target = await db
    .select({ id: assets.id })
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);
  if (!target.length) return { ok: false, error: "That asset no longer exists." };

  const linked = await db
    .update(machines)
    .set({ assetId, updatedAt: now })
    .where(and(eq(machines.id, machineId), isNull(machines.assetId)))
    .returning({ id: machines.id });

  if (!linked.length) {
    revalidatePath("/scans");
    return { ok: true, message: "That device was already resolved." };
  }

  await db
    .update(assets)
    .set({ lastSync: now, updatedAt: now })
    .where(eq(assets.id, assetId));

  revalidatePath("/scans");
  return { ok: true, message: "Device linked." };
}

/**
 * Quick-create a managed asset from a discovered device and link it, in one
 * transaction. Locks the machine row so concurrent calls can't create two
 * assets (AC-8); retries tag generation on the unique-constraint clash.
 */
export async function createAssetFromDevice(
  machineId: string,
): Promise<ActionResult> {
  if (!(await requireWrite())) return FORBIDDEN;

  const result = await db.transaction(async (tx): Promise<ActionResult> => {
    const [m] = await tx
      .select()
      .from(machines)
      .where(eq(machines.id, machineId))
      .for("update");

    if (!m) return { ok: false, error: "That device no longer exists." };
    if (m.assetId)
      return { ok: true, message: "That device was already resolved." };

    const type = kindMeta(m.kind).type;
    const name = m.hostname || m.ip || "Discovered device";
    const now = new Date();

    let created: { id: string; tag: string } | undefined;
    for (let attempt = 0; attempt < 6 && !created; attempt++) {
      const inserted = await tx
        .insert(assets)
        .values({
          tag: generateTag(type),
          name,
          type,
          serial: m.serial,
          spec: specSummary(m.hardware),
          status: "storage",
        })
        .onConflictDoNothing({ target: assets.tag })
        .returning({ id: assets.id, tag: assets.tag });
      created = inserted[0];
    }
    if (!created)
      return { ok: false, error: "Couldn't generate a unique tag. Try again." };

    await tx
      .update(machines)
      .set({ assetId: created.id, updatedAt: now })
      .where(eq(machines.id, machineId));
    await tx
      .update(assets)
      .set({ lastSync: m.lastSeenAt ?? now, updatedAt: now })
      .where(eq(assets.id, created.id));

    return { ok: true, message: `Created ${created.tag}.`, tag: created.tag };
  });

  revalidatePath("/scans");
  return result;
}

/**
 * Dismiss a discovered device from the active inbox. Only affects an unmatched
 * row; a device already linked is left alone (no-op).
 */
export async function ignoreDevice(machineId: string): Promise<ActionResult> {
  if (!(await requireWrite())) return FORBIDDEN;
  const now = new Date();

  const updated = await db
    .update(machines)
    .set({ ignoredAt: now, updatedAt: now })
    .where(and(eq(machines.id, machineId), isNull(machines.assetId)))
    .returning({ id: machines.id });

  revalidatePath("/scans");
  return updated.length
    ? { ok: true, message: "Device ignored." }
    : { ok: true, message: "That device was already resolved." };
}

/** Restore an ignored device to the active inbox (clears `ignoredAt`). */
export async function restoreDevice(machineId: string): Promise<ActionResult> {
  if (!(await requireWrite())) return FORBIDDEN;
  const now = new Date();

  await db
    .update(machines)
    .set({ ignoredAt: null, updatedAt: now })
    .where(eq(machines.id, machineId));

  revalidatePath("/scans");
  return { ok: true, message: "Device restored to the inbox." };
}
