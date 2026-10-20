import { describe, expect, it } from "vitest";
import { notificationVisibleTo } from "./notification-visibility";

describe("notificationVisibleTo", () => {
  it("shows admin broadcasts only to admins", () => {
    expect(
      notificationVisibleTo(
        { email: "a@x.com", isAdmin: true },
        { audience: "admins", recipientEmail: null },
      ),
    ).toBe(true);
    expect(
      notificationVisibleTo(
        { email: "t@x.com", isAdmin: false },
        { audience: "admins", recipientEmail: null },
      ),
    ).toBe(false);
  });

  it("shows user-targeted only to matching email", () => {
    expect(
      notificationVisibleTo(
        { email: "t@x.com", isAdmin: false },
        { audience: "user", recipientEmail: "t@x.com" },
      ),
    ).toBe(true);
    expect(
      notificationVisibleTo(
        { email: "other@x.com", isAdmin: true },
        { audience: "user", recipientEmail: "t@x.com" },
      ),
    ).toBe(false);
  });

  it("matches the recipient email case-insensitively", () => {
    expect(
      notificationVisibleTo(
        { email: "Tech@X.com", isAdmin: false },
        { audience: "user", recipientEmail: "tech@x.com" },
      ),
    ).toBe(true);
  });
});
