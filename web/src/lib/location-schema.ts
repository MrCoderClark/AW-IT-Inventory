import { z } from "zod";

/**
 * One schema for the location tree, parsed on the client (inline field errors)
 * and re-parsed in each Server Action (the trust boundary). A name is required
 * and trimmed; a parent id is optional (null = a top-level location) and, when
 * present, must be a uuid. Structural rules the schema can't see — unique
 * sibling names, no cycles, leaf-only assignment — are enforced in the actions.
 */

const locationName = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(100, "Name is too long (max 100 characters)");

/** Optional parent/target id: "" / absent → null, otherwise a uuid. */
const nullableLocationId = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (v == null || v.trim() === "" ? null : v.trim()))
  .refine(
    (v) => v === null || z.string().uuid().safeParse(v).success,
    "Choose a valid location",
  );

export const createLocationSchema = z.object({
  name: locationName,
  parentId: nullableLocationId,
});

export const renameLocationSchema = z.object({
  name: locationName,
});

export const moveLocationSchema = z.object({
  newParentId: nullableLocationId,
});

export type CreateLocationInput = z.output<typeof createLocationSchema>;
export type RenameLocationInput = z.output<typeof renameLocationSchema>;
export type MoveLocationInput = z.output<typeof moveLocationSchema>;

/** The first error message from a failed parse, for an ActionResult. */
export function firstLocationError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "That input isn't valid.";
}
