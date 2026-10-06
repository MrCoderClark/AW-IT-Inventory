import { z } from "zod";

/**
 * User-management form schemas. Parsed on the client for inline field errors and
 * re-parsed in the server action (the trust boundary). aw-auth is the ultimate
 * source of truth for password strength (Django validators) and uniqueness — its
 * 400 messages are surfaced verbatim — but these rules give fast, local feedback
 * and mirror Django's default minimum length.
 */

/** Matches Django's default AUTH_PASSWORD_VALIDATORS minimum length. */
const MIN_PASSWORD = 8;

const password = z
  .string()
  .min(MIN_PASSWORD, `Password must be at least ${MIN_PASSWORD} characters`);

/* ---------------- Admin: create a user ---------------- */

export const userCreateSchema = z.object({
  email: z.string().trim().min(1, "Email is required").email("Enter a valid email"),
  full_name: z.string().trim().min(1, "A name is required"),
  password,
  roles: z.array(z.string()).default([]),
});

export type UserCreateInput = z.output<typeof userCreateSchema>;

export interface UserFormValues {
  email: string;
  full_name: string;
  password: string;
  roles: string[];
}

export const EMPTY_USER_FORM: UserFormValues = {
  email: "",
  full_name: "",
  password: "",
  roles: [],
};

/* ---------------- Self-service: change password ---------------- */

export const passwordChangeSchema = z
  .object({
    current_password: z.string().min(1, "Enter your current password"),
    new_password: password,
    confirm_password: z.string(),
  })
  .refine((v) => v.new_password === v.confirm_password, {
    path: ["confirm_password"],
    message: "Passwords don't match",
  });

export type PasswordChangeInput = z.output<typeof passwordChangeSchema>;

/* ---------------- Admin: reset another user's password ---------------- */

export const setPasswordSchema = z
  .object({
    new_password: password,
    confirm_password: z.string(),
  })
  .refine((v) => v.new_password === v.confirm_password, {
    path: ["confirm_password"],
    message: "Passwords don't match",
  });

/* ---------------- Self-service: profile ---------------- */

export const profileSchema = z.object({
  full_name: z.string().trim().min(1, "A name is required"),
});

/* ---------------- Shared helpers ---------------- */

/** Field-keyed error messages from a failed parse, for inline form errors. */
export function fieldErrors<T extends string>(
  error: z.ZodError,
): Partial<Record<T, string>> {
  const out: Partial<Record<T, string>> = {};
  for (const issue of error.issues) {
    const key = issue.path[0] as T | undefined;
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

/** The first error message from a failed parse, for an ActionResult. */
export function firstError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "That input isn't valid.";
}

/** A reasonably strong, readable random password for the "generate" button. */
export function generatePassword(length = 16): string {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%?";
  const bytes =
    typeof crypto !== "undefined" && crypto.getRandomValues
      ? crypto.getRandomValues(new Uint32Array(length))
      : Array.from({ length }, () => Math.floor(Math.random() * 2 ** 32));
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}
