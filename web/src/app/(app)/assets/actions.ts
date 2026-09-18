"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db/index";
import { assets } from "@/db/schema";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { assetInputSchema, firstError } from "@/lib/asset-schema";
import type { ActionResult, AssetType } from "@/lib/data";
import { generateTag } from "@/lib/tags";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to do that.",
};

/** Gate every write action on `asset:write`, server-side. */
async function requireWrite(): Promise<boolean> {
  const user = await getCurrentUser();
  return hasPermission(user, "asset:write");
}

const TYPE_ROUTE: Record<AssetType, string> = {
  Computer: "/computers",
  Monitor: "/monitors",
  Printer: "/printers",
  Phone: "/phones",
  Network: "/network",
};

/** Refresh every surface a create/update/delete can change. */
function revalidateFor(type: AssetType) {
  revalidatePath("/dashboard");
  revalidatePath(TYPE_ROUTE[type]);
}

/**
 * Create a managed asset from the form. Validates on the trust boundary, then
 * inserts with an auto-generated unique tag (retrying the rare tag clash, as the
 * inbox quick-create does). Type fixes the tag prefix, so they always agree.
 */
export async function createAsset(raw: unknown): Promise<ActionResult> {
  if (!(await requireWrite())) return FORBIDDEN;

  const parsed = assetInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  const input = parsed.data;
  const now = new Date();

  let created: { tag: string } | undefined;
  for (let attempt = 0; attempt < 6 && !created; attempt++) {
    const inserted = await db
      .insert(assets)
      .values({
        tag: generateTag(input.type),
        name: input.name,
        type: input.type,
        status: input.status,
        serial: input.serial,
        model: input.model,
        assigneeId: input.assigneeId,
        location: input.location,
        vendor: input.vendor,
        spec: input.spec,
        costCenter: input.costCenter,
        purchaseDate: input.purchaseDate,
        warrantyUntil: input.warrantyUntil,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: assets.tag })
      .returning({ tag: assets.tag });
    created = inserted[0];
  }
  if (!created)
    return { ok: false, error: "Couldn't generate a unique tag. Try again." };

  revalidateFor(input.type);
  revalidatePath(`/assets/${created.tag}`);
  return { ok: true, message: `Created ${created.tag}.`, tag: created.tag };
}

/**
 * Update an asset keyed by its immutable tag. Type is locked on edit (never in
 * the SET), so the tag prefix and the asset type stay in agreement.
 * Last-write-wins (no version guard). A tag that no longer exists is a clean
 * error, not a crash.
 */
export async function updateAsset(
  tag: string,
  raw: unknown,
): Promise<ActionResult> {
  if (!(await requireWrite())) return FORBIDDEN;

  const parsed = assetInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) };
  const input = parsed.data;
  const now = new Date();

  const updated = await db
    .update(assets)
    .set({
      name: input.name,
      status: input.status,
      serial: input.serial,
      model: input.model,
      assigneeId: input.assigneeId,
      location: input.location,
      vendor: input.vendor,
      spec: input.spec,
      costCenter: input.costCenter,
      purchaseDate: input.purchaseDate,
      warrantyUntil: input.warrantyUntil,
      updatedAt: now,
    })
    .where(eq(assets.tag, tag))
    .returning({ type: assets.type });

  if (!updated.length)
    return { ok: false, error: "That asset no longer exists." };

  revalidateFor(updated[0].type as AssetType);
  revalidatePath(`/assets/${tag}`);
  return { ok: true, message: "Asset updated." };
}

/**
 * Delete an asset keyed by its tag. A matched machine's `assetId` and any
 * `people` reference are set null by the existing foreign keys (the machine
 * returns to the discovered inbox), not deleted. Deleting an asset that is
 * already gone returns a clean error.
 */
export async function deleteAsset(tag: string): Promise<ActionResult> {
  if (!(await requireWrite())) return FORBIDDEN;

  const deleted = await db
    .delete(assets)
    .where(eq(assets.tag, tag))
    .returning({ type: assets.type });

  if (!deleted.length)
    return { ok: false, error: "That asset no longer exists." };

  revalidateFor(deleted[0].type as AssetType);
  revalidatePath("/scans"); // a matched machine reappears in the inbox
  return { ok: true, message: `Deleted ${tag}.` };
}
