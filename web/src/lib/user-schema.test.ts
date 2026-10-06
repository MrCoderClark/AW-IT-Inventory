import { describe, it, expect } from "vitest";

import {
  generatePassword,
  passwordChangeSchema,
  setPasswordSchema,
  userCreateSchema,
} from "./user-schema";

describe("userCreateSchema", () => {
  it("accepts a valid user and defaults roles to []", () => {
    const res = userCreateSchema.safeParse({
      email: "a@x.co",
      full_name: "A Person",
      password: "longenough1",
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.roles).toEqual([]);
  });

  it("rejects a bad email", () => {
    const res = userCreateSchema.safeParse({
      email: "not-an-email",
      full_name: "A",
      password: "longenough1",
    });
    expect(res.success).toBe(false);
  });

  it("rejects a password under 8 characters", () => {
    const res = userCreateSchema.safeParse({
      email: "a@x.co",
      full_name: "A",
      password: "short",
    });
    expect(res.success).toBe(false);
  });

  it("requires a non-empty name", () => {
    const res = userCreateSchema.safeParse({
      email: "a@x.co",
      full_name: "   ",
      password: "longenough1",
    });
    expect(res.success).toBe(false);
  });
});

describe("password confirmation schemas", () => {
  it("passwordChangeSchema rejects mismatched confirmation", () => {
    const res = passwordChangeSchema.safeParse({
      current_password: "old",
      new_password: "longenough1",
      confirm_password: "different22",
    });
    expect(res.success).toBe(false);
  });

  it("setPasswordSchema accepts a matching pair", () => {
    const res = setPasswordSchema.safeParse({
      new_password: "longenough1",
      confirm_password: "longenough1",
    });
    expect(res.success).toBe(true);
  });
});

describe("generatePassword", () => {
  it("produces a string of the requested length", () => {
    expect(generatePassword(20)).toHaveLength(20);
  });

  it("produces different values across calls", () => {
    expect(generatePassword()).not.toEqual(generatePassword());
  });
});
