import { NextResponse } from "next/server";

import { getDeployment } from "@/db/software-deploy";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";
import { getObjectBytes } from "@/lib/storage";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; stepId: string }> };

/**
 * The collector worker pulls one install step's installer bytes (spec 23, AC-4).
 * The object key is resolved from the claimed deployment's FROZEN snapshot (so the
 * worker can only fetch files belonging to its own claimed job), fenced by
 * `workerId` + `claimedAt`. Service `deploy:agent`.
 */
export async function GET(request: Request, context: Context) {
  const token = bearerFrom(request.headers.get("authorization"));
  if (!token)
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  const identity = await verifyServiceToken(token, "deploy:agent");
  if (!identity)
    return NextResponse.json(
      { error: "invalid token or missing deploy:agent scope" },
      { status: 403 },
    );

  const { id, stepId } = await context.params;
  const url = new URL(request.url);
  const workerId = url.searchParams.get("workerId") ?? "";
  const claimedAt = url.searchParams.get("claimedAt") ?? "";

  const dep = await getDeployment(id);
  if (!dep)
    return NextResponse.json({ error: "no such deployment" }, { status: 404 });
  // Fence: only the worker that holds this claim may pull its files.
  if (
    dep.workerId !== workerId ||
    (dep.claimedAt ? dep.claimedAt.toISOString() : null) !== claimedAt
  )
    return NextResponse.json({ error: "stale claim" }, { status: 409 });

  const step = dep.packageSnapshot.steps.find(
    (s) => s.id === stepId && s.kind === "install",
  );
  if (!step || step.kind !== "install")
    return NextResponse.json({ error: "no such install step" }, { status: 404 });

  // The step's files: the installer plus any companions. `?file=` selects one by
  // name (resolved only from the frozen snapshot); absent → the installer.
  const want = url.searchParams.get("file");
  const files = [
    { fileName: step.fileName, storageKey: step.storageKey },
    ...(step.companions ?? []).map((c) => ({
      fileName: c.fileName,
      storageKey: c.storageKey,
    })),
  ];
  const picked = want ? files.find((f) => f.fileName === want) : files[0];
  if (!picked)
    return NextResponse.json({ error: "no such file in step" }, { status: 404 });

  const obj = await getObjectBytes(picked.storageKey);
  if (!obj)
    return NextResponse.json({ error: "file bytes missing" }, { status: 404 });

  return new NextResponse(Buffer.from(obj.bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${picked.fileName}"`,
      "Content-Length": String(obj.bytes.byteLength),
    },
  });
}
