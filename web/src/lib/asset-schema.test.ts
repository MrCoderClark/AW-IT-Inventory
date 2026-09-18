import { describe, it, expect } from "vitest";

import {
  ASSET_STATUSES,
  ASSET_TYPES,
  EMPTY_ASSET_FORM,
  assetInputSchema,
  fieldErrors,
  firstError,
  type AssetFormValues,
} from "./asset-schema";

// The shared zod schema is the trust boundary: it is parsed on the client for
// inline errors and re-parsed in each Server Action. These lock in spec 08
// AC-4 (required fields, blank -> null, the date cross-check) plus AC-2's
// assignee handling.

const VALID: AssetFormValues = {
  name: "Test asset",
  type: "Monitor",
  status: "storage",
  serial: "",
  model: "",
  assigneeId: "",
  locationId: "",
  vendor: "",
  spec: "",
  costCenter: "",
  purchaseDate: "",
  warrantyUntil: "",
};

const A_UUID = "550e8400-e29b-41d4-a716-446655440000"; // a valid uuid v4

describe("assetInputSchema — required fields (AC-4)", () => {
  it("accepts a minimal valid input (name, type, status)", () => {
    const r = assetInputSchema.safeParse(VALID);
    expect(r.success).toBe(true);
  });

  it("rejects a blank name", () => {
    const r = assetInputSchema.safeParse({ ...VALID, name: "" });
    expect(r.success).toBe(false);
  });

  it("rejects a whitespace-only name", () => {
    const r = assetInputSchema.safeParse({ ...VALID, name: "   " });
    expect(r.success).toBe(false);
  });

  it("rejects a blank type", () => {
    const r = assetInputSchema.safeParse({ ...VALID, type: "" });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown type value", () => {
    const r = assetInputSchema.safeParse({ ...VALID, type: "Laptop" });
    expect(r.success).toBe(false);
  });

  it("rejects a blank status", () => {
    const r = assetInputSchema.safeParse({ ...VALID, status: "" });
    expect(r.success).toBe(false);
  });

  it("trims a padded name", () => {
    const r = assetInputSchema.safeParse({ ...VALID, name: "  Padded  " });
    expect(r.success && r.data.name).toBe("Padded");
  });
});

describe("assetInputSchema — blank optional fields become null (AC-4)", () => {
  it("coerces every blank optional field to null", () => {
    const r = assetInputSchema.safeParse(VALID);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.serial).toBeNull();
    expect(r.data.model).toBeNull();
    expect(r.data.locationId).toBeNull();
    expect(r.data.vendor).toBeNull();
    expect(r.data.spec).toBeNull();
    expect(r.data.costCenter).toBeNull();
    expect(r.data.assigneeId).toBeNull();
    expect(r.data.purchaseDate).toBeNull();
    expect(r.data.warrantyUntil).toBeNull();
  });

  it("coerces a whitespace-only optional field to null", () => {
    const r = assetInputSchema.safeParse({ ...VALID, vendor: "   " });
    expect(r.success && r.data.vendor).toBeNull();
  });

  it("trims a set optional field", () => {
    const r = assetInputSchema.safeParse({ ...VALID, model: "  Dell U2723  " });
    expect(r.success && r.data.model).toBe("Dell U2723");
  });
});

describe("assetInputSchema — date cross-check (AC-4)", () => {
  it("rejects a warranty date before the purchase date", () => {
    const r = assetInputSchema.safeParse({
      ...VALID,
      purchaseDate: "2025-06-01",
      warrantyUntil: "2024-06-01",
    });
    expect(r.success).toBe(false);
  });

  it("attaches the date error to the warrantyUntil field", () => {
    const r = assetInputSchema.safeParse({
      ...VALID,
      purchaseDate: "2025-06-01",
      warrantyUntil: "2024-06-01",
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => i.path[0] === "warrantyUntil")).toBe(true);
  });

  it("allows a warranty date equal to the purchase date", () => {
    const r = assetInputSchema.safeParse({
      ...VALID,
      purchaseDate: "2025-06-01",
      warrantyUntil: "2025-06-01",
    });
    expect(r.success).toBe(true);
  });

  it("allows a warranty date after the purchase date", () => {
    const r = assetInputSchema.safeParse({
      ...VALID,
      purchaseDate: "2024-06-01",
      warrantyUntil: "2027-06-01",
    });
    expect(r.success).toBe(true);
  });

  it("allows only the purchase date set (no cross-check)", () => {
    const r = assetInputSchema.safeParse({ ...VALID, purchaseDate: "2025-06-01" });
    expect(r.success).toBe(true);
  });

  it("allows only the warranty date set (no cross-check)", () => {
    const r = assetInputSchema.safeParse({ ...VALID, warrantyUntil: "2025-06-01" });
    expect(r.success).toBe(true);
  });

  it("rejects a malformed date string", () => {
    const r = assetInputSchema.safeParse({ ...VALID, purchaseDate: "06/01/2025" });
    expect(r.success).toBe(false);
  });
});

describe("assetInputSchema — assignee (AC-2)", () => {
  it("keeps a valid uuid assignee", () => {
    const r = assetInputSchema.safeParse({ ...VALID, assigneeId: A_UUID });
    expect(r.success && r.data.assigneeId).toBe(A_UUID);
  });

  it("rejects a non-uuid assignee", () => {
    const r = assetInputSchema.safeParse({ ...VALID, assigneeId: "not-a-uuid" });
    expect(r.success).toBe(false);
  });
});

describe("fieldErrors / firstError helpers (AC-4)", () => {
  it("maps issues to their field keys", () => {
    const r = assetInputSchema.safeParse({ ...VALID, name: "", status: "" });
    expect(r.success).toBe(false);
    if (r.success) return;
    const errs = fieldErrors(r.error);
    expect(errs.name).toBeTruthy();
    expect(errs.status).toBeTruthy();
  });

  it("returns the first issue message as a string", () => {
    const r = assetInputSchema.safeParse({ ...VALID, name: "" });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(typeof firstError(r.error)).toBe("string");
    expect(firstError(r.error).length).toBeGreaterThan(0);
  });
});

describe("schema constants and empty form", () => {
  it("exposes the five asset types and four statuses", () => {
    expect(ASSET_TYPES).toEqual([
      "Computer",
      "Monitor",
      "Printer",
      "Phone",
      "Network",
    ]);
    expect(ASSET_STATUSES).toEqual([
      "deployed",
      "maintenance",
      "online",
      "storage",
    ]);
  });

  it("the empty form is not itself valid (type and status blank)", () => {
    // Guards against a regression where EMPTY_ASSET_FORM drifts into a state
    // that would silently pass validation with no type or status chosen.
    expect(assetInputSchema.safeParse(EMPTY_ASSET_FORM).success).toBe(false);
  });
});
