import { z } from "zod";

import type { AssetType } from "@/lib/data";
import type { AssetFormValues } from "@/lib/asset-schema";

/**
 * The per-type field registry (spec 10). One definition per asset type lists the
 * fields that type has beyond the shared ones, and which shared fields it hides.
 * The add/edit form renders its section from this, the detail page renders the
 * same fields from it, and the per-type zod schema is derived from it, so a field
 * is declared exactly once.
 */

export type FieldKind = "text" | "int" | "decimal" | "select";

export interface TypeField {
  /** Matches the detail-table column and the form value key (camelCase). */
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  /** For `select`: the allowed values. */
  options?: readonly string[];
  /** A `select` that stores a boolean: "Yes" -> true, "No" -> false, "" -> null. */
  bool?: boolean;
  placeholder?: string;
}

export interface TypeFormConfig {
  fields: readonly TypeField[];
  /** Shared form fields hidden for this type (e.g. Assignee for Printer). */
  hiddenShared: readonly (keyof AssetFormValues)[];
}

export const TYPE_FIELDS: Record<AssetType, TypeFormConfig> = {
  Computer: {
    hiddenShared: [],
    fields: [
      {
        key: "formFactor",
        label: "Form factor",
        kind: "select",
        options: ["laptop", "desktop", "all-in-one", "tower"],
      },
      { key: "operatingSystem", label: "Operating system", kind: "text" },
      { key: "cpu", label: "CPU", kind: "text" },
      { key: "ramGb", label: "RAM (GB)", kind: "int" },
      { key: "storage", label: "Storage", kind: "text" },
    ],
  },
  Monitor: {
    hiddenShared: [],
    fields: [
      { key: "sizeInches", label: "Size (inches)", kind: "decimal" },
      { key: "resolution", label: "Resolution", kind: "text", placeholder: "e.g. 3840x2160" },
      {
        key: "panelType",
        label: "Panel type",
        kind: "select",
        options: ["IPS", "VA", "OLED", "TN"],
      },
      { key: "refreshHz", label: "Refresh rate (Hz)", kind: "int" },
      { key: "ports", label: "Ports", kind: "text" },
      { key: "isCurved", label: "Curved", kind: "select", options: ["Yes", "No"], bool: true },
    ],
  },
  Printer: {
    hiddenShared: ["assigneeId"],
    fields: [
      {
        key: "ipAddress",
        label: "IP address",
        kind: "text",
        required: true,
        placeholder: "e.g. 192.168.70.20",
      },
      { key: "colorMode", label: "Color mode", kind: "select", options: ["mono", "color"] },
      { key: "isDuplex", label: "Duplex", kind: "select", options: ["Yes", "No"], bool: true },
      { key: "pageCount", label: "Page count", kind: "int" },
      { key: "connection", label: "Connection", kind: "select", options: ["network", "USB"] },
      { key: "mgmtUrl", label: "Management URL", kind: "text" },
    ],
  },
  Phone: {
    hiddenShared: [],
    fields: [
      { key: "imei", label: "IMEI", kind: "text" },
      { key: "phoneNumber", label: "Phone number", kind: "text" },
      { key: "carrier", label: "Carrier", kind: "text" },
      { key: "storageGb", label: "Storage (GB)", kind: "int" },
      { key: "os", label: "OS", kind: "select", options: ["iOS", "Android"] },
      { key: "plan", label: "Plan", kind: "text" },
    ],
  },
  Network: {
    hiddenShared: ["assigneeId"],
    fields: [
      { key: "ipAddress", label: "IP address", kind: "text", placeholder: "e.g. 192.168.70.1" },
      { key: "macAddress", label: "MAC address", kind: "text", placeholder: "e.g. AA:BB:CC:00:11:22" },
      {
        key: "deviceRole",
        label: "Device role",
        kind: "select",
        options: ["switch", "router", "access-point", "firewall"],
      },
      { key: "portCount", label: "Port count", kind: "int" },
      { key: "firmware", label: "Firmware", kind: "text" },
      { key: "mgmtUrl", label: "Management URL", kind: "text" },
    ],
  },
};

/** Trim, and turn "" (or nullish) into null. */
function emptyToNull(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

/** The zod schema for one field, mapping the form string to its stored type. */
function fieldSchema(f: TypeField): z.ZodTypeAny {
  const label = f.label;
  switch (f.kind) {
    case "text":
      return f.required
        ? z.preprocess(emptyToNull, z.string({ error: `${label} is required` }))
        : z.preprocess(emptyToNull, z.string().nullable());
    case "int":
      return z.preprocess(
        (v) => {
          const s = emptyToNull(v);
          return s === null ? null : Number(s);
        },
        z
          .number({ error: `${label} must be a whole number` })
          .int(`${label} must be a whole number`)
          .nullable(),
      );
    case "decimal":
      // Stored as a Postgres numeric, which round-trips as a string.
      return z.preprocess(
        emptyToNull,
        z.union([
          z.null(),
          z.string().regex(/^-?\d+(\.\d+)?$/, `${label} must be a number`),
        ]),
      );
    case "select":
      if (f.bool) {
        return z.preprocess((v) => {
          const s = emptyToNull(v);
          if (s === null) return null;
          return s === "Yes" ? true : s === "No" ? false : s;
        }, z.boolean().nullable());
      }
      return f.required
        ? z.preprocess(emptyToNull, z.enum(f.options as [string, ...string[]]))
        : z.preprocess(
            emptyToNull,
            z.union([z.null(), z.enum(f.options as [string, ...string[]])]),
          );
  }
}

/** The details schema for a type: an object keyed by each field's `key`. */
export function detailsSchemaFor(type: AssetType) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of TYPE_FIELDS[type].fields) shape[f.key] = fieldSchema(f);
  return z.object(shape);
}

/** The validated, stored shape of a type's details (values already coerced). */
export type DetailsInput = Record<string, string | number | boolean | null>;

/** The raw form shape for a type's details: every field a string. */
export type DetailsFormValues = Record<string, string>;

/** A blank details form for a type (checkbox-style selects start unset). */
export function emptyDetailsFor(type: AssetType): DetailsFormValues {
  const out: DetailsFormValues = {};
  for (const f of TYPE_FIELDS[type].fields) out[f.key] = "";
  return out;
}

/** Turn a stored detail row into form strings for the edit prefill. */
export function detailsToFormValues(
  type: AssetType,
  row: Record<string, unknown> | null | undefined,
): DetailsFormValues {
  const out = emptyDetailsFor(type);
  if (!row) return out;
  for (const f of TYPE_FIELDS[type].fields) {
    const v = row[f.key];
    if (v == null) {
      out[f.key] = "";
    } else if (f.bool) {
      out[f.key] = v === true ? "Yes" : v === false ? "No" : "";
    } else {
      out[f.key] = String(v);
    }
  }
  return out;
}

/** Field-keyed error messages from a failed details parse, for inline errors. */
export function detailsFieldErrors(
  error: z.ZodError,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !out[key]) out[key] = issue.message;
  }
  return out;
}
