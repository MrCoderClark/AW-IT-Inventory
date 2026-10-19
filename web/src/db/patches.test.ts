import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for Windows patch inventory helpers (spec 31). The DB client is
 * mocked; the logic under test is hotfix/app-upgrade collapse, date sanitizing,
 * and the winget-false path that must leave prior app rows intact (AC-8).
 */

const H = vi.hoisted(() => {
  const state: {
    selectResults: unknown[][];
    inserted: unknown[];
    txDeletes: unknown[];
    conflictSets: Record<string, unknown>[];
  } = {
    selectResults: [],
    inserted: [],
    txDeletes: [],
    conflictSets: [],
  };

  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of [
      "from",
      "leftJoin",
      "innerJoin",
      "where",
      "groupBy",
      "orderBy",
      "limit",
    ]) {
      b[m] = self;
    }
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(state.selectResults.shift() ?? []).then(resolve, reject);
    return b;
  };

  const txDeleteMock = vi.fn((table: unknown) => ({
    where: () => {
      state.txDeletes.push(table);
      return Promise.resolve();
    },
  }));
  const txInsertMock = vi.fn((table: unknown) => ({
    values: (rows: unknown) => {
      state.inserted.push({ table, rows });
      const p = Promise.resolve() as Promise<unknown> & {
        onConflictDoUpdate?: (cfg: { set: Record<string, unknown> }) => Promise<unknown>;
      };
      p.onConflictDoUpdate = (cfg) => {
        state.conflictSets.push(cfg.set);
        return Promise.resolve();
      };
      return p;
    },
  }));
  const transactionMock = vi.fn((cb: (tx: unknown) => unknown) =>
    cb({ delete: txDeleteMock, insert: txInsertMock }),
  );

  return {
    state,
    selectMock: vi.fn(() => makeBuilder()),
    transactionMock,
    txDeleteMock,
    txInsertMock,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    transaction: H.transactionMock,
  },
}));

import {
  upsertWindowsUpdates,
  getComputerPatches,
  getFleetPatches,
} from "./patches";
import { appUpgrades, windowsHotfixes } from "./schema";

const ASSET = "0959927f-1046-4582-9a70-60a4175f206b";
const NOW = new Date("2026-10-19T16:00:00Z");

function lastInsertRows(): Record<string, unknown>[] {
  const last = H.state.inserted[H.state.inserted.length - 1];
  const rec = last as { rows: unknown };
  const rows = rec?.rows;
  return (Array.isArray(rows) ? rows : rows ? [rows] : []) as Record<
    string,
    unknown
  >[];
}

function insertsFor(table: unknown): Record<string, unknown>[] {
  return H.state.inserted
    .filter((i) => (i as { table: unknown }).table === table)
    .flatMap((i) => {
      const rows = (i as { rows: unknown }).rows;
      return (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
    });
}

beforeEach(() => {
  H.state.selectResults = [];
  H.state.inserted = [];
  H.state.txDeletes = [];
  H.state.conflictSets = [];
  vi.clearAllMocks();
});

describe("upsertWindowsUpdates", () => {
  it("replaces hotfixes, collapses duplicate ids, and nulls epoch dates", async () => {
    await upsertWindowsUpdates(
      ASSET,
      {
        pending_reboot: true,
        hotfixes: [
          {
            id: "KB5034441",
            description: "Security Update",
            installed_on: "2024-01-15",
          },
          {
            id: "KB5034441",
            description: "dup",
            installed_on: "2024-01-16",
          },
          { id: "KB1", description: "Update", installed_on: "1970-01-01" },
          { id: "  ", description: "blank" },
        ],
        winget_available: null,
      },
      NOW,
    );

    const rows = insertsFor(windowsHotfixes);
    expect(rows).toEqual([
      {
        assetId: ASSET,
        hotfixId: "KB5034441",
        description: "Security Update",
        installedOn: "2024-01-15",
      },
      {
        assetId: ASSET,
        hotfixId: "KB1",
        description: "Update",
        installedOn: null,
      },
    ]);
    expect(H.state.conflictSets[0]).toMatchObject({
      pendingReboot: true,
      hotfixCount: 2,
      collectedAt: NOW,
    });
    expect(H.state.conflictSets[0]).not.toHaveProperty("wingetAvailable");
  });

  it("replaces app upgrades when winget is available", async () => {
    await upsertWindowsUpdates(
      ASSET,
      {
        pending_reboot: false,
        hotfixes: [],
        winget_available: true,
        app_upgrades: [
          {
            id: "Google.Chrome",
            name: "Google Chrome",
            version: "128.0",
            available: "129.0",
            source: "winget",
          },
          { id: "Google.Chrome", name: "Chrome dup" },
          { id: "No.Name", name: "  " },
        ],
      },
      NOW,
    );

    const rows = insertsFor(appUpgrades);
    expect(rows).toEqual([
      {
        assetId: ASSET,
        packageId: "Google.Chrome",
        name: "Google Chrome",
        version: "128.0",
        available: "129.0",
        source: "winget",
      },
    ]);
    expect(H.state.conflictSets[0]).toMatchObject({
      wingetAvailable: true,
      appUpgradeCount: 1,
    });
  });

  it("records winget unavailable without deleting prior app rows (AC-8)", async () => {
    await upsertWindowsUpdates(
      ASSET,
      {
        pending_reboot: false,
        hotfixes: [{ id: "KB1" }],
        winget_available: false,
        app_upgrades: [],
      },
      NOW,
    );

    expect(insertsFor(appUpgrades)).toEqual([]);
    expect(H.state.txDeletes.includes(appUpgrades)).toBe(false);
    expect(H.state.conflictSets[0]).toMatchObject({
      wingetAvailable: false,
    });
    expect(H.state.conflictSets[0]).not.toHaveProperty("appUpgradeCount");
  });
});

describe("getComputerPatches", () => {
  it("returns null when this machine has never returned a hotfix collect", async () => {
    H.state.selectResults = [[]];
    await expect(getComputerPatches("PC1")).resolves.toBeNull();
  });

  it("shapes state, KBs, app upgrades, and last-update age", async () => {
    H.state.selectResults = [
      [
        {
          pendingReboot: true,
          hotfixCount: 1,
          wingetAvailable: true,
          wingetDetail: null,
          appUpgradeCount: 1,
          collectedAt: NOW,
          updatesLastDays: 9,
        },
      ],
      [
        {
          hotfixId: "KB5034441",
          description: "Security Update",
          installedOn: "2024-01-15",
        },
      ],
      [
        {
          packageId: "Google.Chrome",
          name: "Google Chrome",
          version: "128.0",
          available: "129.0",
          source: "winget",
        },
      ],
    ];
    const got = await getComputerPatches("PC1");
    expect(got).toMatchObject({
      pendingReboot: true,
      hotfixCount: 1,
      wingetAvailable: true,
      appUpgradeCount: 1,
      updatesLastDays: 9,
      hotfixes: [
        {
          hotfixId: "KB5034441",
          description: "Security Update",
          installedOn: "2024-01-15",
        },
      ],
      appUpgrades: [
        {
          packageId: "Google.Chrome",
          name: "Google Chrome",
          version: "128.0",
          available: "129.0",
          source: "winget",
        },
      ],
    });
    expect(got?.collectedAt).toBe(NOW.toISOString());
  });
});

describe("getFleetPatches", () => {
  it("returns every computer, including ones never collected", async () => {
    H.state.selectResults = [
      [
        {
          tag: "A",
          name: "Alpha",
          pendingReboot: true,
          hotfixCount: 3,
          wingetAvailable: false,
          appUpgradeCount: 0,
          collectedAt: NOW,
          updatesLastDays: 40,
        },
        {
          tag: "B",
          name: "Beta",
          pendingReboot: null,
          hotfixCount: null,
          wingetAvailable: null,
          appUpgradeCount: null,
          collectedAt: null,
          updatesLastDays: null,
        },
      ],
    ];
    const rows = await getFleetPatches();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      tag: "A",
      pendingReboot: true,
      updatesLastDays: 40,
      wingetAvailable: false,
    });
    expect(rows[1]).toMatchObject({
      tag: "B",
      collectedAt: null,
      hotfixCount: 0,
    });
  });
});
