/** Structured assist response (spec 34 AC-5). */

export type AssistAction =
  | "summarize_health"
  | "explain_failures"
  | "summarize_script_run"
  | "draft_script"
  | "draft_ticket";

export type AssistResult = {
  observed: string[];
  hypotheses: string[];
  recommendations: string[];
  scriptDraft?: {
    name?: string;
    body: string;
    notes?: string;
  };
  ticketDraft?: {
    subject: string;
    description: string;
    category?: string;
    priority?: "low" | "medium" | "high";
  };
};

export type AiCompleteRequest = {
  system: string;
  user: string;
  /** Hint for JSON shape; providers that support json_object use it. */
  jsonSchemaHint: string;
};

export interface AiProvider {
  readonly id: string;
  readonly model: string;
  complete(req: AiCompleteRequest): Promise<string>;
}
