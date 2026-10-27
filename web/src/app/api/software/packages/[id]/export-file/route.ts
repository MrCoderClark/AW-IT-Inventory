import { NextResponse } from "next/server";

import { getSoftwarePackage } from "@/db/software-packages";
import type { SoftwareStep } from "@/db/schema";
import { attachmentContentDisposition } from "@/lib/content-disposition";
import { verifyExportFileSig } from "@/lib/software-export-sign";
import { getObjectBytes } from "@/lib/storage";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

function storageKeysInPackage(steps: SoftwareStep[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of steps) {
    if (s.kind !== "install") continue;
    map.set(s.storageKey, s.fileName);
    for (const c of s.companions ?? []) {
      map.set(c.storageKey, c.fileName);
    }
  }
  return map;
}

/**
 * Signed GET for break-glass export downloads (no session cookie). The HMAC is the
 * capability; TTL is enforced in `verifyExportFileSig`.
 */
export async function GET(request: Request, context: Context) {
  const { id: packageId } = await context.params;
  const url = new URL(request.url);
  const fileName = url.searchParams.get("fileName")?.trim() ?? "";
  const storageKey = url.searchParams.get("storageKey")?.trim() ?? "";
  const expRaw = url.searchParams.get("exp") ?? "";
  const sig = url.searchParams.get("sig")?.trim() ?? "";

  if (!fileName || !storageKey || !expRaw || !sig) {
    return NextResponse.json({ error: "missing signed parameters" }, { status: 401 });
  }

  const expUnix = Number(expRaw);
  if (!Number.isFinite(expUnix) || expUnix <= 0) {
    return NextResponse.json({ error: "invalid expiry" }, { status: 401 });
  }

  let sigOk = false;
  try {
    sigOk = verifyExportFileSig(
      packageId,
      fileName,
      storageKey,
      expUnix,
      sig,
    );
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return NextResponse.json({ error: "invalid or expired signature" }, { status: 403 });
  }

  const pkg = await getSoftwarePackage(packageId);
  if (!pkg)
    return NextResponse.json({ error: "no such package" }, { status: 404 });

  const keys = storageKeysInPackage(pkg.steps);
  const expectedName = keys.get(storageKey);
  if (!expectedName || expectedName !== fileName) {
    return NextResponse.json({ error: "file not in package" }, { status: 404 });
  }

  const obj = await getObjectBytes(storageKey);
  if (!obj)
    return NextResponse.json({ error: "file bytes missing" }, { status: 404 });

  return new NextResponse(Buffer.from(obj.bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": attachmentContentDisposition(fileName),
      "Content-Length": String(obj.bytes.byteLength),
    },
  });
}
