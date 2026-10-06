import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the ingest reconcile + scan-to-asset enrichment. The DB client and the
 * counter/software side-writes are mocked; the logic under test is matching a scan to
 * an asset (by serial) and overwriting the asset's technical fields from the scan
 * (user-chosen "scan is authoritative"): serial/model/vendor on the asset, and
 * cpu/ram/os/storage on computer_details — only for fields the scan actually returned.
 */

const H = vi.hoisted(() => {
  const state: {
    selectResults: unknown[][];
    updates: { table: unknown; set: Record<string, unknown> }[];
    inserts: { table: unknown; values: Record<string, unknown>; conflictSet: Record<string, unknown> | null }[];
    deletes: { table: unknown }[];
  } = { selectResults: [], updates: [], inserts: [], deletes: [] };

  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    for (const m of ["from", "leftJoin", "where", "limit"]) b[m] = () => b;
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(state.selectResults.shift() ?? []).then(res, rej);
    return b;
  };
  const selectMock = vi.fn(() => makeSelect());
  const updateMock = vi.fn((table: unknown) => ({
    set: (obj: Record<string, unknown>) => {
      state.updates.push({ table, set: obj });
      return { where: () => Promise.resolve() };
    },
  }));
  const insertMock = vi.fn((table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      const rec = { table, values, conflictSet: null as Record<string, unknown> | null };
      state.inserts.push(rec);
      const p = Promise.resolve() as Promise<unknown> & {
        onConflictDoUpdate?: (cfg: { set: Record<string, unknown> }) => unknown;
      };
      p.onConflictDoUpdate = (cfg) => {
        rec.conflictSet = cfg.set;
        // Awaitable AND chainable with .returning() (the machines upsert uses it).
        const q = Promise.resolve() as Promise<unknown> & {
          returning?: () => Promise<unknown>;
        };
        q.returning = () => Promise.resolve([{ id: "machine-test-id" }]);
        return q;
      };
      return p;
    },
  }));

  const deleteMock = vi.fn((table: unknown) => ({
    where: () => {
      state.deletes.push({ table });
      return Promise.resolve();
    },
  }));

  return { state, selectMock, updateMock, insertMock, deleteMock };
});

vi.mock("@/db/index", () => ({
  db: {
    select: H.selectMock,
    update: H.updateMock,
    insert: H.insertMock,
    delete: H.deleteMock,
  },
}));
vi.mock("./counters", () => ({ upsertPrinterCounter: vi.fn() }));
vi.mock("./software", () => ({ replaceInstalledSoftware: vi.fn() }));
vi.mock("./notifications", () => ({ createNotification: vi.fn(async () => null) }));

import { ingestScan } from "./ingest";
import { assets, computerDetails, machines } from "./schema";

beforeEach(() => {
  H.state.selectResults = [];
  H.state.updates = [];
  H.state.inserts = [];
  H.state.deletes = [];
  vi.clearAllMocks();
});

const computerHost = {
  ip: "192.168.70.7",
  device_type: "windows",
  hostname: "PC1",
  hardware: {
    serial: "SN123",
    manufacturer: "Dell Inc.",
    model: "Latitude 5520",
    cpu: "Intel i7-1185G7",
    ram_gb: 31.9,
    disks: [{ size_gb: 476.9 }, { size_gb: 931 }],
  },
  health: { os_name: "Microsoft Windows 11 Pro", os_version: "10.0.22631" },
};

describe("ingestScan — scan overwrites asset fields", () => {
  it("overwrites serial/model/vendor on a matched computer asset", async () => {
    H.state.selectResults = [[{ id: "a1", type: "Computer" }]]; // serial match
    const res = await ingestScan({ hosts: [computerHost] });
    expect(res.matched).toBe(1);

    const assetUpdate = H.state.updates.find(
      (u) => u.table === assets && u.set.serial !== undefined,
    );
    expect(assetUpdate?.set).toMatchObject({
      serial: "SN123",
      model: "Latitude 5520",
      vendor: "Dell Inc.",
    });
  });

  it("writes cpu/ram/os/storage to computer_details (ram rounded, disks summarized)", async () => {
    H.state.selectResults = [[{ id: "a1", type: "Computer" }]];
    await ingestScan({ hosts: [computerHost] });

    const cd = H.state.inserts.find((i) => i.table === computerDetails);
    expect(cd?.values).toMatchObject({
      assetId: "a1",
      cpu: "Intel i7-1185G7",
      ramGb: 32,
      operatingSystem: "Microsoft Windows 11 Pro 10.0.22631",
      storage: "477 GB + 931 GB",
    });
    // Same values applied on conflict (existing detail row).
    expect(cd?.conflictSet).toMatchObject({ cpu: "Intel i7-1185G7", ramGb: 32 });
  });

  it("does not enrich an unmatched (discovered) host", async () => {
    H.state.selectResults = [[], []]; // serial miss, ip miss
    const res = await ingestScan({ hosts: [computerHost] });
    expect(res.discovered).toBe(1);
    expect(res.matched).toBe(0);
    // No asset update and no computer_details write happened.
    expect(H.state.updates.some((u) => u.table === assets)).toBe(false);
    expect(H.state.inserts.some((i) => i.table === computerDetails)).toBe(false);
  });

  it("never blanks a field the scan didn't return", async () => {
    H.state.selectResults = [[{ id: "a1", type: "Computer" }]];
    // A scan that read almost nothing (serial only): model/vendor/cpu absent.
    await ingestScan({
      hosts: [{ ip: "192.168.70.7", device_type: "windows", hardware: { serial: "SN123" } }],
    });
    const assetUpdate = H.state.updates.find(
      (u) => u.table === assets && u.set.serial !== undefined,
    );
    expect(assetUpdate?.set).toMatchObject({ serial: "SN123" });
    expect(assetUpdate?.set).not.toHaveProperty("model");
    expect(assetUpdate?.set).not.toHaveProperty("vendor");
    // No computer_details write when no detail fields were read.
    expect(H.state.inserts.some((i) => i.table === computerDetails)).toBe(false);
  });
});

describe("ingestScan — orphan shadow-row cleanup", () => {
  it("deletes the weak-keyed shadow when a scan keys the device by a strong id", async () => {
    // Serial match → strong matchKey "SN123"; ip/hostname are the weak keys to reap.
    H.state.selectResults = [[{ id: "a1", type: "Computer" }]];
    await ingestScan({ hosts: [computerHost] });
    expect(H.state.deletes.some((d) => d.table === machines)).toBe(true);
  });

  it("does not clean up when the scan only has a weak id (no hardware id read)", async () => {
    // No hardware/serial → matchKey falls back to hostname; nothing to reap.
    H.state.selectResults = [[]]; // ip lookup miss → discovered
    await ingestScan({
      hosts: [
        {
          ip: "192.168.70.9",
          hostname: "PCX",
          device_type: "windows",
          errors: ["winrm auth failed"],
        },
      ],
    });
    expect(H.state.deletes.length).toBe(0);
  });
});
