import { z } from "zod";

import type { TicketPriority, TicketStatus } from "@/lib/data";
import { TICKET_CATEGORIES } from "@/lib/ticket-ui";

const TICKET_STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "closed",
] as const satisfies readonly TicketStatus[];

const TICKET_PRIORITIES = [
  "low",
  "medium",
  "high",
] as const satisfies readonly TicketPriority[];

const ticketCategorySchema = z.enum(TICKET_CATEGORIES);

export const createTicketInputSchema = z.object({
  subject: z.string().trim().min(1, "Enter a subject."),
  description: z.string().optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  category: ticketCategorySchema.optional(),
  assigneeEmail: z.string().email().nullable().optional(),
  requesterEmail: z.string().email().nullable().optional(),
  assetId: z.string().uuid().nullable().optional(),
});

export const updateTicketPatchSchema = z
  .object({
    subject: z.string().trim().min(1, "Enter a subject.").optional(),
    description: z.string().optional(),
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    category: ticketCategorySchema.optional(),
    assigneeEmail: z.string().email().nullable().optional(),
    requesterEmail: z.string().email().nullable().optional(),
    assetId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Nothing to update.",
  });

export const addTicketCommentInputSchema = z.object({
  body: z.string().trim().min(1, "Enter a comment."),
});

/** The first error message from a failed parse, for an ActionResult. */
export function firstTicketError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid input.";
}
