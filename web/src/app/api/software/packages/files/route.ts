import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import {
  MAX_INSTALLER_BYTES,
  installerTypeFromName,
  isStorageConfigured,
  newInstallerKey,
  newPackageFileKey,
  putObject,
  sha256Hex,
} from "@/lib/storage";

// node:crypto + the AWS SDK need the Node.js runtime, not edge.
export const runtime = "nodejs";

/**
 * Upload one installer file for an `install` step (spec 23, AC-1). Multipart `file`
 * (MSI/EXE). Gated on `software:deploy`. Stores the bytes in the private object
 * store under a random key and returns the step's file metadata (key, sha256, size,
 * type); the caller holds it in the package editor and saves it as part of the
 * package's step list. The bytes are the install step's payload — the full package
 * is created separately via POST /api/software/packages.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "software:deploy"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  if (!isStorageConfigured())
    return NextResponse.json({ error: "storage not configured" }, { status: 503 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File))
    return NextResponse.json({ error: "no file uploaded" }, { status: 400 });

  // An `installer` file must be MSI/EXE (it's the one that runs). A `companion`
  // file (response .iss / transform .mst / config) can be any type — it's only
  // staged beside the installer, never executed.
  const role = form.get("role") === "companion" ? "companion" : "installer";
  const installerType = installerTypeFromName(file.name);
  if (role === "installer" && !installerType)
    return NextResponse.json(
      { error: "unsupported file type (.msi or .exe only)" },
      { status: 415 },
    );
  if (file.size > MAX_INSTALLER_BYTES)
    return NextResponse.json(
      { error: "file is larger than the upload limit" },
      { status: 413 },
    );

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength > MAX_INSTALLER_BYTES)
    return NextResponse.json(
      { error: "file is larger than the upload limit" },
      { status: 413 },
    );

  const id = randomUUID();
  const key =
    role === "installer" && installerType
      ? newInstallerKey(id, installerType)
      : newPackageFileKey(id, file.name);
  await putObject(key, bytes, file.type || "application/octet-stream");

  return NextResponse.json({
    ok: true,
    file: {
      storageKey: key,
      sha256: sha256Hex(bytes),
      fileSize: bytes.byteLength,
      fileName: file.name,
      installerType: installerType ?? null,
    },
  });
}
