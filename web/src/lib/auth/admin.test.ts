import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createUser, getUserByEmail } from "./admin";

/**
 * The aw-auth admin client. `fetch` is stubbed. Covers the email link
 * (`getUserByEmail`, the crux of the People↔User match) and that a DRF error
 * body is surfaced verbatim so the UI shows aw-auth's own messages.
 */

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const USERS = [
  { id: "1", email: "Admin@Corp.com", full_name: "Admin", roles: ["Admin"], is_active: true },
  { id: "2", email: "tech@corp.com", full_name: "Tech", roles: ["Technician"], is_active: true },
];

describe("getUserByEmail", () => {
  it("matches case-insensitively", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, USERS));
    const u = await getUserByEmail("tok", "ADMIN@corp.com");
    expect(u?.id).toBe("1");
  });

  it("returns null for an unmatched email", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, USERS));
    expect(await getUserByEmail("tok", "nobody@corp.com")).toBeNull();
  });

  it("returns null for a blank email without calling aw-auth", async () => {
    expect(await getUserByEmail("tok", "")).toBeNull();
    expect(await getUserByEmail("tok", null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DRF error surfacing", () => {
  it("uses the `detail` message", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { detail: "Nope." }));
    const res = await createUser("tok", {
      email: "a@x.co",
      full_name: "A",
      password: "longenough1",
      roles: [],
    });
    expect(res).toEqual({ ok: false, status: 400, error: "Nope." });
  });

  it("falls back to the first field error (array value)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { email: ["user with this email already exists."] }),
    );
    const res = await createUser("tok", {
      email: "a@x.co",
      full_name: "A",
      password: "longenough1",
      roles: [],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already exists/);
  });
});
