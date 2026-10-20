import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  selects: [] as unknown[][],
  createMock: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/db/scripts", () => ({
  createScript: H.createMock,
}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
  },
}));

import { ensureStarterScripts, STARTER_SCRIPTS } from "./script-starters";

beforeEach(() => {
  vi.clearAllMocks();
  H.selects = [];
  H.selectMock.mockImplementation(() => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ["from", "where", "limit"]) b[m] = self;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(H.selects.shift() ?? []).then(res, rej);
    return b;
  });
});

describe("ensureStarterScripts", () => {
  it("inserts missing starters and skips existing names", async () => {
    // First starter missing, second present.
    H.selects = [[], [{ id: "existing" }]];
    H.createMock.mockResolvedValue({ ok: true, id: "new-1" });

    const res = await ensureStarterScripts("admin@x");

    expect(res.added).toEqual([STARTER_SCRIPTS[0].name]);
    expect(res.skipped).toEqual([STARTER_SCRIPTS[1].name]);
    expect(H.createMock).toHaveBeenCalledTimes(1);
    expect(H.createMock.mock.calls[0][0].name).toBe(STARTER_SCRIPTS[0].name);
    expect(H.createMock.mock.calls[0][0].actorEmail).toBe("admin@x");
  });

  it("defines two hardened starters", () => {
    expect(STARTER_SCRIPTS).toHaveLength(2);
    for (const s of STARTER_SCRIPTS) {
      expect(s.body).not.toMatch(/\bexit\s+\d/);
      expect(s.body).toMatch(/Write-Output/);
    }
  });
});
