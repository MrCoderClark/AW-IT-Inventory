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
    process.env.OPUS_WEB_CLIENT_ID = "cid";
    process.env.OPUS_WEB_CLIENT_SECRET = "sec";
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

  it("skips the call and returns false when opus-web creds are unset", async () => {
    delete process.env.OPUS_WEB_CLIENT_ID;
    delete process.env.OPUS_WEB_CLIENT_SECRET;
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const { sendPrinterAlert } = await import("./notify");
    expect(await sendPrinterAlert(EVENT)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
