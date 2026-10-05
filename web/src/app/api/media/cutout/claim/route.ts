import { NextResponse } from "next/server";

import { claimCutoutJob } from "@/db/media";
import { bearerFrom, verifyServiceToken } from "@/lib/auth/service";
import { getImageBytes, isStorageConfigured } from "@/lib/storage";

// node:buffer + the AWS SDK need the Node.js runtime, not edge.
export const runtime = "nodejs";

/**
 * The rembg worker polls this to claim one pending background-removal job (spec 18
 * phase 3). It returns the original image bytes inline (base64) so the outbound-only
 * worker never needs S3 credentials — the web app stays the only thing touching
 * storage. Service `scan:dequeue` only. 204 when the queue is empty.
 */
export async function POST(request: Request) {
  const token = bearerFrom(request.headers.get("authorization"));
  if (!token)
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });

  const identity = await verifyServiceToken(token, "scan:dequeue");
  if (!identity)
    return NextResponse.json(
      { error: "invalid token or missing scan:dequeue scope" },
      { status: 403 },
    );

  let body: { workerId?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const workerId = typeof body?.workerId === "string" ? body.workerId.trim() : "";
  if (!workerId)
    return NextResponse.json({ error: "workerId is required" }, { status: 400 });

  if (!isStorageConfigured())
    return NextResponse.json({ error: "storage not configured" }, { status: 503 });

  const job = await claimCutoutJob(workerId);
  if (!job) return new NextResponse(null, { status: 204 });

  const obj = await getImageBytes(job.objectKey);
  if (!obj) {
    // The original is gone — nothing to process; report it so the worker fails it.
    return NextResponse.json(
      { mediaId: job.mediaId, error: "original image missing" },
      { status: 200 },
    );
  }

  return NextResponse.json({
    mediaId: job.mediaId,
    contentType: obj.contentType,
    imageB64: Buffer.from(obj.bytes).toString("base64"),
  });
}
