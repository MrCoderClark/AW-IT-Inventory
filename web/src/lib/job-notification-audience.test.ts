import { describe, expect, it } from "vitest";
import { resolveJobNotificationAudience } from "./job-notification-audience";

describe("resolveJobNotificationAudience", () => {
  it("targets the requester when requestedBy looks like an email", () => {
    expect(resolveJobNotificationAudience("tech@opus.local")).toEqual({
      audience: "user",
      recipientEmail: "tech@opus.local",
    });
  });

  it("trims whitespace before checking", () => {
    expect(resolveJobNotificationAudience("  tech@opus.local  ")).toEqual({
      audience: "user",
      recipientEmail: "tech@opus.local",
    });
  });

  it("falls back to admins for schedule tokens", () => {
    expect(
      resolveJobNotificationAudience("schedule:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    ).toEqual({ audience: "admins", recipientEmail: null });
  });

  it("falls back to admins for empty / non-email strings", () => {
    expect(resolveJobNotificationAudience("")).toEqual({
      audience: "admins",
      recipientEmail: null,
    });
    expect(resolveJobNotificationAudience("worker-1")).toEqual({
      audience: "admins",
      recipientEmail: null,
    });
  });
});
