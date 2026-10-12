import { NextResponse } from "next/server";

import {
  createSoftwarePackage,
  softwarePackageExists,
} from "@/db/software-packages";
import { getCurrentUser, hasPermission } from "@/lib/auth/session";
import { parseSteps } from "@/lib/software-package-steps";

export const runtime = "nodejs";

/**
 * Create a software package (spec 23, AC-1): a header (name/version/publisher) plus
 * an ordered list of steps — `script` (inline PowerShell) and `install` (an MSI/EXE
 * uploaded first via POST /api/software/packages/files). Gated on `software:deploy`.
 */

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasPermission(user, "software:deploy"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

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

  if (await softwarePackageExists(name, version))
    return NextResponse.json(
      { error: `A package named "${name}" ${version} already exists.` },
      { status: 409 },
    );

  const id = await createSoftwarePackage({
    name,
    version,
    publisher: publisher || null,
    steps: parsed.steps,
    uploadedBy: user.email,
  });

  return NextResponse.json({ ok: true, id });
}
