import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/ingest/email (spec 33). Signature verification, the receiving
 * fetch, and comment processing are mocked. Locks status codes: bad
 * signature 401; ignored / duplicate / commented 200; a missing received
 * body or a processing throw 500 so Resend retries. The route must not
 * call the attachments API.
 */

const { verifyMock, fetchEmailMock, processMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  fetchEmailMock: vi.fn(),
  processMock: vi.fn(),
}));

vi.mock("@/lib/resend-inbound", () => ({
  verifyResendWebhook: verifyMock,
  fetchReceivedEmail: fetchEmailMock,
}));

vi.mock("@/db/ticket-email", () => ({
  processInboundEmail: processMock,
}));

import { POST } from "./route";

const fetchMock = vi.fn();

function receivedEvent(data: Record<string, unknown> = {}) {
  return {
    type: "email.received",
    data: {
      email_id: "em_1",
      message_id: "<event@h2tecs.local>",
      from: "Event <event@example.com>",
      subject: "event subject",
      ...data,
    },
  };
}

function post(body: unknown) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/api/ingest/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": "msg_1",
      "svix-timestamp": "1700000000",
      "svix-signature": "v1,abc",
    },
    body: raw,
  });
}

function fullEmail(overrides: Record<string, unknown> = {}) {
  return {
    message_id: "<full@h2tecs.local>",
    from: "Tech <tech@example.com>",
    subject: "Re: [H2Tecs] [#7] — assigned",
    text: "On it.",
    html: "<p>On it.</p>",
    headers: { "in-reply-to": "<out@h2tecs.local>" },
    ...overrides,
  };
}

beforeEach(() => {
  verifyMock.mockReset();
  fetchEmailMock.mockReset();
  processMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  verifyMock.mockReturnValue({ type: "email.received" });
  fetchEmailMock.mockResolvedValue(fullEmail());
  processMock.mockResolvedValue({ status: "commented" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/ingest/email", () => {
  it("returns 401 when the webhook signature is bad and does not fetch or process", async () => {
    verifyMock.mockImplementation(() => {
      throw new Error("invalid signature");
    });

    const res = await POST(post(receivedEvent()));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    expect(fetchEmailMock).not.toHaveBeenCalled();
    expect(processMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 200 ignored for a non-received event without fetching the body", async () => {
    const res = await POST(post({ type: "email.sent", data: { email_id: "em_1" } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(fetchEmailMock).not.toHaveBeenCalled();
    expect(processMock).not.toHaveBeenCalled();
  });

  it("returns 200 ignored when email.received has no email_id", async () => {
    const res = await POST(
      post({ type: "email.received", data: { from: "a@example.com" } }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(fetchEmailMock).not.toHaveBeenCalled();
    expect(processMock).not.toHaveBeenCalled();
  });

  it("verifies the raw body and comments from the fetched email", async () => {
    const event = receivedEvent({
      attachments: [{ id: "att_1", filename: "shot.png" }],
    });
    const req = post(event);

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "commented" });
    expect(verifyMock).toHaveBeenCalledWith(JSON.stringify(event), req.headers);
    expect(fetchEmailMock).toHaveBeenCalledTimes(1);
    expect(fetchEmailMock).toHaveBeenCalledWith("em_1");
    expect(processMock).toHaveBeenCalledWith({
      emailId: "em_1",
      messageId: "<full@h2tecs.local>",
      from: "Tech <tech@example.com>",
      subject: "Re: [H2Tecs] [#7] — assigned",
      text: "On it.",
      html: "<p>On it.</p>",
      headers: { "in-reply-to": "<out@h2tecs.local>" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(processMock.mock.calls[0][0]).not.toHaveProperty("attachments");
  });

  it("falls back to webhook fields when the fetched message id, from, or subject is blank", async () => {
    fetchEmailMock.mockResolvedValue(
      fullEmail({ message_id: "", from: "", subject: "" }),
    );

    const res = await POST(post(receivedEvent()));

    expect(res.status).toBe(200);
    expect(processMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "<event@h2tecs.local>",
        from: "Event <event@example.com>",
        subject: "event subject",
      }),
    );
  });

  it("uses the email id as the message id when neither fetch nor the event has one", async () => {
    fetchEmailMock.mockResolvedValue(fullEmail({ message_id: "" }));

    const res = await POST(
      post(receivedEvent({ message_id: "", from: "", subject: "" })),
    );

    expect(res.status).toBe(200);
    expect(processMock).toHaveBeenCalledWith(
      expect.objectContaining({
        emailId: "em_1",
        messageId: "em_1",
        from: "Tech <tech@example.com>",
        subject: "Re: [H2Tecs] [#7] — assigned",
      }),
    );
  });

  it("returns 200 when the sender is unauthorized", async () => {
    processMock.mockResolvedValue({
      status: "ignored",
      reason: "unauthorized",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(post(receivedEvent()));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      status: "ignored",
      reason: "unauthorized",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "[ingest/email] ignored",
      "unauthorized",
      "em_1",
    );
  });

  it("returns 200 for a duplicate and for an ignored no-ticket reply", async () => {
    processMock.mockResolvedValueOnce({ status: "duplicate" });
    const duplicate = await POST(post(receivedEvent()));
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ ok: true, status: "duplicate" });

    processMock.mockResolvedValueOnce({ status: "ignored", reason: "no_ticket" });
    const ignored = await POST(post(receivedEvent()));
    expect(ignored.status).toBe(200);
    expect(await ignored.json()).toEqual({
      ok: true,
      status: "ignored",
      reason: "no_ticket",
    });
  });

  it("returns 500 when the received email cannot be fetched so Resend retries", async () => {
    fetchEmailMock.mockResolvedValue(null);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(post(receivedEvent()));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "fetch failed" });
    expect(processMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("[ingest/email] fetch failed", "em_1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 500 when processing the inbound email throws", async () => {
    const err = new Error("db down");
    processMock.mockRejectedValue(err);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(post(receivedEvent()));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "process failed" });
    expect(errorSpy).toHaveBeenCalledWith("[ingest/email] process failed", err);
  });
});
