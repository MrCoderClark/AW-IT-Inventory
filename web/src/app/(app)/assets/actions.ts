"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db/index";
import {
  assets,
  computerDetails,
  monitorDetails,
  networkDetails,
  phoneDetails,
  printerDetails,
} from "@/db/schema";
import { locationLeafStatus } from "@/db/queries";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { assetInputSchema, firstError } from "@/lib/asset-schema";
import { detailsSchemaFor } from "@/lib/asset-fields";
import type { ActionResult, AssetType } from "@/lib/data";
import { generateTag } from "@/lib/tags";

/** The per-type detail table for each asset type (spec 10). */
const DETAIL_TABLE = {
  Computer: computerDetails,
  Monitor: monitorDetails,
  Printer: printerDetails,
  Phone: phoneDetails,
  Network: networkDetails,
} as const;

/** Aborts a create transaction when no unique tag could be generated. */
class TagClashError extends Error {}

/** Pull the raw `details` object off the form payload (before validation). */
function rawDetails(raw: unknown): unknown {
  return raw && typeof raw === "object" && "details" in raw
    ? (raw as { details: unknown }).details
    : {};
}

/** Validate a type's details; returns the coerced values or an error result. */
function parseDetails(
  type: AssetType,
  raw: unknown,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = detailsSchemaFor(type).safeParse(rawDetails(raw) ?? {});
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "That input isn't valid.",
    };
  return { ok: true, data: parsed.data as Record<string, unknown> };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The minimal insert-then-upsert shape we use, since the detail table is chosen
   at runtime and a precise union type over the five tables is impractical. */
type DetailUpsert = {
  values: (v: Record<string, unknown>) => {
    onConflictDoUpdate: (config: {
      target: unknown;
      set: Record<string, unknown>;
    }) => Promise<unknown>;
  };
};

/**
 * Insert or update an asset's per-type detail row (keyed by assetId). The values
 * come from the type's own zod schema, so they match its columns. The concrete
 * table object is correct; the cast only bridges the runtime table choice.
 */
async function upsertDetails(
  tx: Tx,
  type: AssetType,
  assetId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const table = DETAIL_TABLE[type];
  await (tx.insert(table) as unknown as DetailUpsert)
    .values({ assetId, ...data })
    .onConflictDoUpdate({ target: table.assetId, set: data });
}

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to do that.",
};

const ASSIGNEE_GONE: ActionResult = {
  ok: false,
  error: "That assignee no longer exists. Refresh and try again.",
};

const LOCATION_GONE: ActionResult = {
  ok: false,
  error: "That location no longer exists. Refresh and try again.",
};

const LOCATION_NOT_LEAF: ActionResult = {
  ok: false,
  error:
    "Assign to a specific location (one with no children). Pick a leaf, or reorganize the tree first.",
};

/** Postgres foreign-key violation (e.g. assigneeId points at a since-deleted
   person). The schema only checks the id is a well-formed UUID, so a stale id
   survives validation and surfaces here at write time. */
function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23503"
  );
}

/** Which foreign key a 23503 violation is about, from the constraint name, so a
   since-deleted assignee and a since-deleted location get distinct messages. */
function fkViolationResult(err: unknown): ActionResult | null {
  if (!isForeignKeyViolation(err)) return null;
  const constraint = String(
    (err as { constraint_name?: unknown }).constraint_name ?? "",
  );
  if (constraint.includes("location")) return LOCATION_GONE;
  if (constraint.includes("assignee")) return ASSIGNEE_GONE;
  // Unknown FK: default to the assignee message (the pre-existing behavior).
  return ASSIGNEE_GONE;
}

/** Re-check that a chosen location is still an assignable leaf. Returns an error
   result to short-circuit the action, or null when the id is fine (or null). */
async function checkLeaf(locationId: string | null): Promise<ActionResult | null> {
  if (!locationId) return null;
  const status = await locationLeafStatus(locationId);
  if (status === "missing") return LOCATION_GONE;
  if (status === "parent") return LOCATION_NOT_LEAF;
  return null;
}

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

  const details = parseDetails(input.type, raw);
  if (!details.ok) return { ok: false, error: details.error };

  const leafError = await checkLeaf(input.locationId);
  if (leafError) return leafError;

  const now = new Date();
  let created: { tag: string } | undefined;
  try {
    // The tag-retry loop and the detail insert share one transaction, so a
    // detail row is never orphaned and a failed insert rolls the asset back.
    created = await db.transaction(async (tx) => {
      let row: { tag: string; id: string } | undefined;
      for (let attempt = 0; attempt < 6 && !row; attempt++) {
        const inserted = await tx
          .insert(assets)
          .values({
            tag: generateTag(input.type),
            name: input.name,
            type: input.type,
            status: input.status,
            serial: input.serial,
            model: input.model,
            assigneeId: input.assigneeId,
            locationId: input.locationId,
            vendor: input.vendor,
            spec: input.spec,
            costCenter: input.costCenter,
            purchaseDate: input.purchaseDate,
            warrantyUntil: input.warrantyUntil,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: assets.tag })
          .returning({ tag: assets.tag, id: assets.id });
        row = inserted[0];
      }
      if (!row) throw new TagClashError();
      await upsertDetails(tx, input.type, row.id, details.data);
      return { tag: row.tag };
    });
  } catch (err) {
    if (err instanceof TagClashError)
      return { ok: false, error: "Couldn't generate a unique tag. Try again." };
    const fk = fkViolationResult(err);
    if (fk) return fk;
    throw err;
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

  const details = parseDetails(input.type, raw);
  if (!details.ok) return { ok: false, error: details.error };

  const leafError = await checkLeaf(input.locationId);
  if (leafError) return leafError;

  const now = new Date();
  let existed = false;
  try {
    // Update the asset and upsert its detail row together; type is locked on
    // edit, so an existing asset with no detail row yet gains one here.
    existed = await db.transaction(async (tx) => {
      const updated = await tx
        .update(assets)
        .set({
          name: input.name,
          status: input.status,
          serial: input.serial,
          model: input.model,
          assigneeId: input.assigneeId,
          locationId: input.locationId,
          vendor: input.vendor,
          spec: input.spec,
          costCenter: input.costCenter,
          purchaseDate: input.purchaseDate,
          warrantyUntil: input.warrantyUntil,
          updatedAt: now,
        })
        .where(eq(assets.tag, tag))
        .returning({ id: assets.id });
      if (!updated.length) return false;
      await upsertDetails(tx, input.type, updated[0].id, details.data);
      return true;
    });
  } catch (err) {
    const fk = fkViolationResult(err);
    if (fk) return fk;
    throw err;
  }

  if (!existed) return { ok: false, error: "That asset no longer exists." };

  revalidateFor(input.type);
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
