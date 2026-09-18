import { z } from "zod";

import type { AssetStatus, AssetType } from "@/lib/data";

/**
 * One schema, parsed on the client (inline field errors) and re-parsed in each
 * Server Action (the trust boundary). name / type / status are required; every
 * other field is optional and a blank value is stored as null. If both dates are
 * set, warranty-until must be on or after purchase-date.
 */

export const ASSET_TYPES = [
  "Computer",
  "Monitor",
  "Printer",
  "Phone",
  "Network",
] as const satisfies readonly AssetType[];

export const ASSET_STATUSES = [
  "deployed",
  "maintenance",
  "online",
  "storage",
] as const satisfies readonly AssetStatus[];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Optional free text: trims, and turns "" (or absent) into null. */
const nullableText = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    if (v == null) return null;
    const t = v.trim();
    return t === "" ? null : t;
  });

/** Optional assignee: "" / absent → null, otherwise a uuid. */
const nullableAssignee = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (v == null || v.trim() === "" ? null : v.trim()))
  .refine(
    (v) => v === null || z.string().uuid().safeParse(v).success,
    "Choose a valid assignee",
  );

/** Optional date: "" / absent → null, otherwise a YYYY-MM-DD string. */
const nullableDate = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (v == null || v.trim() === "" ? null : v.trim()))
  .refine((v) => v === null || DATE_RE.test(v), "Enter a valid date");

export const assetInputSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required"),
    type: z.enum(ASSET_TYPES, { error: "Choose an asset type" }),
    status: z.enum(ASSET_STATUSES, { error: "Choose a status" }),
    serial: nullableText,
    model: nullableText,
    assigneeId: nullableAssignee,
    location: nullableText,
    vendor: nullableText,
    spec: nullableText,
    costCenter: nullableText,
    purchaseDate: nullableDate,
    warrantyUntil: nullableDate,
  })
  .refine(
    (v) =>
      !(v.purchaseDate && v.warrantyUntil) ||
      v.warrantyUntil >= v.purchaseDate,
    {
      message: "Warranty end must be on or after the purchase date",
      path: ["warrantyUntil"],
    },
  );

/** The validated, coerced shape written to the database. */
export type AssetInput = z.output<typeof assetInputSchema>;

/** The raw form shape (every field a string) parsed by the schema. */
export interface AssetFormValues {
  name: string;
  type: AssetType | "";
  status: AssetStatus | "";
  serial: string;
  model: string;
  assigneeId: string;
  location: string;
  vendor: string;
  spec: string;
  costCenter: string;
  purchaseDate: string;
  warrantyUntil: string;
}

export const EMPTY_ASSET_FORM: AssetFormValues = {
  name: "",
  type: "",
  status: "",
  serial: "",
  model: "",
  assigneeId: "",
  location: "",
  vendor: "",
  spec: "",
  costCenter: "",
  purchaseDate: "",
  warrantyUntil: "",
};

/** Field-keyed error messages from a failed parse, for inline form errors. */
export function fieldErrors(
  error: z.ZodError,
): Partial<Record<keyof AssetFormValues, string>> {
  const out: Partial<Record<keyof AssetFormValues, string>> = {};
  for (const issue of error.issues) {
    const key = issue.path[0] as keyof AssetFormValues | undefined;
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

/** The first error message from a failed parse, for an ActionResult. */
export function firstError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "That input isn't valid.";
}
