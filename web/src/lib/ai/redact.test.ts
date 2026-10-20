import { describe, expect, it } from "vitest";

import { hashContext, redactDeep, redactText } from "./redact";

describe("redact", () => {
  it("redacts password-like values in text", () => {
    expect(redactText("password: hunter2 remaining")).toContain("[REDACTED]");
    expect(redactText("password: hunter2 remaining")).not.toContain("hunter2");
  });

  it("redacts secret-ish object keys", () => {
    const out = redactDeep({
      tag: "PC-1",
      apiKey: "sk-live",
      nested: { refresh_token: "abc", note: "ok" },
    });
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.nested.refresh_token).toBe("[REDACTED]");
    expect(out.nested.note).toBe("ok");
    expect(out.tag).toBe("PC-1");
  });

  it("hashes context stably", () => {
    const a = hashContext({ x: 1 });
    const b = hashContext({ x: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});
