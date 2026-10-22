import { Resend } from "resend";

const RECEIVING_URL = "https://api.resend.com/emails/receiving";

export type ReceivedEmail = {
  message_id: string;
  from: string;
  subject: string;
  text: string | null;
  html: string | null;
  headers?: Record<string, string>;
};

/**
 * Verify a Resend (Svix) webhook. Throws when the secret or signature
 * headers are missing, or when the signature does not match.
 */
export function verifyResendWebhook(payload: string, headers: Headers) {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error("RESEND_WEBHOOK_SECRET is not set");
  }

  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signature = headers.get("svix-signature");
  if (!id || !timestamp || !signature) {
    throw new Error("missing svix webhook headers");
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  return resend.webhooks.verify({
    payload,
    headers: { id, timestamp, signature },
    webhookSecret: secret,
  });
}

/**
 * Fetch a received email's body. Returns null when the key is unset or the
 * receiving API fails. The ingest route returns 500 on null so Resend retries.
 */
export async function fetchReceivedEmail(
  emailId: string,
): Promise<ReceivedEmail | null> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey || !emailId) return null;

  try {
    const response = await fetch(
      `${RECEIVING_URL}/${encodeURIComponent(emailId)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
    );
    if (!response.ok) return null;

    const data = (await response.json()) as {
      message_id?: unknown;
      from?: unknown;
      subject?: unknown;
      text?: unknown;
      html?: unknown;
      headers?: unknown;
    };

    const received: ReceivedEmail = {
      message_id: typeof data.message_id === "string" ? data.message_id : "",
      from: typeof data.from === "string" ? data.from : "",
      subject: typeof data.subject === "string" ? data.subject : "",
      text: typeof data.text === "string" ? data.text : null,
      html: typeof data.html === "string" ? data.html : null,
    };
    const headers = headerRecord(data.headers);
    if (headers) received.headers = headers;
    return received;
  } catch {
    return null;
  }
}

function headerRecord(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
