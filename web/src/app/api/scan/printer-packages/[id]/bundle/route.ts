import { NextResponse } from "next/server";

import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";
import { buildPackageBundle, isValidPackageId } from "@/lib/printer-packages";

// Reads the filesystem (drivers dir) + zips — Node runtime, never the edge.
export const runtime = "nodejs";

/**
 * The collector pulls a driver package's bundle here (spec 20): a zip of the
 * package folder plus the content hash in `x-bundle-sha256`, which the worker
 * re-verifies against the job's frozen snapshot before touching the target.
 * Requires a `scan:dequeue` service token.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const token = bearerFrom(request.headers.get("authorization"));
  if (!token) {
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  }

  const identity = await verifyServiceToken(token, "scan:dequeue");
  if (!identity) {
    return NextResponse.json(
      { error: "invalid token or missing scan:dequeue scope" },
      { status: 403 },
    );
  }

  const { id } = await context.params;
  if (!isValidPackageId(id)) {
    return NextResponse.json({ error: "invalid package id" }, { status: 400 });
  }

  const bundle = await buildPackageBundle(id);
  if (!bundle) {
    return NextResponse.json({ error: "package not found" }, { status: 404 });
  }

  // Uint8Array → a fresh ArrayBuffer-backed body for the Response.
  const body = new Uint8Array(bundle.zip);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${id}.zip"`,
      "x-bundle-sha256": bundle.sha256,
      "Cache-Control": "no-store",
    },
  });
}
