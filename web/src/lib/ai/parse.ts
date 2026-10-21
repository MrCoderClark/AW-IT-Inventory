import type { AssistResult } from "./types";

/** Parse model JSON into AssistResult; tolerant of missing arrays. */
export function parseAssistResult(raw: string): AssistResult {
  let data: unknown;
  try {
    // Models sometimes wrap JSON in ``` fences.
    const trimmed = raw.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    data = JSON.parse(fenced ? fenced[1].trim() : trimmed);
  } catch {
    return {
      observed: [],
      hypotheses: [],
      recommendations: [
        "The model returned unparseable output. Try again or check AI_MODEL.",
      ],
    };
  }
  if (!data || typeof data !== "object") {
    return { observed: [], hypotheses: [], recommendations: [] };
  }
  const o = data as Record<string, unknown>;
  const result: AssistResult = {
    observed: asStringArray(o.observed),
    hypotheses: asStringArray(o.hypotheses),
    recommendations: asStringArray(o.recommendations),
  };
  const draft = o.scriptDraft;
  if (draft && typeof draft === "object") {
    const d = draft as Record<string, unknown>;
    const body = typeof d.body === "string" ? d.body : "";
    if (body.trim()) {
      result.scriptDraft = {
        body,
        name: typeof d.name === "string" ? d.name : undefined,
        notes: typeof d.notes === "string" ? d.notes : undefined,
      };
    }
  }
  const td = o.ticketDraft;
  if (td && typeof td === "object") {
    const d = td as Record<string, unknown>;
    const subject = typeof d.subject === "string" ? d.subject.trim() : "";
    const description =
      typeof d.description === "string" ? d.description.trim() : "";
    if (subject && description) {
      const priority =
        d.priority === "low" || d.priority === "medium" || d.priority === "high"
          ? d.priority
          : undefined;
      result.ticketDraft = {
        subject,
        description,
        category: typeof d.category === "string" ? d.category.trim() : undefined,
        priority,
      };
    }
  }
  return result;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean);
}
