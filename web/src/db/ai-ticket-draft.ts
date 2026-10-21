import "server-only";

import { isAiConfigured, loadAiConfig } from "@/lib/ai/config";
import { parseAssistResult } from "@/lib/ai/parse";
import { getAiProvider } from "@/lib/ai/providers";
import { isTicketCategory } from "@/lib/ticket-ui";

import { buildNotificationContextPack } from "./ai-context";

export type TicketDraftFields = {
  subject: string;
  description: string;
  category?: string;
  priority?: "low" | "medium" | "high";
};

const TICKET_JSON_HINT = `{
  "observed": string[],
  "hypotheses": string[],
  "recommendations": string[],
  "ticketDraft": {
    "subject": string,
    "description": string,
    "category"?: string,
    "priority"?: "low"|"medium"|"high"
  }
}
Rules: Write a clear IT ticket from the notification context. subject ≤ 120 chars.
category must be one of the fixed ticket categories when possible. Do not invent asset facts.`;

/**
 * Sync provider call. Null when AI is off, the notification is missing, or the
 * provider/parse step fails — never throws for an AI failure.
 *
 * `actorEmail` stays on the signature for the ticket action. Audit is skipped:
 * `recordAssistEvent` is not exported from `ai-assist.ts`.
 */
export async function draftTicketFieldsFromNotification(
  notificationId: string,
  actorEmail: string,
): Promise<TicketDraftFields | null> {
  void actorEmail;
  const cfg = loadAiConfig();
  if (!isAiConfigured(cfg)) return null;
  const pack = await buildNotificationContextPack(notificationId);
  if (!pack) return null;
  try {
    const provider = getAiProvider(cfg);
    const raw = await provider.complete({
      system: `You are an IT helpdesk assistant for H2Tecs. Draft one ticket from an alert notification. Never claim to have fixed anything.`,
      user: `Action: draft_ticket\n\nContext pack (JSON):\n${JSON.stringify(pack)}`,
      jsonSchemaHint: TICKET_JSON_HINT,
    });
    const parsed = parseAssistResult(raw).ticketDraft;
    if (!parsed) return null;
    const out: TicketDraftFields = {
      subject: parsed.subject.slice(0, 200),
      description: parsed.description,
    };
    if (parsed.category && isTicketCategory(parsed.category)) {
      out.category = parsed.category;
    }
    if (parsed.priority) out.priority = parsed.priority;
    return out;
  } catch {
    return null;
  }
}
