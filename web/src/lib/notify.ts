import "server-only";

import { AUTH_API_URL } from "./auth/config";
import type { EmailTable, ReportAttachment } from "./report-attachment";
import type { CounterReportRow } from "@/db/counters";
import type { AlertEvent } from "@/db/reachability";

/** One failed check named in a compliance at-risk email. */
export interface ComplianceAlertCheck {
  label: string;
  detail: string;
}
export interface ComplianceAlertPayload {
  computer: { name: string; tag: string };
  event: "at-risk" | "recovered";
  checks: ComplianceAlertCheck[];
}

/** A scheduled report delivery (spec 26 phase 2): the report metadata, a capped
   preview table for the email body, the full data as an attachment, and the
   explicit recipient addresses. */
export interface ReportEmailPayload {
  report: { name: string; description: string | null };
  table: EmailTable;
  recipients: string[];
  attachment: ReportAttachment;
}

/**
 * Printer-alert notifications (spec 12, milestone 3). Web owns the reachability
 * history, so it detects the up/down transition and asks aw-auth to email the
 * admins (aw-auth owns identity + the Resend credentials). This is the only
 * web -> aw-auth call in the app; it authenticates with the dedicated `h2tecs-web`
 * service account (client-credentials, `notify:send` scope, AC-7, AC-9).
 *
 * Every send here is best-effort: a failure is logged and swallowed so a Resend
 * or aw-auth outage never crashes the reachability pipeline. The transition
 * stays pending (its `lastAlertState` is only advanced on success), so the next
 * check retries it.
 */

const CLIENT_ID_ENV = "H2TECS_WEB_CLIENT_ID";
const CLIENT_SECRET_ENV = "H2TECS_WEB_CLIENT_SECRET";

let cachedToken: { value: string; exp: number } | null = null;

function jwtExp(token: string): number | null {
  try {
    const [, payload] = token.split(".");
    const json = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { exp?: number };
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

/** Fetch (and cache) a client-credentials access token for `h2tecs-web`. */
async function getServiceToken(): Promise<string | null> {
  const clientId = process.env[CLIENT_ID_ENV];
  const clientSecret = process.env[CLIENT_SECRET_ENV];
  if (!clientId || !clientSecret) {
    console.warn(
      `[notify] ${CLIENT_ID_ENV}/${CLIENT_SECRET_ENV} not set — skipping printer alert. ` +
        "Create the h2tecs-web service account (scope notify:send) and set both in web/.env.",
    );
    return null;
  }

  const now = Date.now() / 1000;
  if (cachedToken && now < cachedToken.exp - 60) return cachedToken.value;

  const res = await fetch(`${AUTH_API_URL}/v1/auth/token/client`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`token/client ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const token = (await res.json())?.access as string | undefined;
  if (!token) throw new Error("token response missing 'access'");
  cachedToken = { value: token, exp: jwtExp(token) ?? now + 240 };
  return token;
}

/**
 * Ask aw-auth to email the admins about one printer transition. Returns true
 * only when aw-auth accepted the request (so the caller may advance
 * `lastAlertState`); false on any failure (logged), leaving the alert to retry.
 */
export async function sendPrinterAlert(event: AlertEvent): Promise<boolean> {
  try {
    const token = await getServiceToken();
    if (!token) return false;

    const res = await fetch(`${AUTH_API_URL}/v1/notify/printer-alert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        printer: { name: event.name, ip: event.ip },
        event: event.event,
        since: event.since,
      }),
      cache: "no-store",
    });
    if (res.status === 401) {
      // Token may have gone stale mid-flight; drop the cache so the next attempt re-mints.
      cachedToken = null;
    }
    if (!res.ok) {
      console.error(
        `[notify] printer-alert ${res.status} for ${event.name} (${event.ip}): ` +
          `${(await res.text()).slice(0, 200)}`,
      );
      return false;
    }
    // aw-auth returns 200 with { sent } even when the underlying Resend send
    // failed. Treat only a real send as success, so a failed delivery leaves the
    // transition pending (lastAlertState not advanced) for the next check to
    // retry, instead of being silently dropped (AC-7 notify-failure path).
    const data = (await res.json().catch(() => null)) as { sent?: boolean } | null;
    if (data?.sent !== true) {
      console.error(
        `[notify] aw-auth accepted but did not deliver for ${event.name} ` +
          `(${event.ip}); leaving it to retry on the next check.`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[notify] printer-alert failed for ${event.name} (${event.ip}):`, err);
    return false;
  }
}

/**
 * Ask aw-auth to email the admins the daily printer page-counter report (spec 14,
 * AC-4, AC-7). Web assembles the per-printer rows (it holds the counter history)
 * and posts them; aw-auth resolves the admins and sends via Resend, the same
 * `h2tecs-web` service account (`notify:send`) and Resend path as the down alerts.
 * Returns true only when aw-auth actually delivered (keys on `sent`, not the
 * status code), so a failed send is reported rather than silently dropped.
 */
export async function sendCounterReportEmail(
  printers: CounterReportRow[],
): Promise<boolean> {
  try {
    const token = await getServiceToken();
    if (!token) return false;

    const res = await fetch(`${AUTH_API_URL}/v1/notify/printer-counter-report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ printers }),
      cache: "no-store",
    });
    if (res.status === 401) {
      cachedToken = null;
    }
    if (!res.ok) {
      console.error(
        `[notify] printer-counter-report ${res.status}: ` +
          `${(await res.text()).slice(0, 200)}`,
      );
      return false;
    }
    const data = (await res.json().catch(() => null)) as { sent?: boolean } | null;
    if (data?.sent !== true) {
      console.error(
        "[notify] aw-auth accepted the counter report but did not deliver it.",
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error("[notify] printer-counter-report failed:", err);
    return false;
  }
}

/**
 * Ask aw-auth to email a scheduled report to its recipients (spec 26 phase 2).
 * Web runs the report and builds the preview table + attachment; aw-auth renders
 * the HTML email and sends via Resend to the explicit recipient list (unlike the
 * other notify calls, which resolve the admins). Same `h2tecs-web` service account
 * (`notify:send`) and `sent`-keyed success contract. Returns true only on a real
 * delivery, so the caller can leave a failed send pending to retry.
 */
export async function sendReportEmail(
  payload: ReportEmailPayload,
): Promise<boolean> {
  const who = payload.report.name;
  try {
    const token = await getServiceToken();
    if (!token) return false;

    const res = await fetch(`${AUTH_API_URL}/v1/notify/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    if (res.status === 401) {
      cachedToken = null;
    }
    if (!res.ok) {
      console.error(
        `[notify] report "${who}" ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
      return false;
    }
    const data = (await res.json().catch(() => null)) as { sent?: boolean } | null;
    if (data?.sent !== true) {
      console.error(
        `[notify] aw-auth accepted but did not deliver the report "${who}".`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[notify] report delivery failed for "${who}":`, err);
    return false;
  }
}

/**
 * Ask aw-auth to email the admins about one compliance transition (spec 21 v2):
 * a computer going at-risk (a hard security check failed) or recovering. Web
 * detects the transition at ingest; aw-auth resolves the admins and sends via
 * Resend, the same `h2tecs-web` service account (`notify:send`) as the printer
 * alerts. Returns true only on a real send (keys on `sent`), but the caller treats
 * this as best-effort and non-gating — the in-app notification is the durable
 * record, so a failed email here is logged, not retried (which would re-fire the
 * in-app alert).
 */
export async function sendComplianceAlertEmail(
  payload: ComplianceAlertPayload,
): Promise<boolean> {
  const who = `${payload.computer.name} (${payload.event})`;
  try {
    const token = await getServiceToken();
    if (!token) return false;

    const res = await fetch(`${AUTH_API_URL}/v1/notify/compliance-alert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        computer: payload.computer,
        event: payload.event,
        checks: payload.checks,
      }),
      cache: "no-store",
    });
    if (res.status === 401) {
      cachedToken = null;
    }
    if (!res.ok) {
      console.error(
        `[notify] compliance-alert ${res.status} for ${who}: ` +
          `${(await res.text()).slice(0, 200)}`,
      );
      return false;
    }
    const data = (await res.json().catch(() => null)) as { sent?: boolean } | null;
    if (data?.sent !== true) {
      console.error(
        `[notify] aw-auth accepted but did not deliver the compliance alert for ${who}.`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[notify] compliance-alert failed for ${who}:`, err);
    return false;
  }
}

/** One metric-threshold fire/recover email (spec 30, AC-6). */
export interface AlertRuleEmailPayload {
  computer: { name: string; tag: string };
  event: "firing" | "recovered";
  rule: { name: string; condition: string; severity: string };
  value: string;
}

/**
 * Ask aw-auth to email the admins about one metric-threshold episode (spec 30,
 * AC-6): a rule firing or recovering. Web detects the transition at metric
 * ingest; aw-auth resolves the admins and sends via Resend, the same
 * `h2tecs-web` service account (`notify:send`) as printer/compliance. Returns
 * true only on a real send (keys on `sent`). The caller treats this as
 * best-effort and non-gating — the in-app notification is the durable record,
 * so a failed email is logged, not retried (which would re-fire the bell).
 */
export async function sendAlertRuleEmail(
  payload: AlertRuleEmailPayload,
): Promise<boolean> {
  const who = `${payload.computer.name} (${payload.rule.name} ${payload.event})`;
  try {
    const token = await getServiceToken();
    if (!token) return false;

    const res = await fetch(`${AUTH_API_URL}/v1/notify/alert-rule`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        computer: payload.computer,
        event: payload.event,
        rule: payload.rule,
        value: payload.value,
      }),
      cache: "no-store",
    });
    if (res.status === 401) {
      cachedToken = null;
    }
    if (!res.ok) {
      console.error(
        `[notify] alert-rule ${res.status} for ${who}: ` +
          `${(await res.text()).slice(0, 200)}`,
      );
      return false;
    }
    const data = (await res.json().catch(() => null)) as { sent?: boolean } | null;
    if (data?.sent !== true) {
      console.error(
        `[notify] aw-auth accepted but did not deliver the alert-rule email for ${who}.`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[notify] alert-rule failed for ${who}:`, err);
    return false;
  }
}
