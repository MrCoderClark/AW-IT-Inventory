import { NextResponse } from "next/server";

import { apiLogin } from "@/lib/auth/client";
import { setAuthCookies } from "@/lib/auth/cookies";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required." },
      { status: 400 },
    );
  }

  const tokens = await apiLogin(email, password);
  if (!tokens) {
    return NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 },
    );
  }

  await setAuthCookies(tokens.access, tokens.refresh);
  return NextResponse.json({ ok: true });
}
