import { describe, expect, it } from "vitest";

import {
  extractInReplyTo,
  normalizeEmailAddress,
  parseTicketNumberFromSubject,
  stripQuotedReply,
} from "@/lib/email-inbound";

describe("parseTicketNumberFromSubject", () => {
  it("extracts the number from a [#N] token", () => {
    expect(parseTicketNumberFromSubject("[H2Tecs] [#42] — assigned")).toBe(42);
    expect(parseTicketNumberFromSubject("Re: [#7] printer down")).toBe(7);
  });

  it("returns null when the subject has no [#N] token", () => {
    expect(parseTicketNumberFromSubject("General inquiry")).toBeNull();
    expect(parseTicketNumberFromSubject("[#not-a-number]")).toBeNull();
    expect(parseTicketNumberFromSubject("#42 without brackets")).toBeNull();
  });
});

describe("normalizeEmailAddress", () => {
  it("strips a display name and lowercases the address", () => {
    expect(normalizeEmailAddress("Jane Doe <Jane@Example.com>")).toBe(
      "jane@example.com",
    );
  });

  it("lowercases a bare email address", () => {
    expect(normalizeEmailAddress("  Admin@Corp.COM  ")).toBe("admin@corp.com");
  });
});

describe("stripQuotedReply", () => {
  it("removes content from an On … wrote: line onward", () => {
    const text = `Thanks for the update.

On Wed, Oct 21, 2026 John Doe wrote:
> old thread`;

    expect(stripQuotedReply(text)).toBe("Thanks for the update.");
  });

  it("removes content from the first quoted line starting with >", () => {
    const text = `Here is my reply.

> quoted previous message
> more quote`;

    expect(stripQuotedReply(text)).toBe("Here is my reply.");
  });

  it("returns trimmed empty string for blank input", () => {
    expect(stripQuotedReply("")).toBe("");
    expect(stripQuotedReply("   \n  ")).toBe("");
  });

  it("truncates long bodies to 8000 characters", () => {
    const long = "x".repeat(9000);
    expect(stripQuotedReply(long)).toHaveLength(8000);
    expect(stripQuotedReply(long)).toBe("x".repeat(8000));
  });
});

describe("extractInReplyTo", () => {
  it("reads in-reply-to case-insensitively", () => {
    expect(
      extractInReplyTo({
        "In-Reply-To": "<msg-123@example.com>",
      }),
    ).toBe("<msg-123@example.com>");
    expect(
      extractInReplyTo({
        "IN-REPLY-TO": "<other@mail.test>",
      }),
    ).toBe("<other@mail.test>");
  });

  it("returns null when headers are missing or have no in-reply-to", () => {
    expect(extractInReplyTo(undefined)).toBeNull();
    expect(extractInReplyTo({ Subject: "hi" })).toBeNull();
  });
});
