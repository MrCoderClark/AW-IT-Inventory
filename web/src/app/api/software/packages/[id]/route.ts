import { NextResponse } from "next/server";

import {
  softwarePackageExists,
  updateSoftwarePackage,
} from "@/db/software-packages";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { parseSteps } from "@/lib/software-package-steps";
import { removeObject } from "@/lib/storage";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * Edit a software package (spec 23): replace its header + ordered steps. Gated on
 * `software:deploy`. Files that are no longer referenced after the edit are removed
 * from the object store; past deployments keep running from their frozen snapshot.
 */
export async function PUT(req: Request, context: Context) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "software:deploy"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id } = await context.params;

  let body: Record<string, unknown> | null = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const version = typeof body?.version === "string" ? body.version.trim() : "";
  const publisher =
    typeof body?.publisher === "string" ? body.publisher.trim() : "";

  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!version)
    return NextResponse.json({ error: "version is required" }, { status: 400 });

  const parsed = parseSteps(body?.steps);
  if ("error" in parsed)
    return NextResponse.json({ error: parsed.error }, { status: 400 });

  if (await softwarePackageExists(name, version, id))
    return NextResponse.json(
      { error: `A different package named "${name}" ${version} already exists.` },
      { status: 409 },
    );

  const res = await updateSoftwarePackage(id, {
    name,
    version,
    publisher: publisher || null,
    steps: parsed.steps,
  });
  if (res.outcome === "notfound")
    return NextResponse.json({ error: "no such package" }, { status: 404 });

  // Reclaim files the edit dropped.
  await Promise.all(res.orphanKeys.map((k) => removeObject(k)));

  return NextResponse.json({ ok: true, id });
}
