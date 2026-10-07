import "server-only";

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { zipSync } from "fflate";
import { z } from "zod";

import type {
  PrinterInstallConnection,
  PrinterPackageSnapshot,
} from "@/db/schema";

/**
 * Driver package catalog (spec 20). Packages are a filesystem directory the admin
 * drops files into — there is no DB catalog table. Each package is a subfolder
 * whose name is its slug `id`, holding a `package.json` manifest plus the driver
 * files (incl. the INF). The web reads/validates the manifests to build the
 * catalog; a job freezes a snapshot of the chosen package so a later manifest
 * edit never changes a queued job.
 *
 * Integrity is a content hash of the package file tree (sorted relpath + bytes),
 * NOT the zip bytes — so the hash is stable regardless of how the bundle is
 * zipped, and the collector can re-verify after extraction.
 */

const DRIVERS_DIR = process.env.PRINTER_DRIVERS_DIR
  ? path.resolve(process.env.PRINTER_DRIVERS_DIR)
  : path.join(process.cwd(), "drivers");

// Slug guard: the only thing that turns a package id into a filesystem path, so
// it must be a single safe path segment (no slash, no dot — so no traversal).
// Mixed case is allowed (Windows folders are case-insensitive, and vendors ship
// folders like "Canon-imageFORCE-520").
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidPackageId(id: string): boolean {
  return SLUG_RE.test(id);
}

const connectionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tcpip"),
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("wsd"), host: z.string().optional() }),
  z.object({ type: z.literal("share"), sharePath: z.string().optional() }),
]);

const manifestSchema = z.object({
  // Optional: the package id is always the folder name (authoritative), so the
  // manifest never has to stay in sync with it.
  id: z.string().optional(),
  name: z.string().min(1),
  vendor: z.string().optional().default(""),
  model: z.string().optional().default(""),
  driverName: z.string().min(1),
  infPath: z.string().min(1),
  arch: z.string().optional().default("x64"),
  connection: connectionSchema.optional(),
  defaultPrinterName: z.string().optional(),
});

export interface PrinterPackage {
  id: string;
  name: string;
  vendor: string;
  model: string;
  driverName: string;
  infPath: string;
  arch: string;
  /** The manifest's default connection (tcpip @9100 when unspecified). */
  defaultConnection: PrinterInstallConnection;
  defaultPrinterName: string | null;
  /** Content hash of the package file tree. */
  sha256: string;
}

/** Recursively list files under `dir` as paths relative to it, forward-slashed. */
async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full, base)));
    } else if (e.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

/** Content hash over the sorted (relpath, bytes) of a package folder. */
async function hashTree(
  dir: string,
  relPaths: string[],
): Promise<{ sha256: string; files: Record<string, Uint8Array> }> {
  const hash = createHash("sha256");
  const files: Record<string, Uint8Array> = {};
  for (const rel of [...relPaths].sort()) {
    const bytes = await fs.readFile(path.join(dir, rel));
    hash.update(rel, "utf8");
    hash.update("\0");
    hash.update(bytes);
    files[rel] = new Uint8Array(bytes);
  }
  return { sha256: hash.digest("hex"), files };
}

function defaultConnection(
  c: z.infer<typeof connectionSchema> | undefined,
): PrinterInstallConnection {
  if (!c) return { type: "tcpip", host: "", port: 9100 };
  if (c.type === "tcpip") return { type: "tcpip", host: c.host ?? "", port: c.port ?? 9100 };
  if (c.type === "wsd") return { type: "wsd", host: c.host };
  return { type: "share", sharePath: c.sharePath ?? "" };
}

async function readPackage(id: string): Promise<PrinterPackage | null> {
  if (!isValidPackageId(id)) return null;
  const dir = path.join(DRIVERS_DIR, id);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
  } catch {
    return null; // no manifest → not a package
  }
  const parsed = manifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.warn(`[printer-packages] skipping ${id}: invalid manifest`);
    return null;
  }
  const m = parsed.data;
  // The INF must exist inside the package (and not escape it).
  const infAbs = path.resolve(dir, m.infPath);
  if (!infAbs.startsWith(dir + path.sep)) return null;
  const relPaths = await walk(dir);
  const { sha256 } = await hashTree(dir, relPaths);
  return {
    id,
    name: m.name,
    vendor: m.vendor,
    model: m.model,
    driverName: m.driverName,
    infPath: m.infPath,
    arch: m.arch,
    defaultConnection: defaultConnection(m.connection),
    defaultPrinterName: m.defaultPrinterName ?? null,
    sha256,
  };
}

/** Every valid package in the drivers dir (invalid ones are skipped). */
export async function listPrinterPackages(): Promise<PrinterPackage[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(DRIVERS_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // no drivers dir yet → empty catalog
  }
  const pkgs = await Promise.all(entries.map(readPackage));
  return pkgs
    .filter((p): p is PrinterPackage => p !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One package by slug, or null. */
export function getPrinterPackage(id: string): Promise<PrinterPackage | null> {
  return readPackage(id);
}

/** The snapshot frozen onto a job at enqueue. */
export function snapshotOf(pkg: PrinterPackage): PrinterPackageSnapshot {
  return {
    driverName: pkg.driverName,
    infPath: pkg.infPath,
    arch: pkg.arch,
    sha256: pkg.sha256,
  };
}

/**
 * Build the driver bundle for the collector to pull: a zip of the package folder
 * plus the content hash (which the collector re-verifies after extraction). The
 * hash is over the file tree, not the zip, so it matches the enqueue snapshot.
 */
export async function buildPackageBundle(
  id: string,
): Promise<{ zip: Uint8Array; sha256: string } | null> {
  if (!isValidPackageId(id)) return null;
  const dir = path.join(DRIVERS_DIR, id);
  let relPaths: string[];
  try {
    relPaths = await walk(dir);
  } catch {
    return null;
  }
  if (relPaths.length === 0) return null;
  const { sha256, files } = await hashTree(dir, relPaths);
  return { zip: zipSync(files), sha256 };
}
