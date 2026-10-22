import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spec 33 Resend inbound helpers. The SDK verify call and the receiving
 * HTTP fetch are mocked; header mapping and failure results run for real.
 */

const { verifyMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(),
}));

vi.mock("resend", () => {
  class Resend {
    webhooks = { verify: verifyMock };
    constructor(_key?: string) {}
  }
  return { Resend };
});

import { fetchReceivedEmail, verifyResendWebhook } from "./resend-inbound";

const fetchMock = vi.fn();

function svixHeaders() {
  return new Headers({
    "svix-id": "msg_1",
    "svix-timestamp": "1700000000",
    "svix-signature": "v1,abc",
  });
}

beforeEach(() => {
  verifyMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_API_KEY;
});

describe("verifyResendWebhook", () => {
  it("verifies the raw payload with the svix headers and webhook secret", () => {
    process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
    const event = { type: "email.received" };
    verifyMock.mockReturnValue(event);

    expect(verifyResendWebhook('{"type":"email.received"}', svixHeaders())).toBe(
      event,
    );
    expect(verifyMock).toHaveBeenCalledWith({
      payload: '{"type":"email.received"}',
      headers: {
        id: "msg_1",
        timestamp: "1700000000",
        signature: "v1,abc",
      },
      webhookSecret: "whsec_test",
    });
  });

  it("throws when the signature check fails", () => {
    process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
    verifyMock.mockImplementation(() => {
      throw new Error("invalid signature");
    });

    expect(() => verifyResendWebhook("{}", svixHeaders())).toThrow(
      /invalid signature/,
    );
  });

  it("throws when the webhook secret is missing", () => {
    expect(() => verifyResendWebhook("{}", svixHeaders())).toThrow(
      /RESEND_WEBHOOK_SECRET/,
    );
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("throws when a svix header is missing", () => {
    process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
    const headers = svixHeaders();
    headers.delete("svix-signature");

    expect(() => verifyResendWebhook("{}", headers)).toThrow(/svix/i);
    expect(verifyMock).not.toHaveBeenCalled();
  });
});

describe("fetchReceivedEmail", () => {
  it("loads the received email body from the Resend receiving API", async () => {
    process.env.RESEND_API_KEY = "re_test";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        message_id: "<m@example.com>",
        from: "Tech <tech@example.com>",
        subject: "Re: [#42]",
        text: "hello",
        html: "<p>hello</p>",
        headers: { "In-Reply-To": "<out@example.com>" },
      }),
    });

    await expect(fetchReceivedEmail("email/1")).resolves.toEqual({
      message_id: "<m@example.com>",
      from: "Tech <tech@example.com>",
      subject: "Re: [#42]",
      text: "hello",
      html: "<p>hello</p>",
      headers: { "In-Reply-To": "<out@example.com>" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails/receiving/email%2F1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer re_test",
        }),
      }),
    );
  });

  it("returns null headers when the payload has none", async () => {
    process.env.RESEND_API_KEY = "re_test";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        message_id: "<m@example.com>",
        from: "tech@example.com",
        subject: "Hi",
        text: null,
        html: null,
        headers: null,
      }),
    });

    await expect(fetchReceivedEmail("email-1")).resolves.toEqual({
      message_id: "<m@example.com>",
      from: "tech@example.com",
      subject: "Hi",
      text: null,
      html: null,
    });
  });

  it("returns null when the API key is missing", async () => {
    await expect(fetchReceivedEmail("email-1")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the receiving API responds with an error", async () => {
    process.env.RESEND_API_KEY = "re_test";
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    await expect(fetchReceivedEmail("missing")).resolves.toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    process.env.RESEND_API_KEY = "re_test";
    fetchMock.mockRejectedValue(new Error("network"));

    await expect(fetchReceivedEmail("email-1")).resolves.toBeNull();
  });
});
