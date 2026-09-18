"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db/index";
import { locations } from "@/db/schema";
import {
  getLocationById,
  getSubtreeIds,
  locationHasChildren,
  locationHasDevices,
  siblingNameTaken,
} from "@/db/queries";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import {
  createLocationSchema,
  firstLocationError,
  moveLocationSchema,
  renameLocationSchema,
} from "@/lib/location-schema";
import type { ActionResult } from "@/lib/data";

const FORBIDDEN: ActionResult = {
  ok: false,
  error: "You don't have permission to do that.",
};

const GONE: ActionResult = {
  ok: false,
  error: "That location no longer exists. Refresh and try again.",
};

/** Gate every location mutation on `location:write`, server-side (AC-9). */
async function requireLocationWrite(): Promise<boolean> {
  const user = await getCurrentUser();
  return hasPermission(user, "location:write");
}

/** Refresh every surface that shows the tree, the pickers or the filter. */
function revalidateLocations() {
  revalidatePath("/locations");
  revalidatePath("/dashboard");
  revalidatePath("/computers");
  revalidatePath("/monitors");
  revalidatePath("/printers");
  revalidatePath("/phones");
  revalidatePath("/network");
  // Every asset detail page shows its location path, so a rename/move must
  // refresh them too (dynamic route, all instances).
  revalidatePath("/assets/[id]", "page");
}

/**
 * Create a location, top-level (no parent) or a child of an existing one.
 * Rejects a duplicate sibling name, a missing parent, and a parent that already
 * holds devices (that would turn a leaf-with-devices into a parent). AC-2, AC-7.
 */
export async function createLocation(raw: unknown): Promise<ActionResult> {
  if (!(await requireLocationWrite())) return FORBIDDEN;

  const parsed = createLocationSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, error: firstLocationError(parsed.error) };
  const { name, parentId } = parsed.data;

  if (parentId) {
    const parent = await getLocationById(parentId);
    if (!parent)
      return { ok: false, error: "That parent location no longer exists." };
    if (await locationHasDevices(parentId))
      return {
        ok: false,
        error:
          "That location has devices assigned. Reassign them to a leaf before nesting locations under it.",
      };
  }

  if (await siblingNameTaken(parentId, name))
    return {
      ok: false,
      error: `A location named "${name}" already exists here.`,
    };

  try {
    await db.insert(locations).values({ name, parentId });
  } catch (err) {
    // A concurrent insert of the same sibling name trips the unique index.
    if (isUniqueViolation(err))
      return {
        ok: false,
        error: `A location named "${name}" already exists here.`,
      };
    throw err;
  }

  revalidateLocations();
  return { ok: true, message: `Created "${name}".` };
}

/** Rename a location. Rejects a duplicate sibling name; a clean error if gone.
   AC-3. */
export async function renameLocation(
  id: string,
  rawName: unknown,
): Promise<ActionResult> {
  if (!(await requireLocationWrite())) return FORBIDDEN;

  const parsed = renameLocationSchema.safeParse({ name: rawName });
  if (!parsed.success)
    return { ok: false, error: firstLocationError(parsed.error) };
  const { name } = parsed.data;

  const loc = await getLocationById(id);
  if (!loc) return GONE;

  if (await siblingNameTaken(loc.parentId, name, id))
    return {
      ok: false,
      error: `A location named "${name}" already exists here.`,
    };

  try {
    const updated = await db
      .update(locations)
      .set({ name, updatedAt: new Date() })
      .where(eq(locations.id, id))
      .returning({ id: locations.id });
    if (!updated.length) return GONE;
  } catch (err) {
    if (isUniqueViolation(err))
      return {
        ok: false,
        error: `A location named "${name}" already exists here.`,
      };
    throw err;
  }

  revalidateLocations();
  return { ok: true, message: `Renamed to "${name}".` };
}

/**
 * Move a location (with its whole subtree) under a new parent, or to top level
 * (newParentId null). Rejects a cycle (moving under itself or a descendant),
 * a missing target, and a target that already holds devices. AC-4, AC-7.
 */
export async function moveLocation(
  id: string,
  rawNewParentId: unknown,
): Promise<ActionResult> {
  if (!(await requireLocationWrite())) return FORBIDDEN;

  const parsed = moveLocationSchema.safeParse({ newParentId: rawNewParentId });
  if (!parsed.success)
    return { ok: false, error: firstLocationError(parsed.error) };
  const { newParentId } = parsed.data;

  const loc = await getLocationById(id);
  if (!loc) return GONE;
  if (newParentId === loc.parentId)
    return { ok: false, error: "That location is already there." };

  if (newParentId) {
    if (newParentId === id)
      return { ok: false, error: "A location can't be moved under itself." };

    const target = await getLocationById(newParentId);
    if (!target)
      return { ok: false, error: "That destination no longer exists." };

    // Cycle guard: the destination must not be inside this location's subtree.
    const subtree = await getSubtreeIds(id);
    if (subtree.includes(newParentId))
      return {
        ok: false,
        error: "A location can't be moved under one of its own descendants.",
      };

    if (await locationHasDevices(newParentId))
      return {
        ok: false,
        error:
          "That destination has devices assigned. Reassign them to a leaf before nesting locations under it.",
      };
  }

  if (await siblingNameTaken(newParentId, loc.name, id))
    return {
      ok: false,
      error: `A location named "${loc.name}" already exists there.`,
    };

  try {
    const updated = await db
      .update(locations)
      .set({ parentId: newParentId, updatedAt: new Date() })
      .where(eq(locations.id, id))
      .returning({ id: locations.id });
    if (!updated.length) return GONE;
  } catch (err) {
    if (isUniqueViolation(err))
      return {
        ok: false,
        error: `A location named "${loc.name}" already exists there.`,
      };
    throw err;
  }

  revalidateLocations();
  return { ok: true, message: `Moved "${loc.name}".` };
}

/**
 * Delete a location, only when it has no children and no assigned devices
 * (block until empty). Never silently orphans a device or removes a subtree.
 * AC-5.
 */
export async function deleteLocation(id: string): Promise<ActionResult> {
  if (!(await requireLocationWrite())) return FORBIDDEN;

  const loc = await getLocationById(id);
  if (!loc) return GONE;

  if (await locationHasChildren(id))
    return {
      ok: false,
      error:
        "This location has child locations. Move or delete them first, then delete it.",
    };
  if (await locationHasDevices(id))
    return {
      ok: false,
      error:
        "This location has devices assigned. Reassign them first, then delete it.",
    };

  try {
    const deleted = await db
      .delete(locations)
      .where(eq(locations.id, id))
      .returning({ id: locations.id });
    if (!deleted.length) return GONE;
  } catch (err) {
    // A race: a child or device landed between the guards and the delete; the
    // `restrict` foreign keys block it. Report the same block message.
    if (isForeignKeyViolation(err))
      return {
        ok: false,
        error:
          "This location isn't empty anymore. Refresh and move its children or devices first.",
      };
    throw err;
  }

  revalidateLocations();
  return { ok: true, message: `Deleted "${loc.name}".` };
}

function isUniqueViolation(err: unknown): boolean {
  return hasPgCode(err, "23505");
}

function isForeignKeyViolation(err: unknown): boolean {
  return hasPgCode(err, "23503");
}

function hasPgCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}
