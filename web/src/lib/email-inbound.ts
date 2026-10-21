const TICKET_SUBJECT_RE = /\[#(\d+)\]/;
const ON_WROTE_RE = /^On .+ wrote:$/m;
const MAX_REPLY_BODY_CHARS = 8000;

export function parseTicketNumberFromSubject(subject: string): number | null {
  const match = subject.match(TICKET_SUBJECT_RE);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

export function normalizeEmailAddress(from: string): string {
  const angle = from.match(/<([^>]+)>/);
  const email = angle ? angle[1] : from;
  return email.trim().toLowerCase();
}

function quotedReplyCutIndex(text: string): number {
  let cut = text.length;

  const onWrote = ON_WROTE_RE.exec(text);
  if (onWrote?.index !== undefined) {
    cut = Math.min(cut, onWrote.index);
  }

  const lines = text.split("\n");
  let offset = 0;
  for (const line of lines) {
    if (line.startsWith(">")) {
      cut = Math.min(cut, offset);
      break;
    }
    offset += line.length + 1;
  }

  return cut;
}

export function stripQuotedReply(text: string): string {
  const cut = quotedReplyCutIndex(text);
  const stripped = text.slice(0, cut).trim();
  if (stripped.length <= MAX_REPLY_BODY_CHARS) return stripped;
  return stripped.slice(0, MAX_REPLY_BODY_CHARS);
}

export function extractInReplyTo(
  headers: Record<string, string> | undefined,
): string | null {
  if (!headers) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "in-reply-to") return value;
  }
  return null;
}
