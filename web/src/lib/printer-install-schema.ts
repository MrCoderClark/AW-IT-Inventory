import { z } from "zod";

/**
 * Remote printer install form (spec 20). Parsed on the client for inline errors
 * and re-parsed in the server action (the trust boundary). The chosen package id
 * is re-validated against the filesystem catalog server-side; this schema only
 * checks the shape and the connection fields.
 */

export type ConnectionKind = "tcpip" | "wsd" | "share";

export const installInputSchema = z
  .object({
    packageId: z.string().min(1, "Choose a driver package"),
    printerName: z.string().trim().min(1, "A printer name is required"),
    connectionType: z.enum(["tcpip", "wsd", "share"]),
    host: z.string().trim().optional().default(""),
    port: z.coerce.number().int().positive().max(65535).optional(),
    sharePath: z.string().trim().optional().default(""),
    // Remove any existing printer/port already bound to this IP before adding
    // (clears a decommissioned device that reused the address). TCP/IP only.
    replaceExisting: z.boolean().optional().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.connectionType === "tcpip" && !v.host) {
      ctx.addIssue({
        path: ["host"],
        code: "custom",
        message: "A printer IP or hostname is required",
      });
    }
    if (v.connectionType === "share" && !v.sharePath) {
      ctx.addIssue({
        path: ["sharePath"],
        code: "custom",
        message: "A share path (\\\\server\\queue) is required",
      });
    }
  });

export type InstallInput = z.output<typeof installInputSchema>;

export interface InstallFormValues {
  packageId: string;
  printerName: string;
  connectionType: ConnectionKind;
  host: string;
  port: string;
  sharePath: string;
  replaceExisting: boolean;
}

export const EMPTY_INSTALL_FORM: InstallFormValues = {
  packageId: "",
  printerName: "",
  connectionType: "tcpip",
  host: "",
  port: "9100",
  sharePath: "",
  replaceExisting: true,
};

export function installFieldErrors(
  error: z.ZodError,
): Partial<Record<keyof InstallFormValues, string>> {
  const out: Partial<Record<keyof InstallFormValues, string>> = {};
  for (const issue of error.issues) {
    const key = issue.path[0] as keyof InstallFormValues | undefined;
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

export function installFirstError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "That input isn't valid.";
}
