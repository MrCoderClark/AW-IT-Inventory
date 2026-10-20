/**
 * AI assist config (spec 34). Pure — safe to import from tests / client for
 * `isAiConfigured` mirroring; the real gate for secrets stays server-side.
 */

export type AiProviderKind = "noop" | "openai_compatible";

export type AiConfig = {
  provider: AiProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

export function loadAiConfig(
  env: NodeJS.ProcessEnv = process.env,
): AiConfig {
  const raw = (env.AI_PROVIDER ?? "noop").trim().toLowerCase();
  const provider: AiProviderKind =
    raw === "openai_compatible" ? "openai_compatible" : "noop";
  const baseUrl = (env.AI_BASE_URL ?? "").trim().replace(/\/$/, "");
  const apiKey = (env.AI_API_KEY ?? "").trim();
  const model = (env.AI_MODEL ?? "").trim();
  const timeoutMs = Math.max(
    5_000,
    Number(env.AI_TIMEOUT_MS ?? 60_000) || 60_000,
  );

  if (provider === "openai_compatible" && (!baseUrl || !apiKey || !model)) {
    // Misconfigured → treat as off (fail closed for Assist UI).
    return {
      provider: "noop",
      baseUrl: "",
      apiKey: "",
      model: "",
      timeoutMs,
    };
  }

  return { provider, baseUrl, apiKey, model, timeoutMs };
}

export function isAiConfigured(cfg: AiConfig = loadAiConfig()): boolean {
  return cfg.provider !== "noop";
}
