import { describe, it, expect } from "vitest";

import {
  personInputSchema,
  personFieldErrors,
  personFirstError,
  EMPTY_PERSON_FORM,
} from "./person-schema";

/**
 * Unit tests for the people directory form schema (spec 16). Pure validation, no
 * mocks. Traces:
 *   AC-1 name required; optional fields; blanks stored as null
 *   AC-3 email is validated when present (uniqueness itself is a DB concern)
 */

describe("personInputSchema — required name (AC-1)", () => {
  it("accepts a name-only person and turns every blank optional into null", () => {
    const parsed = personInputSchema.safeParse({ ...EMPTY_PERSON_FORM, name: "Sarah Jenkins" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({
      name: "Sarah Jenkins",
      email: null,
      department: null,
      jobTitle: null,
      phone: null,
      employeeId: null,
      officeLocationId: null,
    });
  });

  it("rejects an empty name", () => {
    const parsed = personInputSchema.safeParse({ ...EMPTY_PERSON_FORM, name: "" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(personFirstError(parsed.error)).toMatch(/name is required/i);
  });

  it("rejects a whitespace-only name and trims a real one", () => {
    expect(
      personInputSchema.safeParse({ ...EMPTY_PERSON_FORM, name: "   " }).success,
    ).toBe(false);
    const ok = personInputSchema.safeParse({ ...EMPTY_PERSON_FORM, name: "  Ana López  " });
    expect(ok.success && ok.data.name).toBe("Ana López");
  });
});

describe("personInputSchema — optional fields (AC-1, AC-3)", () => {
  it("keeps and trims provided optional values", () => {
    const parsed = personInputSchema.safeParse({
      name: "Grace Park",
      email: "  grace@company.com ",
      department: " Finance ",
      jobTitle: " Analyst ",
      phone: " 555-0100 ",
      employeeId: " EMP-9 ",
      officeLocationId: "",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.email).toBe("grace@company.com");
    expect(parsed.data.department).toBe("Finance");
    expect(parsed.data.jobTitle).toBe("Analyst");
    expect(parsed.data.phone).toBe("555-0100");
    expect(parsed.data.employeeId).toBe("EMP-9");
    expect(parsed.data.officeLocationId).toBeNull();
  });

  it("rejects a malformed email but allows a blank one (AC-3)", () => {
    expect(
      personInputSchema.safeParse({ ...EMPTY_PERSON_FORM, name: "X", email: "not-an-email" }).success,
    ).toBe(false);
    const blank = personInputSchema.safeParse({ ...EMPTY_PERSON_FORM, name: "X", email: "" });
    expect(blank.success && blank.data.email).toBeNull();
  });

  it("rejects a non-uuid office location but allows a blank one", () => {
    expect(
      personInputSchema.safeParse({ ...EMPTY_PERSON_FORM, name: "X", officeLocationId: "not-a-uuid" }).success,
    ).toBe(false);
    const ok = personInputSchema.safeParse({
      ...EMPTY_PERSON_FORM,
      name: "X",
      officeLocationId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(ok.success && ok.data.officeLocationId).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });
});

describe("error helpers", () => {
  it("personFieldErrors keys the first message per field", () => {
    const parsed = personInputSchema.safeParse({ ...EMPTY_PERSON_FORM, name: "", email: "bad" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const errs = personFieldErrors(parsed.error);
    expect(errs.name).toMatch(/name is required/i);
    expect(errs.email).toMatch(/valid email/i);
  });

  it("personFirstError returns a stable fallback with no issues", () => {
    // A ZodError with an empty issues list falls back to the generic message.
    const fake = { issues: [] } as unknown as Parameters<typeof personFirstError>[0];
    expect(personFirstError(fake)).toMatch(/isn't valid/i);
  });
});
