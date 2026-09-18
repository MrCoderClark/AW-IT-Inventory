import { describe, it, expect } from "vitest";

import {
  createLocationSchema,
  firstLocationError,
  moveLocationSchema,
  renameLocationSchema,
} from "./location-schema";

// The shared zod schema is the trust boundary for the location tree: it is parsed
// on the client (inline errors) and re-parsed in each Server Action. These lock in
// spec 09 AC-2's name rules (required, trimmed, unique-sibling is checked in the
// action) and the nullable-uuid parent/target handling.

const A_UUID = "550e8400-e29b-41d4-a716-446655440000"; // a valid uuid

describe("createLocationSchema (AC-2)", () => {
  it("accepts a top-level location (name, no parent)", () => {
    const r = createLocationSchema.safeParse({ name: "New York", parentId: null });
    expect(r.success && r.data).toEqual({ name: "New York", parentId: null });
  });

  it("accepts a child location with a uuid parent", () => {
    const r = createLocationSchema.safeParse({ name: "Bronx", parentId: A_UUID });
    expect(r.success && r.data.parentId).toBe(A_UUID);
  });

  it("rejects a blank name", () => {
    expect(createLocationSchema.safeParse({ name: "", parentId: null }).success).toBe(
      false,
    );
  });

  it("rejects a whitespace-only name", () => {
    expect(
      createLocationSchema.safeParse({ name: "   ", parentId: null }).success,
    ).toBe(false);
  });

  it("trims a padded name", () => {
    const r = createLocationSchema.safeParse({ name: "  Bronx  ", parentId: null });
    expect(r.success && r.data.name).toBe("Bronx");
  });

  it("rejects a name longer than 100 characters", () => {
    const r = createLocationSchema.safeParse({
      name: "x".repeat(101),
      parentId: null,
    });
    expect(r.success).toBe(false);
  });

  it("coerces a blank parentId to null (top level)", () => {
    const r = createLocationSchema.safeParse({ name: "New York", parentId: "" });
    expect(r.success && r.data.parentId).toBeNull();
  });

  it("coerces an explicit null parentId to null (top level)", () => {
    // The form always sends parentId explicitly (null for a top-level location,
    // a uuid for a child), so null and "" are the real top-level inputs.
    const r = createLocationSchema.safeParse({ name: "New York", parentId: null });
    expect(r.success && r.data.parentId).toBeNull();
  });

  it("rejects a non-uuid parentId", () => {
    expect(
      createLocationSchema.safeParse({ name: "Bronx", parentId: "nope" }).success,
    ).toBe(false);
  });
});

describe("renameLocationSchema (AC-3)", () => {
  it("accepts a valid name", () => {
    const r = renameLocationSchema.safeParse({ name: "Woodside" });
    expect(r.success && r.data.name).toBe("Woodside");
  });

  it("rejects a blank name", () => {
    expect(renameLocationSchema.safeParse({ name: "" }).success).toBe(false);
  });
});

describe("moveLocationSchema (AC-4)", () => {
  it("keeps a valid uuid target", () => {
    const r = moveLocationSchema.safeParse({ newParentId: A_UUID });
    expect(r.success && r.data.newParentId).toBe(A_UUID);
  });

  it("coerces a blank target to null (move to top level)", () => {
    const r = moveLocationSchema.safeParse({ newParentId: "" });
    expect(r.success && r.data.newParentId).toBeNull();
  });

  it("rejects a non-uuid target", () => {
    expect(moveLocationSchema.safeParse({ newParentId: "bad" }).success).toBe(false);
  });
});

describe("firstLocationError", () => {
  it("returns the first issue message as a string", () => {
    const r = createLocationSchema.safeParse({ name: "", parentId: null });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(typeof firstLocationError(r.error)).toBe("string");
    expect(firstLocationError(r.error).length).toBeGreaterThan(0);
  });
});
