import { createHash } from "crypto";

/** Strip likely secrets from free text before egress (spec 34 AC-8). */
const SECRET_PATTERNS: RegExp[] = [
  /(password|passwd|pwd|secret|api[_-]?key|token|bearer)\s*[:=]\s*\S+/gi,
  /authorization:\s*bearer\s+\S+/gi,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // JWT-ish
];

export function redactText(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (
        key.includes("password") ||
        key.includes("secret") ||
        key.includes("token") ||
        key === "apikey" ||
        key === "api_key"
      ) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out as T;
  }
  return value;
}

export function hashContext(pack: unknown): string {
  const json = JSON.stringify(pack);
  return createHash("sha256").update(json).digest("hex");
}
