import { z } from "zod";

/**
 * People directory form schema (spec 16). Parsed on the client for inline field
 * errors and re-parsed in the server action (the trust boundary). Name is the
 * only required field; every other field is optional and a blank value is stored
 * as null. Initials are NOT here — they are derived from the name on write.
 */

/** Optional free text: trims, and turns "" (or absent) into null. */
const nullableText = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    if (v == null) return null;
    const t = v.trim();
    return t === "" ? null : t;
  });

/** Optional email: "" / absent → null, otherwise a valid email address. */
const nullableEmail = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (v == null ? null : v.trim() === "" ? null : v.trim()))
  .refine(
    (v) => v === null || z.string().email().safeParse(v).success,
    "Enter a valid email address",
  );

/** Optional location: "" / absent → null, otherwise a uuid (any node, not just
   a leaf — a person may sit anywhere in the tree). */
const nullableLocation = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (v == null || v.trim() === "" ? null : v.trim()))
  .refine(
    (v) => v === null || z.string().uuid().safeParse(v).success,
    "Choose a valid location",
  );

export const personInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: nullableEmail,
  department: nullableText,
  jobTitle: nullableText,
  phone: nullableText,
  employeeId: nullableText,
  officeLocationId: nullableLocation,
});

export type PersonInput = z.output<typeof personInputSchema>;

/** The raw form shape (every field a string). */
export interface PersonFormValues {
  name: string;
  email: string;
  department: string;
  jobTitle: string;
  phone: string;
  employeeId: string;
  officeLocationId: string;
}

export const EMPTY_PERSON_FORM: PersonFormValues = {
  name: "",
  email: "",
  department: "",
  jobTitle: "",
  phone: "",
  employeeId: "",
  officeLocationId: "",
};

/** Field-keyed error messages from a failed parse, for inline form errors. */
export function personFieldErrors(
  error: z.ZodError,
): Partial<Record<keyof PersonFormValues, string>> {
  const out: Partial<Record<keyof PersonFormValues, string>> = {};
  for (const issue of error.issues) {
    const key = issue.path[0] as keyof PersonFormValues | undefined;
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

/** The first error message from a failed parse, for an ActionResult. */
export function personFirstError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "That input isn't valid.";
}
