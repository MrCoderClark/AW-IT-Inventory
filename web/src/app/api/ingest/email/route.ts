import { NextResponse } from "next/server";

import { processInboundEmail } from "@/db/ticket-email";
import { fetchReceivedEmail, verifyResendWebhook } from "@/lib/resend-inbound";

type InboundEvent = {
  type?: string;
  data?: {
    email_id?: string;
    message_id?: string;
    from?: string;
    subject?: string;
  };
};

/**
 * Resend inbound webhook (spec 33). Auth is the webhook signature, not a
 * service JWT. Ignored, duplicate, and commented replies are 200. A missing
 * received body or a processing failure is 500 so Resend retries. Attachment
 * bytes are never fetched.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  try {
    verifyResendWebhook(raw, req.headers);
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const event = JSON.parse(raw) as InboundEvent;
  if (event.type !== "email.received" || !event.data?.email_id) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  const emailId = event.data.email_id;
  const full = await fetchReceivedEmail(emailId);
  if (!full) {
    console.error("[ingest/email] fetch failed", emailId);
    return NextResponse.json({ error: "fetch failed" }, { status: 500 });
  }

  // Ignore attachment content — do not call the Resend attachments API.
  try {
    const result = await processInboundEmail({
      emailId,
      messageId: full.message_id || event.data.message_id || emailId,
      from: full.from || event.data.from || "",
      subject: full.subject || event.data.subject || "",
      text: full.text,
      html: full.html,
      headers: full.headers,
    });

    if (result.status === "ignored") {
      console.error("[ingest/email] ignored", result.reason, emailId);
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[ingest/email] process failed", err);
    return NextResponse.json({ error: "process failed" }, { status: 500 });
  }
}
