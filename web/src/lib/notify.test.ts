import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { AlertEvent } from "@/db/reachability";

vi.mock("server-only", () => ({}));

const EVENT: AlertEvent = {
  assetId: "asset-1",
  event: "down",
  name: "Front Printer",
  ip: "192.168.70.202",
  since: null,
};

/**
 * Mock fetch: the token endpoint returns an access token; the notify endpoint
 * returns the given status + body. Lets each test drive the { sent } response.
 */
function mockFetch(notifyBody: unknown, notifyStatus = 200) {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/v1/auth/token/client")) {
      return new Response(JSON.stringify({ access: "aaa.bbb.ccc" }), { status: 200 });
    }
    return new Response(JSON.stringify(notifyBody), { status: notifyStatus });
  });
}

describe("sendPrinterAlert (spec 12)", () => {
  beforeEach(() => {
    // Reset the module-level token cache between cases.
    vi.resetModules();
    process.env.H2TECS_WEB_CLIENT_ID = "cid";
    process.env.H2TECS_WEB_CLIENT_SECRET = "sec";
    // The failure/skip paths log on purpose; keep the test output clean.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns true when aw-auth reports the alert was sent", async () => {
    vi.stubGlobal("fetch", mockFetch({ ok: true, sent: true }));
    const { sendPrinterAlert } = await import("./notify");
    expect(await sendPrinterAlert(EVENT)).toBe(true);
  });

  it("returns false when aw-auth accepted (200) but sent=false, so it retries", async () => {
    // The bug: web used to return true on any 200 and advance lastAlertState,
    // dropping the alert even though Resend never delivered it.
    vi.stubGlobal("fetch", mockFetch({ ok: true, sent: false }));
    const { sendPrinterAlert } = await import("./notify");
    expect(await sendPrinterAlert(EVENT)).toBe(false);
  });

  it("returns false on a non-2xx notify response", async () => {
    vi.stubGlobal("fetch", mockFetch({ error: "boom" }, 500));
    const { sendPrinterAlert } = await import("./notify");
    expect(await sendPrinterAlert(EVENT)).toBe(false);
  });

  it("skips the call and returns false when h2tecs-web creds are unset", async () => {
    delete process.env.H2TECS_WEB_CLIENT_ID;
    delete process.env.H2TECS_WEB_CLIENT_SECRET;
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const { sendPrinterAlert } = await import("./notify");
    expect(await sendPrinterAlert(EVENT)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

const RULE_PAYLOAD = {
  computer: { name: "Reception PC", tag: "H2TECS-COMP-1" },
  event: "firing" as const,
  rule: {
    name: "Disk almost full",
    condition: "Disk ≥ 90% for 1 sample (~15 min)",
    severity: "critical",
  },
  value: "91%",
};

describe("sendAlertRuleEmail (spec 30, AC-6)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.H2TECS_WEB_CLIENT_ID = "cid";
    process.env.H2TECS_WEB_CLIENT_SECRET = "sec";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts to /v1/notify/alert-rule and returns true when sent", async () => {
    const fetchMock = mockFetch({ ok: true, sent: true });
    vi.stubGlobal("fetch", fetchMock);
    const { sendAlertRuleEmail } = await import("./notify");
    expect(await sendAlertRuleEmail(RULE_PAYLOAD)).toBe(true);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/v1/notify/alert-rule"))).toBe(true);
  });

  it("returns false when aw-auth accepted but sent=false", async () => {
    vi.stubGlobal("fetch", mockFetch({ ok: true, sent: false }));
    const { sendAlertRuleEmail } = await import("./notify");
    expect(await sendAlertRuleEmail(RULE_PAYLOAD)).toBe(false);
  });
});

const TICKET_PAYLOAD = {
  event: "assigned" as const,
  ticket: {
    id: "t-1",
    number: 42,
    subject: "Printer jam",
    status: "open",
    priority: "normal",
    assigneeEmail: "tech@co.com",
  },
  recipients: ["tech@co.com"],
  detail: "Assigned to you",
  actorEmail: "admin@co.com",
};

describe("sendTicketEmail (spec 33)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.H2TECS_WEB_CLIENT_ID = "cid";
    process.env.H2TECS_WEB_CLIENT_SECRET = "sec";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts to /v1/notify/ticket and returns true when sent", async () => {
    const fetchMock = mockFetch({ ok: true, sent: true });
    vi.stubGlobal("fetch", fetchMock);
    const { sendTicketEmail } = await import("./notify");
    expect(await sendTicketEmail(TICKET_PAYLOAD)).toBe(true);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/v1/notify/ticket"))).toBe(true);
  });

  it("returns false when aw-auth accepted but sent=false", async () => {
    vi.stubGlobal("fetch", mockFetch({ ok: true, sent: false }));
    const { sendTicketEmail } = await import("./notify");
    expect(await sendTicketEmail(TICKET_PAYLOAD)).toBe(false);
  });

  it("skips the call and returns false when h2tecs-web creds are unset", async () => {
    delete process.env.H2TECS_WEB_CLIENT_ID;
    delete process.env.H2TECS_WEB_CLIENT_SECRET;
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const { sendTicketEmail } = await import("./notify");
    expect(await sendTicketEmail(TICKET_PAYLOAD)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
