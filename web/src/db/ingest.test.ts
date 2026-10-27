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
    assignCalls: unknown[][];
  } = { selectResults: [], updates: [], inserts: [], deletes: [], assignCalls: [] };

  const makeSelect = () => {
    const b: Record<string, unknown> = {};
    for (const m of ["from", "leftJoin", "innerJoin", "where", "limit"]) b[m] = () => b;
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
vi.mock("./compliance", () => ({ upsertComplianceStatus: vi.fn() }));
vi.mock("./patches", () => ({ upsertWindowsUpdates: vi.fn() }));
vi.mock("./notifications", () => ({ createNotification: vi.fn(async () => null) }));
vi.mock("./assignments", () => ({
  assignAsset: vi.fn((...args: unknown[]) => {
    H.state.assignCalls.push(args);
    return Promise.resolve({ ok: true });
  }),
}));

import { ingestScan } from "./ingest";
import { assets, computerDetails, machines, phoneDetails } from "./schema";

beforeEach(() => {
  H.state.selectResults = [];
  H.state.updates = [];
  H.state.inserts = [];
  H.state.deletes = [];
  H.state.assignCalls = [];
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

const phoneHost = {
  ip: "192.168.75.62",
  device_type: "phone",
  phone: {
    mac: "80:5E:0C:03:43:23",
    model: "Yealink T54W",
    extension: "117",
  },
};

describe("ingestScan — desk phones (spec 27)", () => {
  it("reconciles a phone by MAC and writes phone_details + model", async () => {
    // No serial select for a phone; the first select is the MAC match.
    H.state.selectResults = [[{ id: "p1", type: "Phone" }]];
    const res = await ingestScan({ hosts: [phoneHost] });
    expect(res.matched).toBe(1);

    const pd = H.state.inserts.find((i) => i.table === phoneDetails);
    expect(pd?.values).toMatchObject({
      assetId: "p1",
      mac: "80:5E:0C:03:43:23",
      extension: "117",
      ipAddress: "192.168.75.62",
    });
    // The model rides the shared asset fields.
    const assetUpdate = H.state.updates.find(
      (u) => u.table === assets && u.set.model !== undefined,
    );
    expect(assetUpdate?.set).toMatchObject({ model: "Yealink T54W" });
  });

  it("links a manually-added phone (no MAC yet) by its IP, then fills in the MAC", async () => {
    // MAC miss (the asset has no MAC yet), then the IP fallback finds the asset.
    H.state.selectResults = [[], [{ id: "p1", type: "Phone" }]];
    const res = await ingestScan({ hosts: [phoneHost] });
    expect(res.matched).toBe(1);

    const pd = H.state.inserts.find((i) => i.table === phoneDetails);
    expect(pd?.values).toMatchObject({ assetId: "p1", mac: "80:5E:0C:03:43:23" });
  });

  it("leaves an unmatched phone as a discovered row carrying its phone data", async () => {
    H.state.selectResults = [[], []]; // MAC miss, IP miss
    const res = await ingestScan({ hosts: [phoneHost] });
    expect(res.discovered).toBe(1);
    expect(res.matched).toBe(0);
    // No phone_details write without a matched asset…
    expect(H.state.inserts.some((i) => i.table === phoneDetails)).toBe(false);
    // …but the machines (inbox) row carries the phone identity + kind.
    const m = H.state.inserts.find((i) => i.table === machines);
    expect(m?.values).toMatchObject({ kind: "phone", matchKey: "80:5E:0C:03:43:23" });
    expect(m?.values.phone).toMatchObject({ mac: "80:5E:0C:03:43:23" });
  });

  it("persists phase-2 enrichment: vendor+serial on the asset, firmware/display_name/register on phone_details", async () => {
    // Phase-2 adds vendor ("Yealink"), serial (Yealink Machine ID), firmware,
    // display_name (SIP display), register_status. The first select is now
    // the serial match (phone?.serial raised the asset serial to a strong key)
    // which hits before the MAC fallback.
    H.state.selectResults = [[{ id: "p1", type: "Phone" }]];
    const enrichedPhone = {
      ip: "192.168.75.62",
      device_type: "phone",
      phone: {
        mac: "80:5E:0C:03:43:23",
        model: "T54W",
        vendor: "Yealink",
        serial: "301081C101210254",
        extension: "117",
        display_name: "Joseph Clark",
        firmware: "96.86.107.8",
        register_status: "Registered",
      },
    };
    const res = await ingestScan({ hosts: [enrichedPhone] });
    expect(res.matched).toBe(1);

    // Shared asset fields (serial / model / vendor) all take the phone's values.
    const assetUpdate = H.state.updates.find(
      (u) => u.table === assets && u.set.serial !== undefined,
    );
    expect(assetUpdate?.set).toMatchObject({
      serial: "301081C101210254",
      model: "T54W",
      vendor: "Yealink",
    });

    // phone_details carries every phase-2 field (plus the phase-1 mac + ip).
    const pd = H.state.inserts.find((i) => i.table === phoneDetails);
    expect(pd?.values).toMatchObject({
      assetId: "p1",
      mac: "80:5E:0C:03:43:23",
      extension: "117",
      ipAddress: "192.168.75.62",
      firmware: "96.86.107.8",
      registerStatus: "Registered",
      displayName: "Joseph Clark",
    });
  });

  it("assigns an unassigned phone to the unique People match for the SIP display name", async () => {
    H.state.selectResults = [
      [{ id: "p1", type: "Phone" }], // serial match
      [], // existing machines row by matchKey
      [{ assigneeId: null, type: "Phone" }], // currently unassigned
      [{ id: "person-nya" }], // unique active person named Nya Fauntleroy
    ];
    const res = await ingestScan({
      hosts: [
        {
          ip: "192.168.75.41",
          device_type: "phone",
          phone: {
            mac: "00:15:65:00:00:41",
            display_name: "Nya Fauntleroy",
            serial: "SERIAL41",
          },
        },
      ],
    });
    expect(res.matched).toBe(1);
    expect(H.state.assignCalls).toEqual([
      ["p1", "person-nya", "collector"],
    ]);
  });

  it("does not reassign a phone that already has an Assigned To", async () => {
    H.state.selectResults = [
      [{ id: "p1", type: "Phone" }],
      [], // existing machines row
      [{ assigneeId: "already-held", type: "Phone" }],
    ];
    await ingestScan({
      hosts: [
        {
          ip: "192.168.75.41",
          device_type: "phone",
          phone: {
            mac: "00:15:65:00:00:41",
            display_name: "Nya Fauntleroy",
            serial: "SERIAL41",
          },
        },
      ],
    });
    expect(H.state.assignCalls).toEqual([]);
  });

  it("does not assign when two people share the SIP display name", async () => {
    H.state.selectResults = [
      [{ id: "p1", type: "Phone" }],
      [], // existing machines row
      [{ assigneeId: null, type: "Phone" }],
      [{ id: "person-a" }, { id: "person-b" }],
    ];
    await ingestScan({
      hosts: [
        {
          ip: "192.168.75.41",
          device_type: "phone",
          phone: {
            mac: "00:15:65:00:00:41",
            display_name: "John Smith",
            serial: "SERIAL41",
          },
        },
      ],
    });
    expect(H.state.assignCalls).toEqual([]);
  });
});

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

describe("ingestScan — partial collect must not blank prior machine fields", () => {
  it("keeps hostname/OS/hardware when CIM returns an empty shell", async () => {
    H.state.selectResults = [
      [{ id: "a1", type: "Computer" }], // IP match (no serial on this host)
      [
        {
          id: "m1",
          assetId: "a1",
          hostname: "DESKTOP-GOOD",
          ip: "192.168.70.16",
          subnet: "192.168.70.0/24",
          serial: "OLD-SN",
          hardwareUuid: "uuid-old",
          osName: "Microsoft Windows 10 Pro",
          osVersion: "10.0.19045",
          osBuild: "19045",
          hardware: { serial: "OLD-SN", model: "OptiPlex", ram_gb: 16 },
          health: { os_name: "Microsoft Windows 10 Pro", uptime_hours: 12 },
          printer: null,
          phone: null,
          credentialProfile: "win10-infotech",
        },
      ],
    ];
    await ingestScan({
      hosts: [
        {
          ip: "192.168.70.16",
          device_type: "windows",
          hostname: null,
          hardware: {
            manufacturer: null,
            model: null,
            serial: null,
            ram_gb: 0,
            disks: [],
          },
          health: {
            os_name: null,
            os_version: null,
            network_adapters: [{ name: "Ethernet", mac: "50-9A-4C-4B-E8-96" }],
            logged_on_users: ["mjohnson"],
          },
          credential_profile: "win10-infotech",
        },
      ],
    });

    const m = H.state.inserts.find((i) => i.table === machines);
    expect(m?.conflictSet).toMatchObject({
      hostname: "DESKTOP-GOOD",
      serial: "OLD-SN",
      osName: "Microsoft Windows 10 Pro",
      osVersion: "10.0.19045",
      hardware: { serial: "OLD-SN", model: "OptiPlex", ram_gb: 16 },
    });
    expect(m?.conflictSet?.health).toMatchObject({
      os_name: "Microsoft Windows 10 Pro",
      uptime_hours: 12,
      network_adapters: [{ name: "Ethernet", mac: "50-9A-4C-4B-E8-96" }],
      logged_on_users: ["mjohnson"],
    });
  });
});
