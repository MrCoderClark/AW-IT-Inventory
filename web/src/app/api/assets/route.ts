import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getAssets } from "@/db/queries";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const assets = await getAssets();
  return NextResponse.json(assets);
}
