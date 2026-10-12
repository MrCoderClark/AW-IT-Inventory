import "server-only";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "./index";
import { softwareDeployments, softwarePackages } from "./schema";
import type { SoftwarePackageRow, SoftwareStep } from "./schema";

/**
 * The software package catalog (spec 23). A package is a header plus an ordered
 * list of steps; installer-step bytes live in the private object store
 * (`lib/storage.ts`). This module owns the `software_packages` rows only — it never
 * touches S3, so callers (the create / delete actions) remove the object bytes
 * using the `storageKeys` this returns. Everything here is server-only.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every stored object key in a step list — installers AND companions (for cleanup
    on delete). */
export function storageKeysOf(steps: SoftwareStep[]): string[] {
  const keys: string[] = [];
  for (const s of steps) {
    if (s.kind !== "install") continue;
    keys.push(s.storageKey);
    for (const c of s.companions ?? []) keys.push(c.storageKey);
  }
  return keys;
}

export type NewSoftwarePackage = {
  name: string;
  version: string;
  publisher?: string | null;
  steps: SoftwareStep[];
  uploadedBy: string;
};

/** Insert a package (header + ordered steps); returns its id. */
export async function createSoftwarePackage(
  input: NewSoftwarePackage,
): Promise<string> {
  const [row] = await db
    .insert(softwarePackages)
    .values({
      name: input.name,
      version: input.version,
      publisher: input.publisher ?? null,
      steps: input.steps,
      uploadedBy: input.uploadedBy,
    })
    .returning({ id: softwarePackages.id });
  return row.id;
}

export type UpdateSoftwarePackage = {
  name: string;
  version: string;
  publisher?: string | null;
  steps: SoftwareStep[];
};

export type UpdatePackageOutcome =
  | { outcome: "ok"; orphanKeys: string[] }
  | { outcome: "notfound" };

/**
 * Replace a package's header + steps (spec 23 edit). Returns the object keys that
 * the edit orphaned (install/companion files no longer referenced) so the caller
 * can delete them. Past deployments are untouched — they run from their own frozen
 * snapshot — so editing the catalog never rewrites history.
 */
export async function updateSoftwarePackage(
  id: string,
  input: UpdateSoftwarePackage,
): Promise<UpdatePackageOutcome> {
  if (!UUID_RE.test(id)) return { outcome: "notfound" };
  const existing = await getSoftwarePackage(id);
  if (!existing) return { outcome: "notfound" };

  const newKeys = new Set(storageKeysOf(input.steps));
  const orphanKeys = storageKeysOf(existing.steps).filter((k) => !newKeys.has(k));

  await db
    .update(softwarePackages)
    .set({
      name: input.name,
      version: input.version,
      publisher: input.publisher ?? null,
      steps: input.steps,
      updatedAt: new Date(),
    })
    .where(eq(softwarePackages.id, id));
  return { outcome: "ok", orphanKeys };
}

/** Active (non-archived) packages for the library, newest first. */
export async function listSoftwarePackages(): Promise<SoftwarePackageRow[]> {
  return db
    .select()
    .from(softwarePackages)
    .where(isNull(softwarePackages.archivedAt))
    .orderBy(desc(softwarePackages.createdAt));
}

/** One package by id (active or archived), or null for an unknown/invalid id. */
export async function getSoftwarePackage(
  id: string,
): Promise<SoftwarePackageRow | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db
    .select()
    .from(softwarePackages)
    .where(eq(softwarePackages.id, id))
    .limit(1);
  return row ?? null;
}

export type RemovePackageOutcome =
  | { outcome: "deleted" | "archived"; storageKeys: string[] }
  | { outcome: "notfound" };

/**
 * Remove a package from the library. The frozen snapshot on each deployment keeps
 * history readable regardless, so: hard-delete the row when nothing references it;
 * otherwise **soft-archive** it (hide from the library, keep it resolvable for
 * history). Either way the caller deletes every install step's bytes via the
 * returned `storageKeys` to reclaim storage (AC-10).
 */
export async function removeSoftwarePackage(
  id: string,
): Promise<RemovePackageOutcome> {
  if (!UUID_RE.test(id)) return { outcome: "notfound" };
  const pkg = await getSoftwarePackage(id);
  if (!pkg) return { outcome: "notfound" };

  const storageKeys = storageKeysOf(pkg.steps);

  const [used] = await db
    .select({ id: softwareDeployments.id })
    .from(softwareDeployments)
    .where(eq(softwareDeployments.packageId, id))
    .limit(1);

  if (used) {
    await db
      .update(softwarePackages)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(softwarePackages.id, id));
    return { outcome: "archived", storageKeys };
  }

  await db.delete(softwarePackages).where(eq(softwarePackages.id, id));
  return { outcome: "deleted", storageKeys };
}

/** True when a name+version already exists among active packages (dup guard).
    `excludeId` skips one package (itself) so an edit that keeps its name passes. */
export async function softwarePackageExists(
  name: string,
  version: string,
  excludeId?: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: softwarePackages.id })
    .from(softwarePackages)
    .where(
      and(
        isNull(softwarePackages.archivedAt),
        sql`lower(${softwarePackages.name}) = lower(${name})`,
        sql`lower(${softwarePackages.version}) = lower(${version})`,
        ...(excludeId ? [sql`${softwarePackages.id} <> ${excludeId}`] : []),
      ),
    )
    .limit(1);
  return !!row;
}
